package main

// The Companion and the main PC update each other (2026-11-19: the main PC's
// internet timed out on the download while a Companion on the same Wi-Fi had
// the newer release). The main PC is played by an HTTP server with the same
// routes as services/lanRelease.js.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A release with the agent too (a program a Companion does not run, but keeps to hand on).
func fullRelease(t *testing.T, priv ed25519.PrivateKey, sha string, seq int64, prog []byte) (envelope, map[string][]byte, map[string][]byte) {
	app := []byte("the app " + sha)
	agent := []byte("agent " + sha)
	pages := tgz(t, map[string]string{"index.html": "pages " + sha})
	at := time.Date(2026, 11, 19, int(seq), 0, 0, 0, time.UTC).Format(time.RFC3339)
	env := sign(t, priv, map[string]any{
		"sha": sha, "short": sha[:7], "seq": seq, "date": at, "published_at": at, "everyone_at": at, "early": []string{},
		"file": "release/" + sha + ".tar.gz", "sha256": sum(app),
		"programs": []map[string]any{
			{"name": "adal-companion.exe", "file": "programs/" + sum(prog) + "-adal-companion.exe", "sha256": sum(prog), "size": len(prog)},
			{"name": "adal-agent.exe", "file": "programs/" + sum(agent) + "-adal-agent.exe", "sha256": sum(agent), "size": len(agent)},
		},
		"online": map[string]any{"file": "online/" + sum(pages) + ".tar.gz", "sha256": sum(pages), "size": len(pages)},
	})
	byFile := map[string][]byte{
		"release/" + sha + ".tar.gz":                    app,
		"programs/" + sum(prog) + "-adal-companion.exe": prog,
		"programs/" + sum(agent) + "-adal-agent.exe":    agent,
		"online/" + sum(pages) + ".tar.gz":              pages,
	}
	bySHA := map[string][]byte{}
	for _, b := range byFile {
		bySHA[sum(b)] = b
	}
	return env, bySHA, byFile
}

