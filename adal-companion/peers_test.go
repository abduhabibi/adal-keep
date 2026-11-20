package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A Companion with no copy, the main PC off: it takes the newest copy of the
// office from another Companion, piece by piece; a wrong number gets nothing.
func TestCopyFromAnotherCompanion(t *testing.T) {
	withTemp(t)
	t.Setenv("ADAL_PC_NUMBER", "47040")
	pieces := map[string]string{
		dbPieceName(0, "aaa"):                      "DB0",
		dbPieceName(1, "bbb"):                      "DB1",
		docPieceName(rpDoc{Name: "p.jpg", Sum: "s1", Parts: 1}, 0): "DOC",
	}
	state := copyState{PCNumber: "47040", Made: "2026-11-20T09:00:00Z",
		DB: rpDB{Length: 6, Chunk: 3, Chunks: []string{"aaa", "bbb"}}, Docs: []rpDoc{{Name: "p.jpg", Sum: "s1", Parts: 1}}}
	asked := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-adal-number") != "47040" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		switch {
		case r.URL.Path == "/replica/info":
			json.NewEncoder(w).Encode(map[string]string{"made": state.Made})
		case r.URL.Path == "/replica/state":
			json.NewEncoder(w).Encode(state)
		case strings.HasPrefix(r.URL.Path, "/replica/piece/"):
			asked++
			if b, ok := pieces[strings.TrimPrefix(r.URL.Path, "/replica/piece/")]; ok {
				w.Write([]byte(b))
				return
			}
			http.NotFound(w, r)
		}
	}))
	defer peer.Close()
	// The peer heard on the network (standby.go keeps its address).
	host := strings.TrimPrefix(peer.URL, "http://")
	addr, port, _ := strings.Cut(host, ":")
	oldPort := lanHTTPPort
	lanHTTPPort = atoiOr(port, 0)
	defer func() { lanHTTPPort = oldPort; standby = nil }()
	standby = &standbyRunner{root: t.TempDir(), peers: map[string]standbyPeer{"p1": {addr: addr, id: "p1", at: time.Now()}}}

	if err := syncFromPeers(); err != nil {
		t.Fatal(err)
	}
	st := loadState()
	if st.Made != state.Made || len(st.DB.Chunks) != 2 || len(st.Docs) != 1 {
		t.Fatalf("copy not taken: %+v", st)
	}
	for name, body := range pieces {
		b, err := os.ReadFile(filepath.Join(piecesDir(), name))
		if err != nil || string(b) != body {
			t.Fatalf("piece %s: %q %v", name, b, err)
		}
	}
	// Up to date: nothing asked again.
	before := asked
	if err := syncFromPeers(); err != nil {
		t.Fatal(err)
	}
	if asked != before {
		t.Fatalf("asked %d pieces again", asked-before)
	}
	// A piece the peer has is taken from it before the main PC.
	if !pieceFromPeers(dbPieceName(0, "aaa"), peerBases()) {
		t.Fatal("a piece the other Companion has was not taken from it")
	}
	// Another agency's number: nothing.
	t.Setenv("ADAL_PC_NUMBER", "11111")
	if pieceFromPeers(dbPieceName(1, "bbb"), peerBases()) {
		t.Fatal("a piece given for another agency's number")
	}
}

func atoiOr(s string, d int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return d
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// TestLearnNumberLive (ADAL_LEARN_E2E=<install folder>): the main PC's number
// is read from the agency's online copy with that folder's online account
// (kept only in this test's temporary place).
func TestLearnNumberLive(t *testing.T) {
	root := os.Getenv("ADAL_LEARN_E2E")
	if root == "" {
		t.Skip("set ADAL_LEARN_E2E")
	}
	withTemp(t)
	n := learnNumberOnline(root)
	if len(n) != 5 {
		t.Fatalf("no number learned (%q)", n)
	}
	if loadIdentity().Number != n {
		t.Fatal("not kept")
	}
	t.Logf("number learned: %s***", n[:2])
}
