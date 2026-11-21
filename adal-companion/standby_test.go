package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestOfficeAddrNeverThisPC(t *testing.T) {
	cases := map[string]string{
		"192.168.1.20": "127.168.1.20",
		"10.0.5.3":     "127.0.5.3",
		"10.0.0.1":     "127.254.254.254", // would be 127.0.0.1 (this PC itself)
		"172.16.4.9":   "127.16.4.9",
	}
	for in, want := range cases {
		if got := officeAddr(net.ParseIP(in)).String(); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	if officeAddr(net.ParseIP("fe80::1")).Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatal("IPv6 came as this PC")
	}
}

func TestOneCompanionStandsIn(t *testing.T) {
	withTemp(t)
	old := mainNumber
	_ = old
	s := &standbyRunner{root: t.TempDir(), peers: map[string]standbyPeer{}, myID: "bbb"}
	now := time.Now()
	tag := numberTag(mainNumber())
	// A stronger ready one: its turn, not ours.
	s.heard(strings.Join([]string{standbyMagic, tag, "ccc", "64", "0", "1"}, "|"), now)
	if s.myTurn(now) {
		t.Fatal("a stronger Companion is there")
	}
	// It is not ready (no copy): ours.
	s.heard(strings.Join([]string{standbyMagic, tag, "ccc", "64", "0", "0"}, "|"), now)
	if !s.myTurn(now) {
		t.Fatal("the only ready one should stand in")
	}
	// Another agency's Companion is never counted.
	s.heard(strings.Join([]string{standbyMagic, "ffffffffffffffff", "aaa", "999", "1", "1"}, "|"), now)
	if s.othersActing(now) {
		t.Fatal("another agency's Companion counted")
	}
	// One standing in already: nobody else does.
	s.heard(strings.Join([]string{standbyMagic, tag, "ddd", "1", "1", "1"}, "|"), now)
	if !s.othersActing(now) {
		t.Fatal("the one standing in was not heard")
	}
	if s.othersActing(now.Add(time.Minute)) {
		t.Fatal("a Companion gone quiet still counts")
	}
}

func TestRealMainIsNotOneStandingIn(t *testing.T) {
	withTemp(t)
	acting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok","role":"main","instance":"x","acting":true}`))
	}))
	defer acting.Close()
	real := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			w.Write([]byte(`{"status":"ok","role":"main","instance":"main-1"}`))
		case "/api/pc-access/check-number":
			w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer real.Close()
	s := &standbyRunner{root: t.TempDir(), peers: map[string]standbyPeer{}}
	// httptest is on 127.0.0.1: realMainAt skips loopback (this PC) — use the
	// address as the office would see it by asking healthOf directly.
	if h := healthOf(acting.URL, time.Second); h == nil || !h.Acting {
		t.Fatal("acting not read")
	}
	if s.realMainAt([]string{acting.URL}) != "" {
		t.Fatal("a Companion standing in taken for the main PC")
	}
}

// The office door: each computer reaches the server from its own loopback
// address and says who it is; nothing a computer sends can claim another.
func TestOfficeDoorSaysWhoItIs(t *testing.T) {
	var gotSock, gotReal, gotHost string
	back := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSock, gotReal, gotHost = r.RemoteAddr, r.Header.Get("x-adal-real-ip"), r.Host
		json.NewEncoder(w).Encode(map[string]string{"ok": "1"})
	}))
	defer back.Close()
	target, _ := url.Parse(back.URL)
	door := httptest.NewServer(&officeDoor{transports: map[string]*http.Transport{}, target: target})
	defer door.Close()
	req, _ := http.NewRequest(http.MethodGet, door.URL+"/api/health", nil)
	req.Header.Set("x-adal-real-ip", "1.2.3.4") // a computer pretending
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("door: %d", resp.StatusCode)
	}
	host, _, _ := net.SplitHostPort(gotSock)
	if host == "127.0.0.1" {
		t.Fatalf("the server saw this PC itself (%s)", gotSock)
	}
	if !strings.HasPrefix(host, "127.") {
		t.Fatalf("not a loopback address of its own: %s", gotSock)
	}
	if gotReal != "127.0.0.1" { // the test client is on this PC: the door says so, whatever it sent
		t.Fatalf("x-adal-real-ip = %q", gotReal)
	}
	if !strings.HasPrefix(gotHost, "127.0.0.1:") {
		t.Fatalf("host not passed on: %s", gotHost)
	}
}

