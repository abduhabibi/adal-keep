package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func bookTest(t *testing.T, key string) {
	t.Helper()
	presenceTest(t)
	old := presenceKey
	k := signKeyOf(key)
	presenceKey = func() []byte { return k }
	presenceMu.Lock()
	signedAt = map[string]int64{}
	presenceMu.Unlock()
	bookMu.Lock()
	bookLast = map[string]bookEntry{}
	bookMu.Unlock()
	bookMu.Lock()
	bookRoot = t.TempDir()
	bookMu.Unlock()
	t.Cleanup(func() {
		presenceBusy.Lock() // (a look at the main PC started by a message: done)
		presenceBusy.Unlock()
		presenceKey = old
		bookMu.Lock()
		bookRoot = ""
		bookMu.Unlock()
	})
}

func TestTheSameSignatureAsMain(t *testing.T) {
	bookTest(t, "the agency backup key")
	b, err := os.ReadFile(filepath.Join("testdata", "presence", "signed.txt")) // made by backend tests/presenceSigned.test.js
	if err != nil {
		t.Fatal(err)
	}
	v := strings.TrimSpace(string(b))
	at := time.UnixMilli(1_800_000_000_000)
	if s, ok, _ := checkSigned(v, "aaaaaaaaaaaa", "10.0.0.5", at); !s || !ok {
		t.Fatal("Main's signature not taken")
	}
	pb, _ := os.ReadFile(filepath.Join("testdata", "presence", "proof.txt"))
	f := strings.Fields(string(pb))
	if len(f) != 3 || macOf(signKeyOf("the agency backup key"), "proof|"+f[0]+"|"+f[1]) != f[2] {
		t.Fatal("Main's proof not the one checked here", f)
	}
	if got := signPresence(strings.SplitN(v, "|s1:", 2)[0], signKeyOf("the agency backup key"), []string{"192.168.1.5", "10.0.0.5"}, 1_800_000_000_000); got != v {
		t.Fatalf("\n%s\n%s", got, v)
	}
}

func TestSignedOnly(t *testing.T) {
	bookTest(t, "ours")
	now := time.Now()
	msg := presenceMessage(agencyTag("47040"), "cccccccccccc", 4000, "main", "MAIN", false)
	mine := signPresence(msg, signKeyOf("ours"), []string{"192.168.1.5"}, now.UnixMilli())
	theirs := signPresence(msg, signKeyOf("another agency"), []string{"192.168.1.66"}, now.UnixMilli())
	if e, ok := presenceHeard(theirs, "192.168.1.66"); ok || e.Signed {
		t.Fatal("another agency's PC with our number taken")
	}
	if _, ok := presenceHeard(mine, "192.168.1.66"); ok {
		t.Fatal("a copy replayed from another address taken")
	}
	if e, ok := presenceHeard(mine, "192.168.1.5"); !ok || !e.Signed {
		t.Fatal("ours refused")
	}
	if _, ok := presenceHeard(msg, "192.168.1.66"); ok {
		t.Fatal("once signed, never unsigned again")
	}
	old := signPresence(msg, signKeyOf("ours"), []string{"192.168.1.5"}, now.Add(-2*time.Minute).UnixMilli())
	if _, ok := presenceHeard(old, "192.168.1.5"); ok {
		t.Fatal("an older one taken")
	}
	// An older program (no signature) of a PC never heard signed: as before.
	if e, ok := presenceHeard(presenceMessage(agencyTag("47040"), "dddddddddddd", 47810, "companion", "PC3", false), "192.168.1.9"); !ok || e.Signed {
		t.Fatal("an older program refused")
	}
	t.Setenv("ADAL_PRESENCE_STRICT", "1")
	if _, ok := presenceHeard(presenceMessage(agencyTag("47040"), "eeeeeeeeeeee", 47810, "companion", "PC4", false), "192.168.1.10"); ok {
		t.Fatal("strict: unsigned taken")
	}
	// Signed Companions are the ones a copy is asked of (and only those, with the key here).
	if got := companionsHeard(); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestBookKeptOverARestart(t *testing.T) {
	bookTest(t, "ours")
	now := time.Now()
	m := signPresence(presenceMessage(agencyTag("47040"), "cccccccccccc", 4000, "main", "MAIN", false), signKeyOf("ours"), []string{"192.168.1.5"}, now.UnixMilli())
	presenceHeard(m, "192.168.1.5")
	time.Sleep(3500 * time.Millisecond)
	bookMu.Lock()
	root := bookRoot
	bookMu.Unlock()
	bookMu.Lock()
	bookLast = map[string]bookEntry{}
	bookMu.Unlock()
	loadBook(root)
	if u := lastKnown("cccccccccccc"); u != "http://192.168.1.5:4000" {
		t.Fatal(u)
	}
}

func TestOnlineBeforeTheSweep(t *testing.T) {
	bookTest(t, "ours")
	old := cloudLookFn
	asked := 0
	cloudLookFn = func(string) []string { asked++; return nil }
	defer func() { cloudLookFn = old }()
	cloudLook = time.Time{}
	mainFromCloud()
	mainFromCloud() // (not twice within 30 s)
	if asked != 1 {
		t.Fatal(asked)
	}
	t.Setenv("ADAL_BOOK", "0")
	cloudLook = time.Time{}
	mainFromCloud()
	if asked != 1 {
		t.Fatal("off")
	}
}

func TestOwnAddressChangeSaidAtOnce(t *testing.T) {
	old := ownNets
	defer func() { ownNets = old }()
	var mu sync.Mutex
	addr := "192.168.1.5"
	ownNets = func() []*net.IPNet {
		mu.Lock()
		defer mu.Unlock()
		return []*net.IPNet{{IP: net.ParseIP(addr).To4(), Mask: net.CIDRMask(24, 32)}}
	}
	t.Setenv("ADAL_ADDR_WATCH_MS", "20")
	said := make(chan string, 10)
	stop := make(chan struct{})
	defer close(stop)
	go watchOwnAddress(func() { said <- strings.Join(ownAddrs(), ",") }, stop)
	time.Sleep(60 * time.Millisecond)
	mu.Lock()
	addr = "192.168.1.3"
	mu.Unlock()
	select {
	case got := <-said:
		if got != "192.168.1.3" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("not said")
	}
	select {
	case <-robotKick:
	case <-time.After(time.Second):
		t.Fatal("Main not told at once")
	}
}

func TestOnlyOurAgencyProves(t *testing.T) {
	bookTest(t, "ours")
	mk := func(key string, proves bool) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if n := r.URL.Query().Get("proof"); n != "" && proves {
				w.Header().Set("X-Adal-Proof", macOf(signKeyOf(key), "proof|"+n+"|cccccccccccc"))
			}
			w.Write([]byte(`{"service":"adal-keep","pc_id":"cccccccccccc"}`))
		}))
	}
	ours, theirs, old := mk("ours", true), mk("another agency", true), mk("", false)
	defer ours.Close()
	defer theirs.Close()
	defer old.Close()
	if !provesOurs(ours.URL) || provesOurs(theirs.URL) {
		t.Fatal("proof")
	}
	if !provesOurs(old.URL) {
		t.Fatal("an older Main (no proof) refused before ours was heard signing")
	}
	saveIdentity(mainIdentity{PCID: "cccccccccccc"})
	presenceMu.Lock()
	signedAt["cccccccccccc"] = time.Now().UnixMilli()
	presenceMu.Unlock()
	if provesOurs(old.URL) {
		t.Fatal("our Main signs: one that cannot prove it is not ours")
	}
}
