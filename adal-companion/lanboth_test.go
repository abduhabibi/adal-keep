package main

// Downloads from Supabase (a fake one here): a full release, Range pieces that
// go on after a cut. (Until 2026-11-23 the office's PCs also handed releases to
// each other; that was removed — every PC updates only from Supabase.)

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
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
	old := dl
	dl.backoff, dl.chunk = 5*time.Millisecond, 7 // tiny pieces: many Range requests
	t.Cleanup(func() { dl = old })
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
