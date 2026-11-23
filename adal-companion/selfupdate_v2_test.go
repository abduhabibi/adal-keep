package main

import (
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// docs/updates-v2.md §3. The bucket of ("abc123", "agency-1") is 11 in Node too.
func TestRolloutTurn(t *testing.T) {
	if b := rolloutBucket("abc123", "agency-1"); b != 11 {
		t.Fatalf("bucket(abc123, agency-1) = %d, Node says 11", b)
	}
	if rolloutBucket("abc123", "") != 99 {
		t.Fatal("an unknown agency is bucket 99")
	}
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	before, after := "2026-11-23T11:00:00Z", "2026-11-23T13:00:00Z"
	cases := []struct {
		name   string
		r      rollout
		agency string
		want   bool
	}{
		{"test agency at once", rollout{Test: []string{"agency-1"}, PctAt: after, EveryoneAt: after}, "agency-1", true},
		{"not test, nothing reached", rollout{Test: []string{"agency-2"}, Pct: 100, PctAt: after, EveryoneAt: after}, "agency-1", false},
		{"pct reached, bucket 11 < 12", rollout{Pct: 12, PctAt: before, EveryoneAt: after}, "agency-1", true},
		{"pct reached, bucket 11 not < 11", rollout{Pct: 11, PctAt: before, EveryoneAt: after}, "agency-1", false},
		{"pct not reached", rollout{Pct: 100, PctAt: after, EveryoneAt: after}, "agency-1", false},
		{"pct_at exactly now", rollout{Pct: 12, PctAt: "2026-11-23T12:00:00Z", EveryoneAt: after}, "agency-1", true},
		{"unknown agency: bucket 99", rollout{Pct: 99, PctAt: before, EveryoneAt: after}, "", false},
		{"unknown agency, pct 100", rollout{Pct: 100, PctAt: before, EveryoneAt: after}, "", true},
		{"everyone reached", rollout{PctAt: after, EveryoneAt: before}, "agency-9", true},
		{"stopped beats everything", rollout{Stopped: true, Test: []string{"agency-1"}, Pct: 100, PctAt: before, EveryoneAt: before}, "agency-1", false},
		{"no times at all", rollout{Pct: 100}, "agency-1", false},
	}
	for _, c := range cases {
		r := c.r
		m := &releaseManifest{SHA: "abc123", EveryoneAt: before, Rollout: &r} // the old fields are ignored with a rollout
		if got := itsTurn(m, c.agency, now); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	// No rollout: the old rule.
	if !itsTurn(&releaseManifest{SHA: "abc123", EveryoneAt: before}, "x", now) || itsTurn(&releaseManifest{SHA: "abc123", EveryoneAt: after}, "x", now) {
		t.Fatal("old rule")
	}
}

func gzBytes(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(b)
	zw.Close()
	return buf.Bytes()
}

func readDelta(t *testing.T, n string) []byte {
	b, err := os.ReadFile("testdata/delta/" + n)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A Supabase that counts what it hands out.
type countingCloud struct {
	srv    *httptest.Server
	mu     sync.Mutex
	asked  map[string]int
	byFile map[string][]byte
	env    envelope
}

func newCountingCloud(t *testing.T, env envelope, byFile map[string][]byte) *countingCloud {
	c := &countingCloud{asked: map[string]int{}, byFile: byFile, env: env}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/auth/v1/token"):
			w.Write([]byte(`{"access_token":"t"}`))
		case r.URL.Path == "/storage/v1/object/authenticated/adal-updates/release/latest.json":
			json.NewEncoder(w).Encode(c.env)
		default:
			name := strings.TrimPrefix(r.URL.Path, "/storage/v1/object/authenticated/adal-updates/")
			b, ok := c.byFile[name]
			if !ok {
				http.NotFound(w, r)
				return
			}
			c.mu.Lock()
			c.asked[name]++
			c.mu.Unlock()
			http.ServeContent(w, r, "x", time.Time{}, bytes.NewReader(b))
		}
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *countingCloud) was(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.asked[name] > 0
}

type deltaSet struct {
	envA, envB       envelope
	piecesA          map[string][]byte // what a PC on release A keeps
	byFile           map[string][]byte // release B in Supabase
	app, prog, pages []byte            // release B, whole (app and pages as plain .tar)
	patchSHAs        []string
	pagesGzB         []byte
}

// Release A, then release B with patches from A for the app, the Companion and the pages.
func deltaReleases(t *testing.T, priv ed25519.PrivateKey) deltaSet {
	appA, appB := readDelta(t, "text.old"), readDelta(t, "text.new")
	progA, progB := readDelta(t, "small.old"), readDelta(t, "small.new")
	pagesA, pagesB := readDelta(t, "pages.old"), readDelta(t, "pages.new")
	appP, progP, pagesP := readDelta(t, "text.adalpatch"), readDelta(t, "small.adalpatch"), readDelta(t, "pages.adalpatch")
	appGzA, appGzB, pagesGzA, pagesGzB := gzBytes(appA), gzBytes(appB), gzBytes(pagesA), gzBytes(pagesB)
	a, b := strings.Repeat("a", 40), strings.Repeat("b", 40)
	envA := sign(t, priv, map[string]any{
		"sha": a, "short": a[:7], "seq": 1, "published_at": "2026-11-23T08:00:00Z", "file": "release/a.tar.gz", "sha256": sum(appGzA),
		"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/a", "sha256": sum(progA)}},
		"online":   map[string]any{"file": "online/a.tar.gz", "sha256": sum(pagesGzA)},
	})
	envB := sign(t, priv, map[string]any{
		"sha": b, "short": b[:7], "seq": 2, "published_at": "2026-11-23T09:00:00Z", "file": "release/b.tar.gz", "sha256": sum(appGzB),
		"app_delta": map[string]any{
			"raw":   map[string]any{"sha256": sum(appB), "size": len(appB)},
			"patch": map[string]any{"from": sum(appA), "from_gz": sum(appGzA), "file": "release/patches/app.adalpatch", "sha256": sum(appP), "size": len(appP)},
		},
		"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/b", "sha256": sum(progB),
			"patch": map[string]any{"from": sum(progA), "file": "programs/patches/c.adalpatch", "sha256": sum(progP)}}},
		"online": map[string]any{"file": "online/b.tar.gz", "sha256": sum(pagesGzB),
			"raw":   map[string]any{"sha256": sum(pagesB)},
			"patch": map[string]any{"from": sum(pagesA), "from_gz": sum(pagesGzA), "file": "online/patches/p.adalpatch", "sha256": sum(pagesP)}},
	})
	return deltaSet{
		envA: envA, envB: envB,
		piecesA: map[string][]byte{sum(appGzA): appGzA, sum(progA): progA, sum(pagesGzA): pagesGzA},
		byFile: map[string][]byte{"release/b.tar.gz": appGzB, "programs/b": progB, "online/b.tar.gz": pagesGzB,
			"release/patches/app.adalpatch": appP, "programs/patches/c.adalpatch": progP, "online/patches/p.adalpatch": pagesP},
		app: appB, prog: progB, pages: pagesB, pagesGzB: pagesGzB,
		patchSHAs: []string{sum(appP), sum(progP), sum(pagesP)},
	}
}

