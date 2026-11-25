package main

import (
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// A fake main PC: the signed release it runs and its files; every byte sent is counted.
type lanMain struct {
	mu    sync.Mutex
	env   envelope
	sha   string
	files map[string][]byte
	sent  int64
	asked []string
	fail  func(path string, n int) bool
	n     int
}

func (f *lanMain) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("x-adal-pc") != "key-of-this-pc" {
		http.Error(w, "no", 403)
		return
	}
	f.n++
	f.asked = append(f.asked, r.URL.Path)
	if f.fail != nil && f.fail(r.URL.Path, f.n) {
		hj, _ := w.(http.Hijacker)
		c, _, _ := hj.Hijack()
		c.Close()
		return
	}
	count := &countWriter{ResponseWriter: w}
	defer func() { f.sent += count.n }()
	switch {
	case r.URL.Path == "/api/companion/lan/latest":
		if f.sha == "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("If-None-Match") == `"`+f.sha+`"` {
			w.WriteHeader(304)
			return
		}
		json.NewEncoder(count).Encode(f.env)
	case strings.HasPrefix(r.URL.Path, "/api/companion/lan/file/"):
		b, ok := f.files[strings.TrimPrefix(r.URL.Path, "/api/companion/lan/file/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(count, r, "", time.Time{}, bytes.NewReader(b))
	default:
		http.NotFound(w, r)
	}
}

type countWriter struct {
	http.ResponseWriter
	n int64
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.ResponseWriter.Write(b)
	c.n += int64(n)
	return n, err
}

// run: what Main runs now.
func (f *lanMain) run(t *testing.T, priv ed25519.PrivateKey, sha, at string, files map[string]string, more map[string]any) {
	app := map[string]string{}
	for rel, c := range files {
		app[rel] = sum([]byte(c))
		f.files[sum([]byte(c))] = []byte(c)
	}
	m := map[string]any{"channel": "lan", "lan": true, "sha": sha, "short": sha[:7], "date": at, "published_at": at, "seq": releaseTime(at).UnixMilli(),
		"file": "release/x.tar.gz", "sha256": sum([]byte("app " + sha)), "app_files": app, "lock_hash": sum([]byte("lock")), "early": []string{}}
	for k, v := range more {
		m[k] = v
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.env, f.sha, f.sent, f.asked = sign(t, priv, m), sha, 0, nil
}

const big = 200 << 10

func serverFiles(line string) map[string]string {
	long := strings.Repeat("// a long file of the server, line after line\n", big/46)
	return map[string]string{
		"adal-keep-backend/server.js":                      "console.log('server')",
		"adal-keep-backend/package-lock.json":              "lock",
		"adal-keep-backend/src/a.js":                       "export const a = 1 // " + line,
		"adal-keep-backend/src/long.js":                    long,
		"adal-keep-frontend/dist/index.html":               "<html>",
		"adal-keep-frontend/dist/assets/index-AAAAAAAA.js": long + "1",
	}
}

// lanCompanion: a Companion with its own server kept (an unsigned one of an older program, as at the offices).
func lanCompanion(t *testing.T, pub ed25519.PublicKey) (*updater, *standbyRunner) {
	u := companionPC(t, pub)
	u.failed = map[string]time.Time{}
	write := func(p, c string) {
		f := filepath.Join(u.root, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(f), 0o755)
		os.WriteFile(f, []byte(c), 0o644)
	}
	write("server/runtime/node.exe", "node")
	write("server/runtime/node", "node")
	for rel, c := range serverFiles("old") {
		p := strings.Replace(rel, "adal-keep-backend/", "backend/", 1)
		write("server/"+p, c)
	}
	write("server/backend/src/evil.js", "unsigned, not in any release")
	write("server/backend/data/data.sqlite", "the girls")
	write("server/backend/uploads/1/a.pdf", "a paper")
	write("server/backend/.env", "SECRET=1")
	write("server/.adal-version.json", `{"sha":"`+strings.Repeat("0", 40)+`","date":"2026-11-01T00:00:00Z","published_at":"2026-11-01T00:00:00Z"}`)
	return u, &standbyRunner{root: u.root, peers: map[string]standbyPeer{}}
}

func lanOffice(t *testing.T) (*lanMain, ed25519.PublicKey, ed25519.PrivateKey) {
	withTemp(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := &lanMain{files: map[string][]byte{}}
	srv := httptest.NewServer(f)
	k := loadKeys()
	k.AccessKey = "key-of-this-pc"
	saveKeys(k)
	oh, ow, or, os_ := hostServer, waitForRuns, lanRetry, standby
	hostServer, lanRetry = srv.URL, 10*time.Millisecond
	waitForRuns = func(<-chan struct{}) bool { return true }
	lanNamed.Store("")
	t.Cleanup(func() { srv.Close(); lanNamed.Store(""); hostServer, waitForRuns, lanRetry, standby = oh, ow, or, os_ })
	return f, pub, priv
}

func at(u *updater, p string) string {
	b, _ := os.ReadFile(filepath.Join(u.root, filepath.FromSlash(p)))
	return string(b)
}

func sameAs(t *testing.T, u *updater, files map[string]string) {
	t.Helper()
	for rel, c := range files {
		p := "server/" + strings.Replace(rel, "adal-keep-backend/", "backend/", 1)
		if at(u, p) != c {
			t.Fatalf("%s is not the release's", p)
		}
	}
	for p, c := range map[string]string{"server/backend/data/data.sqlite": "the girls", "server/backend/uploads/1/a.pdf": "a paper", "server/backend/.env": "SECRET=1"} {
		if at(u, p) != c {
			t.Fatalf("%s was touched", p)
		}
	}
	if _, err := os.Stat(filepath.Join(u.root, "server.before")); err == nil {
		t.Fatal("left over")
	}
}

// Two Companions follow Main; a one-line change sends one small file to each.
func TestTwoCompanionsTakeOnlyWhatChanged(t *testing.T) {
	f, pub, priv := lanOffice(t)
	f.run(t, priv, strings.Repeat("1", 40), "2026-11-25T10:00:00Z", serverFiles("one"), nil)
	type pc struct {
		u *updater
		s *standbyRunner
	}
	var pcs []pc
	for i := 0; i < 2; i++ {
		u, s := lanCompanion(t, pub)
		pcs = append(pcs, pc{u, s})
	}
	follow := func() (per []int64) {
		for _, p := range pcs {
			standby = p.s
			f.sent = 0
			if err := p.u.fromLan(); err != nil {
				t.Fatal(err)
			}
			per = append(per, f.sent)
		}
		return
	}
	first := follow()
	for _, p := range pcs {
		sameAs(t, p.u, serverFiles("one"))
		if at(p.u, "server/backend/src/evil.js") != "" {
			t.Fatal("a file no release has stayed")
		}
	}
	// One line changed in a small file.
	f.run(t, priv, strings.Repeat("2", 40), "2026-11-25T11:00:00Z", serverFiles("two, one line"), nil)
	line := follow()
	for _, p := range pcs {
		sameAs(t, p.u, serverFiles("two, one line"))
	}
	manifest := int64(len(f.env.Manifest))
	t.Logf("first: %v bytes, one line: %v bytes (of it the signed manifest %d), whole server %d bytes", first, line, manifest, 2*big)
	for _, n := range line {
		if n > manifest+400 {
			t.Fatalf("a one-line change sent %d bytes", n)
		}
	}
	// Nothing changed: nothing but a 304.
	for _, n := range follow() {
		if n != 0 {
			t.Fatalf("nothing changed, %d bytes sent", n)
		}
	}
}

// A page's file under another name with one line changed: the patch, not the file.
func TestLongFileComesAsAPatch(t *testing.T) {
	f, pub, priv := lanOffice(t)
	u, s := lanCompanion(t, pub)
	standby = s
	files := serverFiles("old")
	old := files["adal-keep-frontend/dist/assets/index-AAAAAAAA.js"]
	delete(files, "adal-keep-frontend/dist/assets/index-AAAAAAAA.js")
	nw := old + "2"
	files["adal-keep-frontend/dist/assets/index-BBBBBBBB.js"] = nw
	pt := appendPatch(t, []byte(old), []byte("2"))
	f.files[sum(pt)] = pt
	f.run(t, priv, strings.Repeat("1", 40), "2026-11-25T10:00:00Z", files, map[string]any{"file_patches": map[string]any{
		sum([]byte(nw)): map[string]any{"from": sum([]byte(old)), "file": "lan/x", "sha256": sum(pt), "size": len(pt)}}})
	if err := u.fromLan(); err != nil {
		t.Fatal(err)
	}
	sameAs(t, u, files)
	if at(u, "server/adal-keep-frontend/dist/assets/index-AAAAAAAA.js") != "" {
		t.Fatal("the old page's file stayed")
	}
	if f.sent > int64(len(f.env.Manifest))+2000 {
		t.Fatalf("%d bytes for one letter", f.sent)
	}
	// A damaged patch: the whole file, checked, instead.
	u2, s2 := lanCompanion(t, pub)
	standby = s2
	f.files[sum(pt)] = []byte("not the patch")
	if err := u2.fromLan(); err != nil {
		t.Fatal(err)
	}
	sameAs(t, u2, files)
}

func TestNothingUnsignedFromMain(t *testing.T) {
	f, pub, priv := lanOffice(t)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	u, s := lanCompanion(t, pub)
	standby = s
	same := func(why string) {
		t.Helper()
		if at(u, "server/backend/src/a.js") != serverFiles("old")["adal-keep-backend/src/a.js"] || at(u, "adal-companion.exe") != "old companion" {
			t.Fatalf("%s: something was installed", why)
		}
		sameAs(t, u, nil)
	}
	prog := []byte("a new companion")
	f.files[sum(prog)] = prog
	progs := map[string]any{"programs": []map[string]any{{"name": "adal-companion.exe", "file": "p", "sha256": sum(prog), "size": len(prog)}}}
	// Signed with another key.
	f.run(t, other, strings.Repeat("3", 40), "2026-11-25T10:00:00Z", serverFiles("evil"), progs)
	if err := u.fromLan(); err == nil {
		t.Fatal("another key was accepted")
	}
	same("another key")
	// No signature; a manifest changed after it was signed.
	f.env.Signature = ""
	if u.fromLan() == nil {
		t.Fatal("no signature was accepted")
	}
	f.run(t, priv, strings.Repeat("3", 40), "2026-11-25T10:00:00Z", serverFiles("good"), progs)
	f.env.Manifest = json.RawMessage(strings.Replace(string(f.env.Manifest), `"lan":true`, `"lan":false`, 1))
	if u.fromLan() == nil {
		t.Fatal("a changed manifest was accepted")
	}
	same("no signature")
	// Signed well, but Main sends other bytes for one file: nothing at all is put in place.
	f.run(t, priv, strings.Repeat("4", 40), "2026-11-25T10:00:00Z", serverFiles("good"), progs)
	h := sum([]byte(serverFiles("good")["adal-keep-backend/src/a.js"]))
	f.files[h] = []byte("export const a = 'evil'")
	if u.fromLan() == nil {
		t.Fatal("other bytes were accepted")
	}
	if at(u, "server/backend/src/a.js") != serverFiles("old")["adal-keep-backend/src/a.js"] {
		t.Fatal("put in place")
	}
	sameAs(t, u, nil)
	// Paths out of the server, or at the agency's data: the release is refused.
	for i, rel := range []string{"adal-keep-backend/../../adal-companion.exe", "adal-keep-backend/data/data.sqlite", "adal-keep-backend/.env", "C:/x", `adal-keep-backend\x`, "adal-keep-backend/node_modules/x.js", "somewhere/x"} {
		files := serverFiles("x")
		files[rel] = "evil"
		u.lanDone, u.lanAgain = "", time.Time{}
		f.run(t, priv, fmt.Sprintf("%040d", 50+i), fmt.Sprintf("2026-11-25T12:%02d:00Z", i), files, nil)
		if u.fromLan() == nil {
			t.Fatalf("%s was accepted", rel)
		}
		sameAs(t, u, nil)
	}
}

func TestOnlyForwardAndNotWhileStandingIn(t *testing.T) {
	f, pub, priv := lanOffice(t)
	u, s := lanCompanion(t, pub)
	standby = s
	// An older release Main was put back on by hand (signed once): not taken.
	f.run(t, priv, strings.Repeat("5", 40), "2026-10-01T10:00:00Z", serverFiles("older"), nil)
	if u.fromLan() == nil {
		t.Fatal("an older release was taken")
	}
	// Other packages, not signed: the server stays.
	f.run(t, priv, strings.Repeat("6", 40), "2026-11-25T10:00:00Z", serverFiles("new"), map[string]any{"lock_hash": sum([]byte("another lock"))})
	if err := u.fromLan(); err == nil || !strings.Contains(err.Error(), "packages") {
		t.Fatal(err)
	}
	s.st.Acting = true
	f.run(t, priv, strings.Repeat("7", 40), "2026-11-25T11:00:00Z", serverFiles("new"), nil)
	if err := u.fromLan(); err != nil {
		t.Fatal(err)
	}
	sameAs(t, u, serverFiles("old"))
	s.st.Acting = false
	t.Setenv("ADAL_LAN_UPDATES", "0")
	if lanUpdatesOn() {
		t.Fatal("off")
	}
}

// Main's Wi-Fi drops in the middle: it goes on, nothing half.
func TestCutInTheMiddle(t *testing.T) {
	f, pub, priv := lanOffice(t)
	u, s := lanCompanion(t, pub)
	standby = s
	files := serverFiles("new")
	files["adal-keep-backend/src/b.js"] = strings.Repeat("b", 5000)
	f.run(t, priv, strings.Repeat("8", 40), "2026-11-25T10:00:00Z", files, nil)
	f.fail = func(_ string, n int) bool { return n%2 == 1 } // every other request dies
	for i := 0; i < 5 && u.lanDone == ""; i++ {
		u.fromLan()
	}
	sameAs(t, u, files)
}

// The program ended half-way through putting files in place: the next start puts the old ones back.
func TestCutOffWhilePuttingInPlace(t *testing.T) {
	_, pub, _ := lanOffice(t)
	u, _ := lanCompanion(t, pub)
	before := filepath.Join(u.root, "server.before")
	os.MkdirAll(before, 0o755)
	a := filepath.Join(u.root, "server", "backend", "src", "a.js")
	nf := filepath.Join(u.root, "server", "backend", "src", "new.js")
	long := filepath.Join(u.root, "server", "backend", "src", "long.js")
	b, _ := json.Marshal([]movedFile{{a, filepath.Join(before, "0")}, {nf, ""}, {long, filepath.Join(before, "2")}})
	os.WriteFile(filepath.Join(before, "journal.json"), b, 0o644)
	os.Rename(a, filepath.Join(before, "0"))
	os.WriteFile(a, []byte("half"), 0o644)
	os.WriteFile(nf, []byte("new"), 0o644)
	tidyServer(u.root)
	sameAs(t, u, serverFiles("old"))
	if at(u, "server/backend/src/new.js") != "" {
		t.Fatal("a new file stayed")
	}
}

// Programs and the Companion's own pages come from Main too, and are put in place as ever.
func TestProgramsFromMain(t *testing.T) {
	f, pub, priv := lanOffice(t)
	u, s := lanCompanion(t, pub)
	standby = s
	prog, pages := []byte("a new companion"), tgz(t, map[string]string{"index.html": "new pages"})
	f.files[sum(prog)], f.files[sum(pages)] = prog, pages
	f.run(t, priv, strings.Repeat("9", 40), "2026-11-25T10:00:00Z", serverFiles("new"), map[string]any{
		"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/c", "sha256": sum(prog), "size": len(prog)}},
		"online":   map[string]any{"file": "online/x.tar.gz", "sha256": sum(pages), "size": len(pages)}})
	if err := u.fromLan(); err != nil {
		t.Fatal(err)
	}
	if at(u, "adal-companion.exe") != "a new companion" || at(u, "online/index.html") != "new pages" || at(u, "online/config.js") == "" {
		t.Fatal("not installed")
	}
	sameAs(t, u, serverFiles("new"))
}

// appendPatch: the bsdiff.js format by hand — all of old, then extra.
func appendPatch(t *testing.T, old, extra []byte) []byte {
	i64 := func(v int64) []byte {
		b := make([]byte, 8)
		for i := range b {
			b[i] = byte(v >> (8 * i))
		}
		return b
	}
	gz := func(b []byte) []byte { return gzipped(t, b) }
	ctrl := gz(append(append(i64(int64(len(old))), i64(int64(len(extra)))...), i64(0)...))
	diff := gz(make([]byte, len(old)))
	out := append([]byte("ADALDIF1"), i64(int64(len(old)+len(extra)))...)
	out = append(append(out, i64(int64(len(ctrl)))...), i64(int64(len(diff)))...)
	return append(append(append(out, ctrl...), diff...), gz(extra)...)
}

func gzipped(t *testing.T, b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(b)
	zw.Close()
	return buf.Bytes()
}

// The updated server does not start: the files before are back and it runs again; not tried again at once.
func TestServerThatDoesNotStartGoesBack(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil || runtime.GOOS == "windows" {
		t.Skip("no node")
	}
	f, pub, priv := lanOffice(t)
	u, s := lanCompanion(t, pub)
	standby = s
	good := `require('http').createServer((q,r)=>r.end('{}')).listen(process.env.PORT,'127.0.0.1')`
	os.WriteFile(filepath.Join(u.root, "server/backend/server.js"), []byte(good), 0o644)
	os.WriteFile(serverNode(u.root), []byte("#!/bin/sh\nexec "+node+" \"$@\"\n"), 0o755)
	os.Chmod(serverNode(u.root), 0o755)
	os.WriteFile(filepath.Join(fullData(u.root), "sync-id.json"), []byte(`{"pc_id":"aaaaaaaaaaaa","slot":2,"joined_main":"bbbbbbbbbbbb"}`), 0o600)
	old := serverWaits
	serverWaits = 5 * time.Second
	defer func() {
		serverWaits = old
		s.stopFull()
		if s.office != nil {
			s.office.Close()
		}
	}()
	answers := func() bool {
		for i := 0; i < 60; i++ {
			if ownAnswers() {
				return true
			}
			time.Sleep(100 * time.Millisecond)
		}
		return false
	}
	if err := s.startFull(); err != nil || !answers() {
		t.Fatalf("the server of the test did not start: %v", err)
	}
	files := serverFiles("new")
	files["adal-keep-backend/server.js"] = "process.exit(1)"
	f.run(t, priv, strings.Repeat("a", 40), "2026-11-25T10:00:00Z", files, nil)
	if err := u.fromLan(); err == nil || !strings.Contains(err.Error(), "files before are back") {
		t.Fatal(err)
	}
	if at(u, "server/backend/server.js") != good || at(u, "server/backend/src/a.js") != serverFiles("old")["adal-keep-backend/src/a.js"] || at(u, "server/backend/data/data.sqlite") != "the girls" {
		t.Fatal("not put back")
	}
	f.sent = 0
	if err := u.fromLan(); err != nil || f.sent != 0 {
		t.Fatalf("tried again at once (%d bytes, %v)", f.sent, err)
	}
	// The next release is taken, and the server (started again by fullLoop) runs with it.
	if err := s.startFull(); err != nil || !answers() {
		t.Fatal("the files before do not run")
	}
	files["adal-keep-backend/server.js"] = good + " // next"
	f.run(t, priv, strings.Repeat("b", 40), "2026-11-25T11:00:00Z", files, nil)
	if err := u.fromLan(); err != nil {
		t.Fatal(err)
	}
	if !answers() || !strings.HasSuffix(at(u, "server/backend/server.js"), "// next") {
		t.Fatal("the next release is not in place")
	}
}

// TestLanLive (ADAL_LAN_E2E="<main url> <public key pem> <root>"): a real server's routes and a real build.
func TestLanLive(t *testing.T) {
	v := strings.Fields(os.Getenv("ADAL_LAN_E2E"))
	if len(v) != 3 {
		t.Skip("set ADAL_LAN_E2E")
	}
	_, _, _ = lanOffice(t)
	pem, _ := os.ReadFile(v[1])
	hostServer = v[0]
	u := newUpdater(v[2])
	u.key, u.built = mustPublicKey(string(pem)), nil
	s := &standbyRunner{root: v[2], peers: map[string]standbyPeer{}}
	standby = s
	n := lanBytes.Load()
	err := u.fromLan()
	t.Logf("%s: %d bytes (read), server %s, %v", v[2], lanBytes.Load()-n, readServerMark(v[2]).Short, err)
	if err != nil {
		t.Fatal(err)
	}
}

func TestWaitsForRuns(t *testing.T) {
	mainRuns.Store(1)
	defer mainRuns.Store(0)
	q := make(chan struct{})
	close(q)
	if waitForRuns(q) {
		t.Fatal("did not wait for a run")
	}
	mainRuns.Store(0)
	if !waitForRuns(nil) {
		t.Fatal("no run")
	}
}
