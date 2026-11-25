package main

import (
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A main PC that is our own: answers after `slow`, drops every answer while `drop` says so.
func slowMain(t *testing.T, slow time.Duration, drop func() bool) (*httptest.Server, *int32) {
	var asked int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&asked, 1)
		if drop != nil && drop() {
			if h, ok := w.(http.Hijacker); ok {
				if c, _, err := h.Hijack(); err == nil {
					c.Close()
					return
				}
			}
		}
		time.Sleep(slow)
		switch r.URL.Path {
		case "/api/health":
			fmt.Fprint(w, `{"status":"ok","role":"main","instance":"i1"}`)
		case "/api/pc-access/check-number":
			fmt.Fprint(w, `{"ok":true}`)
		case "/api/companion/info":
			fmt.Fprint(w, `{"service":"adal-keep"}`)
		}
	}))
	t.Cleanup(ts.Close)
	return ts, &asked
}

// (Test servers are on 127.0.0.1, which realMainAt never takes: the look itself, without that rule.)
func lookAt(u string) mainState {
	if h := healthOf(u, 2*time.Second); h != nil {
		return mainUp
	}
	if wasBusy(u) && portOpens(u) {
		return mainSlow
	}
	return mainGone
}

// A main PC that answers after 5 s: it is there. One that drops the answer: there, slow. Off: gone.
func TestSlowIsNotGone(t *testing.T) {
	s5, _ := slowMain(t, 5*time.Second, nil)
	if st := lookAt(s5.URL); st != mainUp {
		t.Fatalf("after 5 s: %v (it was 'gone' after 2 s before)", st)
	}
	d, _ := slowMain(t, 0, func() bool { return true })
	if st := lookAt(d.URL); st != mainSlow {
		t.Fatalf("a dropped answer: %v", st)
	}
	u := d.URL
	d.Close()
	if st := lookAt(u); st != mainGone {
		t.Fatalf("switched off: %v", st)
	}
}

// Eight hours of a main PC that answers after 5 s and drops 20 %: the window never moves.
// (Before: one late answer was enough to count as gone.)
func TestWindowStaysPutOnASlowMainPC(t *testing.T) {
	for seed := int64(0); seed < 50; seed++ {
		rnd := rand.New(rand.NewSource(seed))
		var w windowSteps
		now := time.Now()
		for i := 0; i < 8*360/2; i++ { // each look: 10 s pause + up to 10 s
			st := mainUp
			if rnd.Intn(100) < 20 {
				st = mainSlow
			}
			if w.step(now, st) {
				t.Fatalf("seed %d: the window left the main PC after %d looks", seed, i)
			}
			now = now.Add(15 * time.Second)
		}
	}
}

// One look with a closed port (a main PC starting again after an update, 30 s) moves nothing;
// off for real: the window moves after 45 s and 4 tries; back only after it answered for 20 s.
func TestWindowMovesOnlyWhenTheMainPCIsReallyGone(t *testing.T) {
	var w windowSteps
	now := time.Now()
	at := func(st mainState, after time.Duration) bool { now = now.Add(after); return w.step(now, st) }
	for i := 0; i < 3; i++ {
		if at(mainGone, 10*time.Second) {
			t.Fatal("30 s (a restart) moved the window")
		}
	}
	at(mainUp, 10*time.Second)
	for i := 0; i < 4; i++ {
		if at(mainGone, 10*time.Second) {
			t.Fatal("30 s after the first failed look")
		}
	}
	at(mainGone, 10*time.Second)
	if !at(mainGone, 10*time.Second) {
		t.Fatal("gone for 50 s: the window works on this PC's copy")
	}
	// One good answer between bad ones does not bring it back (no flapping).
	if !at(mainUp, 10*time.Second) || !at(mainGone, 10*time.Second) || !at(mainUp, 10*time.Second) || !at(mainUp, 10*time.Second) {
		t.Fatal("flapped back")
	}
	if at(mainUp, 10*time.Second) {
		t.Fatal("answered 3 times over 20 s: back")
	}
	// A main PC hung (port open, no answer): only after 5 minutes.
	w = windowSteps{}
	start := now
	for i := 0; ; i++ {
		if at(mainSlow, 15*time.Second) {
			break
		}
		if i > 100 {
			t.Fatal("hung for 25 minutes and the window never left")
		}
	}
	if now.Sub(start) < 5*time.Minute {
		t.Fatalf("hung: moved after %s", now.Sub(start))
	}
}