// A Companion on release A (its program and pages installed, A's pieces kept).
func companionOnA(t *testing.T, pub ed25519.PublicKey, d deltaSet, cloud *countingCloud) *updater {
	b := companionPC(t, pub)
	os.WriteFile(filepath.Join(b.root, "adal-companion.exe"), readDelta(t, "small.old"), 0o755)
	os.MkdirAll(b.files(), 0o755)
	for sha, p := range d.piecesA {
		os.WriteFile(filepath.Join(b.files(), sha), p, 0o644)
	}
	ea, _ := json.Marshal(d.envA)
	os.WriteFile(b.currentFile(), ea, 0o644)
	cj, _ := json.Marshal(cloudCreds{URL: cloud.srv.URL, Anon: "anon", Email: "c@x", Password: "p"})
	os.WriteFile(filepath.Join(b.root, "companion-cloud.json"), cj, 0o600)
	return b
}

// From Supabase only the patches come; the pieces are rebuilt, checked, installed,
// kept (and A's pieces too, the base of the next patch).
func TestUpdateByPatches(t *testing.T) {
	fastDownloads(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	d := deltaReleases(t, priv)
	cloud := newCountingCloud(t, d.envB, d.byFile)
	b := companionOnA(t, pub, d, cloud)
	if err := b.fromCloud(); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); !bytes.Equal(got, d.prog) {
		t.Fatal("program not rebuilt from its patch")
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "online", "index.html")); string(got) != strings.Repeat("new pages ", 30) {
		t.Fatalf("pages from the plain .tar: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "online", "config.js")); !strings.Contains(string(got), "ADAL_CLOUD_CONFIG") {
		t.Fatal("config.js lost")
	}
	// The app is the main PC's: a Companion never downloads it (nothing to hand on since 2026-11-23).
	if cloud.was("release/b.tar.gz") || cloud.was("release/patches/app.adalpatch") {
		t.Fatal("a Companion downloaded the app")
	}
	for _, f := range []string{"programs/b", "online/b.tar.gz"} {
		if cloud.was(f) {
			t.Fatalf("%s downloaded whole although a patch was there", f)
		}
	}
	for sha := range d.piecesA {
		if b.piecePath(sha) == "" {
			t.Fatalf("a piece of the release before (%s) was removed", sha[:8])
		}
	}
}

