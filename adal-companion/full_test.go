package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The window follows the main PC, and this PC's own copy only once it is switched to it;
// the copy counts as joined only when its server says so (sync-id.json).
func TestFullCopyWindowAndJoined(t *testing.T) {
	root := t.TempDir()
	old := hostServer
	hostServer = "http://192.168.1.4:4000/"
	t.Cleanup(func() { hostServer = old; usingOwn = false })
	if got := windowHost(); got != "http://192.168.1.4:4000" {
		t.Fatalf("window: %q", got)
	}
	usingOwn = true
	if got := windowHost(); got != ownServerURL() {
		t.Fatalf("own copy: %q", got)
	}
	if fullJoined(root) {
		t.Fatal("joined with nothing there")
	}
	data := fullData(root)
	os.MkdirAll(data, 0o755)
	os.WriteFile(filepath.Join(data, "sync-id.json"), []byte(`{"pc_id":"aaaaaaaaaaaa","slot":1}`), 0o600)
	if fullJoined(root) {
		t.Fatal("not joined yet (no joined_main)")
	}
	os.WriteFile(filepath.Join(data, "sync-id.json"), []byte(`{"pc_id":"aaaaaaaaaaaa","slot":2,"joined_main":"bbbbbbbbbbbb"}`), 0o600)
	if !fullJoined(root) {
		t.Fatal("joined")
	}
	// No server kept here: the full copy is not wanted (nothing to run).
	s := &standbyRunner{root: root, peers: map[string]standbyPeer{}}
	if s.fullWanted() {
		t.Fatal("wanted without a server")
	}
}

// A newer server put in place keeps this PC's own data and uploads (its full copy).
func TestSwapServerKeepsDataAndUploads(t *testing.T) {
	root := t.TempDir()
	s := &standbyRunner{root: root, peers: map[string]standbyPeer{}}
	cur, nw := serverDir(root), serverDir(root)+".new"
	for _, p := range []string{"backend/data/data.sqlite", "backend/uploads/12/3/a.pdf", "backend/server.js"} {
		os.MkdirAll(filepath.Dir(filepath.Join(cur, p)), 0o755)
		os.WriteFile(filepath.Join(cur, p), []byte("old "+p), 0o644)
	}
	os.MkdirAll(filepath.Join(nw, "backend"), 0o755)
	os.WriteFile(filepath.Join(nw, "backend", "server.js"), []byte("new"), 0o644)
	if err := s.swapServer(); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]string{"backend/data/data.sqlite": "old backend/data/data.sqlite", "backend/uploads/12/3/a.pdf": "old backend/uploads/12/3/a.pdf", "backend/server.js": "new"} {
		if b, _ := os.ReadFile(filepath.Join(cur, p)); string(b) != want {
			t.Fatalf("%s: %q", p, b)
		}
	}
}

// Off unless switched on: nothing kept → off; the main PC's last word is kept.
func TestFullCopyOffByDefault(t *testing.T) {
	root := t.TempDir()
	old := fullCopyEnv
	t.Cleanup(func() { fullCopyEnv = old })
	fullCopyEnv = ""
	if fullCopyAllowed(root) {
		t.Fatal("on by default")
	}
	os.WriteFile(filepath.Join(root, "full-copy.json"), []byte(`{"on":true}`), 0o644)
	if !fullCopyAllowed(root) {
		t.Fatal("the main PC said on")
	}
	fullCopyEnv = "0"
	if fullCopyAllowed(root) {
		t.Fatal("ADAL_FULL_COPY=0 wins")
	}
}