// TestOfficeDoorLive (ADAL_DOOR_E2E=1): the office door on :4999 in front of a
// server on 127.0.0.1:4140 for 3 minutes, for the backend's end-to-end check
// of a Companion standing in and handing back (scratch e2e script).
func TestOfficeDoorLive(t *testing.T) {
	if os.Getenv("ADAL_DOOR_E2E") != "1" {
		t.Skip("set ADAL_DOOR_E2E=1 to run")
	}
	target, _ := url.Parse("http://127.0.0.1:4140")
	ln, err := net.Listen("tcp", ":4999")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go http.Serve(ln, &officeDoor{transports: map[string]*http.Transport{}, target: target})
	time.Sleep(3 * time.Minute)
}

// TestBundleLive (ADAL_BUNDLE_E2E="<main url> <key>"): the server is fetched
// from a real main PC and put in place, this PC's data folder kept.
func TestBundleLive(t *testing.T) {
	v := strings.Fields(os.Getenv("ADAL_BUNDLE_E2E"))
	if len(v) != 2 {
		t.Skip("set ADAL_BUNDLE_E2E")
	}
	withTemp(t)
	root := t.TempDir()
	// A data folder of its own (a stand-in before): it must survive the new server.
	os.MkdirAll(root+`\server\backend\data`, 0o755)
	os.WriteFile(root+`\server\backend\data\keep.txt`, []byte("mine"), 0o644)
	old := hostServer
	hostServer = v[0]
	defer func() { hostServer = old }()
	keys := loadKeys()
	keys.AccessKey = v[1]
	saveKeys(keys)
	s := &standbyRunner{root: root, peers: map[string]standbyPeer{}}
	if err := s.fetchBundle(); err != nil {
		t.Fatal(err)
	}
	if !hasServer(root) {
		t.Fatal("no server in place")
	}
	if b, _ := os.ReadFile(root + `\server\backend\data\keep.txt`); string(b) != "mine" {
		t.Fatal("this PC's data folder was lost")
	}
	if s.st.BundleVersion == "" {
		t.Fatal("version not kept")
	}
	// The same version again: nothing downloaded (304).
	if err := s.fetchBundle(); err != nil {
		t.Fatal(err)
	}
	t.Logf("server in place, version %s", s.st.BundleVersion)
}

// Handing back: only the main PC comes in, so nothing saved after it read is lost.
func TestOfficeDoorOnlyTheMainPCWhileHandingBack(t *testing.T) {
	back := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
	defer back.Close()
	target, _ := url.Parse(back.URL)
	d := &officeDoor{transports: map[string]*http.Transport{}, target: target}
	door := httptest.NewServer(d)
	defer door.Close()
	get := func() int {
		r, err := http.Get(door.URL + "/api/health")
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	if get() != 200 {
		t.Fatal("open door refused")
	}
	d.onlyFrom(net.ParseIP("192.168.1.9")) // the main PC (the test client is 127.0.0.1)
	if get() != http.StatusServiceUnavailable {
		t.Fatal("another computer came in while handing back")
	}
	d.onlyFrom(net.ParseIP("127.0.0.1"))
	if get() != 200 {
		t.Fatal("the main PC was refused")
	}
	d.onlyFrom(nil)
	if get() != 200 {
		t.Fatal("not open again")
	}
}

// A program renamed by the last update still running (its file locked): the
// next update still goes in, the old one aside under a name of its own.
func TestSetAsideWhenTheLastOneStillRuns(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows refuses to remove a file held open")
	}
	dir := t.TempDir()
	dest := dir + `\AdalKeep.exe`
	os.WriteFile(dest, []byte("new"), 0o644)
	os.WriteFile(dest+".old", []byte("running"), 0o644)
	f, _ := os.Open(dest + ".old") // held open: Windows refuses to remove it
	defer f.Close()
	aside := setAside(dest)
	if aside == dest+".old" {
		t.Fatal("aside onto the file still in use")
	}
	if err := os.Rename(dest, aside); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if got := setAside(dest); got != dest+".old" {
		t.Fatalf("not back to .old once free: %s", got)
	}
	if _, err := os.Stat(aside); !os.IsNotExist(err) {
		t.Fatal("a free leftover was not removed")
	}
}