// No base here, or ADAL_DELTA=0: the whole pieces, as before.
func TestPatchFallsBackToWholePieces(t *testing.T) {
	fastDownloads(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	d := deltaReleases(t, priv)
	for _, mode := range []string{"no base", "ADAL_DELTA=0"} {
		cloud := newCountingCloud(t, d.envB, d.byFile)
		b := companionOnA(t, pub, d, cloud)
		if mode == "no base" {
			os.RemoveAll(b.files())
			os.Remove(b.currentFile())
			os.WriteFile(filepath.Join(b.root, "adal-companion.exe"), []byte("some other build"), 0o755)
		} else {
			t.Setenv("ADAL_DELTA", "0")
		}
		if err := b.fromCloud(); err != nil {
			t.Fatal(mode, err)
		}
		if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); !bytes.Equal(got, d.prog) {
			t.Fatal(mode, "program")
		}
		if got, _ := os.ReadFile(filepath.Join(b.root, "online", "index.html")); string(got) != strings.Repeat("new pages ", 30) {
			t.Fatal(mode, "pages")
		}
		if !cloud.was("programs/b") || !cloud.was("online/b.tar.gz") {
			t.Fatal(mode, "the whole pieces were not downloaded")
		}
	}
}

// A patch whose result is not the signed piece is never used.
func TestWrongPatchResultRefused(t *testing.T) {
	fastDownloads(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	d := deltaReleases(t, priv)
	// The program's patch is signed, but makes another file (small.adalpatch applied to text.old).
	cloud := newCountingCloud(t, d.envB, d.byFile)
	b := companionOnA(t, pub, d, cloud)
	m, _ := verifyRelease(d.envB, pub)
	p := m.Programs[0]
	os.WriteFile(filepath.Join(b.root, "adal-companion.exe"), readDelta(t, "text.old"), 0o755)
	p.Patch = &patchForm{From: sum(readDelta(t, "text.old")), File: "programs/patches/c.adalpatch", SHA256: p.Patch.SHA256}
	got, err := b.getPiece(m, p, true)
	if err != nil {
		t.Fatal(err)
	}
	if b2, _ := os.ReadFile(got); !bytes.Equal(b2, d.prog) || !cloud.was("programs/b") {
		t.Fatal("a wrong patch result was kept")
	}
}

// 32-bit Windows: programs_x86, never a 64-bit program; without them the installed one stays.
func TestThirtyTwoBitPrograms(t *testing.T) {
	fastDownloads(t)
	old := is32bit
	t.Cleanup(func() { is32bit = old })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pages := tgz(t, map[string]string{"index.html": "pages"})
	p64, p86 := []byte("companion amd64"), []byte("companion 386")
	mk := func(sha string, seq int64, x86 bool) (envelope, map[string][]byte) {
		man := map[string]any{"sha": sha, "short": sha[:7], "seq": seq, "published_at": "2026-11-23T0" + string(rune('0'+seq)) + ":00:00Z",
			"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/64", "sha256": sum(p64)}},
			"online":   map[string]any{"file": "online/x.tar.gz", "sha256": sum(pages)}}
		pieces := map[string][]byte{sum(p64): p64, sum(pages): pages}
		if x86 {
			man["programs_x86"] = []map[string]any{{"name": "adal-companion.exe", "file": "programs/86", "sha256": sum(p86)}}
			pieces[sum(p86)] = p86
		}
		return sign(t, priv, man), pieces
	}
	env, pieces := mk(strings.Repeat("1", 40), 1, true)
	_, base := holder(t, pub, env, pieces)

	is32bit = func() bool { return true }
	b := companionPC(t, pub)
	if err := fromHere(b, base); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); !bytes.Equal(got, p86) {
		t.Fatalf("32-bit PC got %q", got)
	}
	if b.piecePath(sum(p64)) != "" {
		t.Fatal("a 32-bit PC kept the 64-bit program")
	}
	// A release without 32-bit programs: the installed one stays.
	env2, pieces2 := mk(strings.Repeat("2", 40), 2, false)
	_, base2 := holder(t, pub, env2, pieces2)
	if err := fromHere(b, base2); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); !bytes.Equal(got, p86) {
		t.Fatalf("a 64-bit program went on a 32-bit PC: %q", got)
	}

	// A 64-bit PC: the amd64 program, never the x86 one.
	is32bit = func() bool { return false }
	c := companionPC(t, pub)
	if err := fromHere(c, base); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(c.root, "adal-companion.exe")); !bytes.Equal(got, p64) {
		t.Fatalf("64-bit PC got %q", got)
	}
	if c.piecePath(sum(p86)) != "" {
		t.Fatal("a 64-bit PC fetched the 32-bit program")
	}
}