// The whole network is asked with growing pauses, again at once on another network, and from the start once found.
func TestSweepPauses(t *testing.T) {
	sweepFound()
	sweep.net = ""
	now := time.Now()
	n := 0
	for i := 0; i < 8*3600/30; i++ { // a whole day's "every 30 seconds"
		if sweepDue(now.Add(time.Duration(i)*30*time.Second), "192.168.1.0") {
			n++
		}
	}
	if n < 5 || n > 22 {
		t.Fatalf("%d sweeps in 8 hours (it was 960)", n)
	}
	if !sweepDue(now.Add(8*time.Hour), "192.168.8.0") {
		t.Fatal("another network: at once")
	}
	sweepFound()
	if sweepDue(time.Now().Add(3*time.Minute), "192.168.8.0") {
		t.Fatal("it answered 3 minutes ago: a restart")
	}
	if !sweepDue(time.Now().Add(5*time.Minute), "192.168.8.0") {
		t.Fatal("found, then lost: after a few minutes")
	}
}

// The number is asked once, not at every look.
func TestNumberAskedOnce(t *testing.T) {
	m, asked := slowMain(t, 0, nil)
	for i := 0; i < 10; i++ {
		if !numberKnown(m.URL, "47040") {
			t.Fatal("ours")
		}
	}
	if *asked != 1 {
		t.Fatalf("asked %d times", *asked)
	}
}

// The main PC's answer to the broadcast is read even when another PC's answer is asked first and slowly.
func TestBroadcastAnswersAreAllRead(t *testing.T) {
	withTemp(t)
	if os.Getenv("ADAL_NO_DISCOVERY") == "1" {
		t.Skip()
	}
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: discoveryPort})
	if err != nil {
		t.Skip("the discovery port is used here: ", err)
	}
	defer c.Close()
	var port string
	mine, _ := slowMain(t, 0, nil)
	_, port, _ = net.SplitHostPort(strings.TrimPrefix(mine.URL, "http://"))
	go func() {
		b := make([]byte, 256)
		for {
			n, from, err := c.ReadFromUDP(b)
			if err != nil {
				return
			}
			if string(b[:n]) == discoveryRequest {
				c.WriteToUDP([]byte(discoveryResponse+"|"+port+"||Main||aa:bb:cc:dd:ee:01"), from)
			}
		}
	}()
	saveIdentity(mainIdentity{Macs: []string{"aa:bb:cc:dd:ee:01"}})
	acceptServer = func(u string) bool { markUnknown(u, true); return false } // too busy to say who it is
	info := askByBroadcast(1500 * time.Millisecond)
	if info == nil {
		t.Skip("no network here carries a broadcast back")
	}
	if sameCard(info.Macs, []string{"aa:bb:cc:dd:ee:01"}) == false {
		t.Fatalf("%+v", info)
	}
}

// This PC's own server dead: a page goes to the main PC, a call is told to wait; a 502 never.
func TestOwnServerDeadNever502(t *testing.T) {
	get := func(path, accept, main string) *http.Response {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Accept", accept)
		w := httptest.NewRecorder()
		ownDown(w, r, main)
		return w.Result()
	}
	if r := get("/profiles/12?x=1", "text/html,*/*", "http://192.168.1.6:4000"); r.StatusCode != 307 || r.Header.Get("Location") != "http://192.168.1.6:4000/profiles/12?x=1" {
		t.Fatal(r.StatusCode, r.Header.Get("Location"))
	}
	if r := get("/api/profiles", "application/json", "http://192.168.1.6:4000"); r.StatusCode != 503 || r.Header.Get("Retry-After") == "" {
		t.Fatal(r.StatusCode)
	}
	if r := get("/", "text/html", ""); r.StatusCode != 503 {
		t.Fatal(r.StatusCode)
	}
}

// Hand back with its own server dead: the main PC is not asked to read it, the looks get rarer, and what is here stays.
func TestHandBackWaitsForItsOwnServer(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(fullData(root), "data.sqlite")
	os.MkdirAll(filepath.Dir(db), 0o755)
	os.WriteFile(db, []byte("work"), 0o644)
	old := actingPort
	actingPort = 1 // nothing listens there
	defer func() { actingPort = old }()
	s := &standbyRunner{root: root, peers: map[string]standbyPeer{}}
	now, looks := time.Now(), 0
	for i := 0; i < 3600/20; i++ {
		before := s.ownDead
		if s.ownReadyToHandBack(now.Add(time.Duration(i) * 20 * time.Second)) {
			t.Fatal("handed back from a dead server")
		}
		if s.ownDead != before {
			looks++
		}
	}
	if looks > 8 {
		t.Fatalf("%d tries in an hour (it was 40)", looks)
	}
	if b, _ := os.ReadFile(db); string(b) != "work" {
		t.Fatal("the work was touched")
	}
	ts, _ := slowMain(t, 0, nil)
	_, p, _ := net.SplitHostPort(strings.TrimPrefix(ts.URL, "http://"))
	fmt.Sscan(p, &actingPort)
	if !s.ownReadyToHandBack(now) || s.ownDead != 0 {
		t.Fatal("its server answers again: handed back")
	}
	if restartPause(1) != 30*time.Second || restartPause(9) != 5*time.Minute {
		t.Fatal("pauses")
	}
}