// A Supabase on this PC: sign-in, latest.json, and the pieces (Range works; the first download answers 500).
func fakeCloud(t *testing.T, env envelope, byFile map[string][]byte) *httptest.Server {
	var mu sync.Mutex
	first := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/auth/v1/token"):
			w.Write([]byte(`{"access_token":"t"}`))
		case r.URL.Path == "/storage/v1/object/authenticated/adal-updates/release/latest.json":
			json.NewEncoder(w).Encode(env)
		default:
			name := strings.TrimPrefix(r.URL.Path, "/storage/v1/object/authenticated/adal-updates/")
			b, ok := byFile[name]
			if !ok {
				http.NotFound(w, r)
				return
			}
			mu.Lock()
			fail := first
			first = false
			mu.Unlock()
			if fail {
				http.Error(w, "busy", http.StatusInternalServerError)
				return
			}
			http.ServeContent(w, r, "x", time.Time{}, bytes.NewReader(b))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func fastDownloads(t *testing.T) {
	old, oldTries, oldEvery := dl, completeTries, completeEvery
	dl.backoff, dl.chunk = 5*time.Millisecond, 7 // tiny pieces: many Range requests
	completeTries, completeEvery = 1, time.Millisecond
	t.Cleanup(func() { dl, completeTries, completeEvery = old, oldTries, oldEvery })
}

// A main PC (services/lanRelease.js routes): what it has, and the offers it gets.
type lanMain struct {
	srv    *httptest.Server
	env    *envelope
	offers []offerMsg
	mu     sync.Mutex
}

func newLanMain(t *testing.T, env *envelope) *lanMain {
	f := &lanMain{env: env}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/system/update/lan/latest":
			if f.env == nil {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(f.env)
		case "/api/system/update/lan/offer":
			var o offerMsg
			json.NewDecoder(r.Body).Decode(&o)
			f.mu.Lock()
			f.offers = append(f.offers, o)
			f.mu.Unlock()
			w.Write([]byte(`{"ok":true,"newer":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.srv.Close)
	old := mainBase
	mainBase = func() string { return f.srv.URL + "/api/system/update/lan" }
	t.Cleanup(func() { mainBase = old })
	return f
}

// From Supabase, a Companion takes the COMPLETE release (also the agent, which
// it does not run, and the app), through a 500 and in Range pieces; then it
// offers it to the main PC, which is on an older release.
func TestCompanionKeepsTheWholeReleaseAndPushesItToMain(t *testing.T) {
	fastDownloads(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("new companion program")
	env, bySHA, byFile := fullRelease(t, priv, strings.Repeat("4", 40), 12, prog)
	cloud := fakeCloud(t, env, byFile)
	b := companionPC(t, pub)
	cj, _ := json.Marshal(cloudCreds{URL: cloud.URL, Anon: "anon", Email: "c@x", Password: "p"})
	os.WriteFile(filepath.Join(b.root, "companion-cloud.json"), cj, 0o600)
	oldEnv, _, _ := fullRelease(t, priv, strings.Repeat("3", 40), 10, []byte("old"))
	main := newLanMain(t, &oldEnv)

	if err := b.fromCloud(); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != string(prog) {
		t.Fatalf("program not updated: %q", got)
	}
	m, _ := b.current()
	deadline := time.Now().Add(5 * time.Second)
	for !b.complete(m) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	for sha, want := range bySHA {
		if got, _ := os.ReadFile(filepath.Join(b.files(), sha)); !bytes.Equal(got, want) {
			t.Fatalf("piece %s not kept whole", sha[:8])
		}
	}
	if _, err := os.Stat(filepath.Join(b.root, "adal-agent.exe")); err == nil {
		t.Fatal("the agent was installed on a Companion (it is only kept to hand on)")
	}
	// The main PC was told (by install / completeSet, or now).
	b.offerToMain()
	main.mu.Lock()
	offers := append([]offerMsg(nil), main.offers...)
	main.mu.Unlock()
	if len(offers) != 1 {
		t.Fatalf("offers to the main PC: %d", len(offers))
	}
	o := offers[0]
	if o.SHA != m.SHA || o.Port != lanHTTPPort || o.Path != "/lan" || o.Tags != ownAgencyTag() {
		t.Fatalf("offer: %+v", o)
	}
	// Once per release (no flood); none when the main PC is as new.
	if b.offerToMain() {
		t.Fatal("offered twice")
	}
	main.env = &env
	offeredAt.Lock()
	offeredAt.m = map[string]time.Time{}
	offeredAt.Unlock()
	if b.offerToMain() {
		t.Fatal("offered to a main PC that has it")
	}
	// /lan/latest says which pieces are here.
	srv := httptest.NewServer(b.handler())
	defer srv.Close()
	resp, _ := http.Get(srv.URL + "/lan/latest")
	var got struct{ Have []string }
	json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if len(got.Have) != 4 {
		t.Fatalf("have: %v", got.Have)
	}
}

func postOffer(t *testing.T, to string, o offerMsg) map[string]any {
	body, _ := json.Marshal(o)
	resp, err := http.Post(to+"/lan/offer", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var r map[string]any
	json.NewDecoder(resp.Body).Decode(&r)
	return r
}

func waitFile(path, want string) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got, _ := os.ReadFile(path); string(got) == want {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// The reverse: the main PC has the newer release and offers it to the
// Companion; the Companion takes it from the main PC. Another agency's offer,
// an older one and a wrongly signed one are not taken.
func TestMainOffersCompanionTheNewerRelease(t *testing.T) {
	fastDownloads(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	b := companionPC(t, pub)
	srvB := httptest.NewServer(b.handler())
	defer srvB.Close()

	// Another key: offered, looked at, refused.
	badEnv, badPieces, _ := fullRelease(t, other, strings.Repeat("9", 40), 20, []byte("evil companion"))
	_, badBase := holder(t, other.Public().(ed25519.PublicKey), badEnv, badPieces)
	port := func(base string) int {
		_, p, _ := net.SplitHostPort(strings.TrimSuffix(strings.TrimPrefix(base, "http://"), "/lan"))
		n := 0
		for _, c := range p {
			n = n*10 + int(c-'0')
		}
		return n
	}
	offer := func(env envelope, base, tag string) map[string]any {
		var m releaseManifest
		json.Unmarshal(env.Manifest, &m)
		return postOffer(t, srvB.URL, offerMsg{SHA: m.SHA, PublishedAt: m.PublishedAt, Port: port(base), Path: "/lan", Tags: tag})
	}
	if r := offer(badEnv, badBase, ownAgencyTag()); r["newer"] != true {
		t.Fatalf("news: %v", r)
	}
	time.Sleep(300 * time.Millisecond)
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != "old companion" {
		t.Fatal("a wrongly signed release was installed")
	}

	// Another agency's offer: not even looked at.
	prog := []byte("main's newer companion")
	env, pieces, _ := fullRelease(t, priv, strings.Repeat("6", 40), 15, prog)
	_, mainBaseURL := holder(t, pub, env, pieces)
	if r := offer(env, mainBaseURL, agencyTag("999999")); r["newer"] != false {
		t.Fatalf("another agency: %v", r)
	}
	time.Sleep(200 * time.Millisecond)
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != "old companion" {
		t.Fatal("another agency's release was installed")
	}

	// This agency's main PC: taken.
	if r := offer(env, mainBaseURL, "111,"+ownAgencyTag()); r["newer"] != true {
		t.Fatalf("offer: %v", r)
	}
	if !waitFile(filepath.Join(b.root, "adal-companion.exe"), string(prog)) {
		t.Fatal("the main PC's newer release was not taken")
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if m, _ := b.current(); m != nil && m.SHA == strings.Repeat("6", 40) {
			break
		}
	}

	// An older one afterwards: not newer, nothing changes.
	oldEnv, oldPieces, _ := fullRelease(t, priv, strings.Repeat("5", 40), 14, []byte("older companion"))
	_, oldBase := holder(t, pub, oldEnv, oldPieces)
	if r := offer(oldEnv, oldBase, ownAgencyTag()); r["newer"] != false {
		t.Fatalf("older: %v", r)
	}
	if err := b.fromPeer(oldBase); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != string(prog) {
		t.Fatal("went back to an older release")
	}
}

// A slow line: the line drops every answer after a few KB, the first answer is 503.
func TestDownloadGoesOnWhereItWasCut(t *testing.T) {
	old := dl
	dl.backoff, dl.chunk, dl.tries = 2*time.Millisecond, 64<<10, 3
	defer func() { dl = old }()
	data := make([]byte, 700_000)
	rand.Read(data)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var start, end int64
		if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil {
			t.Errorf("no range: %v", err)
		}
		if end >= int64(len(data)) {
			end = int64(len(data)) - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		cut := start + 20_000
		if cut > end+1 {
			cut = end + 1
		}
		w.Write(data[start:cut])
		if cut <= end { // the line drops
			if hj, ok := w.(http.Hijacker); ok {
				c, _, _ := hj.Hijack()
				c.Close()
			}
		}
	}))
	defer srv.Close()
	u := newUpdater(t.TempDir())
	dest := filepath.Join(u.root, "x.bin")
	if err := u.download(srv.URL, nil, sum(data), dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); !bytes.Equal(got, data) || calls < 30 {
		t.Fatalf("calls %d", calls)
	}
	// A wrong file: thrown away, nothing left behind.
	calls = 1
	if err := u.download(srv.URL, nil, strings.Repeat("0", 64), filepath.Join(u.root, "y.bin")); err == nil {
		t.Fatal("a wrong file was kept")
	}
	if _, err := os.Stat(filepath.Join(u.root, "y.bin.part")); err == nil {
		t.Fatal("the wrong part is left")
	}
	_ = io.EOF
}
