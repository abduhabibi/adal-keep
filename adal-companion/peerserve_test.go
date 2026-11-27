package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// A Companion hands Main only the signed release it keeps, and only pieces that release names.
func TestPeerServesOnlyItsSignedRelease(t *testing.T) {
	f, pub, priv := lanOffice(t)
	u, s := lanCompanion(t, pub)
	standby = s
	prog := []byte("a new companion")
	f.files[sum(prog)] = prog
	f.run(t, priv, strings.Repeat("9", 40), "2026-11-26T10:00:00Z", serverFiles("new"), map[string]any{
		"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/c", "sha256": sum(prog), "size": len(prog)}}})
	if err := u.fromLan(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { updatingNow.Store(false) }) // (a real install restarts the program now)
	srv := httptest.NewServer(u.handler())
	defer srv.Close()
	get := func(p string) (int, []byte) {
		r, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, b
	}
	code, b := get("/peer/release")
	var env envelope
	if code != 200 || json.Unmarshal(b, &env) != nil {
		t.Fatalf("release: %d %s", code, b)
	}
	m, err := verifyRelease(env, pub)
	if err != nil || m.SHA != strings.Repeat("9", 40) {
		t.Fatalf("not the signed release: %v", err)
	}
	served := 0
	for _, p := range allPieces(m) {
		if c, body := get("/peer/file/" + p.SHA256); c == 200 {
			if sum(body) != p.SHA256 {
				t.Fatal("other bytes than the piece")
			}
			served++
		}
	}
	if served == 0 {
		t.Fatal("no piece served")
	}
	if c, _ := get("/peer/file/" + sum([]byte("anything else"))); c != 404 {
		t.Fatal("a file the release does not name was served")
	}
	if c, _ := get("/peer/file/../current.json"); c == 200 {
		t.Fatal("a path was served")
	}
	// A kept release changed by hand: nothing is offered.
	cur, _ := os.ReadFile(u.currentFile())
	os.WriteFile(u.currentFile(), []byte(strings.Replace(string(cur), `"lan":true`, `"lan":false`, 1)), 0o644)
	if c, _ := get("/peer/release"); c != 404 {
		t.Fatal("an unsigned release was offered")
	}
	os.WriteFile(u.currentFile(), cur, 0o644)
	// Off.
	t.Setenv("ADAL_PEER_UPDATES", "0")
	if c, _ := get("/peer/release"); c != 404 {
		t.Fatal("served while off")
	}
}
