package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A piece made by Node (services/replicaDelta.js) and the changes Node made of it.
func TestChangedFramesMadeByNode(t *testing.T) {
	read := func(n string) []byte {
		b, err := os.ReadFile("testdata/replica/" + n + ".bin")
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	old, sub, want := read("old"), read("sub"), read("new")
	frames := splitFrames(old)
	if len(frames) != 8 || !bytes.Equal(joinFrames(frames), old) {
		t.Fatalf("%d frames", len(frames))
	}
	got, err := applySub(frames, sub)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatal("not Node's piece", err)
	}
	if len(sub) > len(old)*2/3 {
		t.Fatalf("changes %d of %d bytes", len(sub), len(old))
	}
	// Damaged, cut, or for another piece: refused.
	for _, bad := range [][]byte{sub[:20], sub[:len(sub)-3], append(append([]byte{}, sub[:len(sub)-1]...), sub[len(sub)-1]^1), []byte("ADALSUB1\xff\xff\xff\xff")} {
		if _, err := applySub(frames, bad); err == nil {
			t.Fatal("a damaged one was taken")
		}
	}
	frames[0] = []byte("another")
	if _, err := applySub(frames, sub); err == nil {
		t.Fatal("changes of another piece were taken")
	}
	if splitFrames([]byte("an older piece")) != nil || splitFrames(old[:len(old)-4]) != nil {
		t.Fatal("an older piece has no frames")
	}
}

// v2Main: a main PC with replicaDelta.js: chunks of frames, lists by what changed.
type v2Main struct {
	snap    string
	chunks  [][][]byte // chunk → frames
	sums    []string
	was     map[string][][]byte // "i-sum" → frames
	docs    map[string][]byte
	docsAt  string
	docsSet []map[string]any
	gone    []string
	bytes   map[string]int
	busy    int
	asked   []string
}

func (f *v2Main) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const pw = "key-123"
	f.asked = append(f.asked, r.URL.RequestURI())
	send := func(what string, b []byte) { f.bytes[what] += len(b); w.Write(b) }
	q := r.URL.Query()
	switch {
	case r.URL.Path == "/api/replica/keys":
		fmt.Fprintf(w, `{"password":%q,"bot_token":"B","chat_id":"-1"}`, pw)
	case r.URL.Path == "/api/replica/report":
		f.bytes["report"]++
		fmt.Fprint(w, `{"ok":true}`)
	case r.URL.Path == "/api/replica/manifest":
		m := map[string]any{"v": 2, "pc_number": "47040", "made": "2026-11-25T07:00:00Z", "snap": f.snap, "docs_at": f.docsAt}
		db := map[string]any{"length": 10, "chunk": 10, "z": "zstd"}
		if q.Get("have") == f.snap {
			m["same_db"] = true
		} else if q.Get("have") == "s1" {
			set := map[string]string{}
			for i, s := range f.sums {
				if f.was[fmt.Sprintf("%d-%s", i, s)] == nil || !strings.HasSuffix(s, "0") {
					set[fmt.Sprint(i)] = s
				}
			}
			db["n"], db["set"], db["from"] = len(f.sums), set, "s1"
			m["db"] = db
		} else {
			db["chunks"] = f.sums
			m["db"] = db
		}
		if q.Get("docs") == f.docsAt {
			m["same_docs"] = true
		} else if q.Get("docs") != "" && f.docsSet != nil {
			m["docs_set"], m["docs_gone"] = f.docsSet, f.gone
		} else {
			var l []map[string]any
			for n, b := range f.docs {
				l = append(l, map[string]any{"name": n, "size": len(b), "sum": fmt.Sprintf("%x", len(b)), "parts": 1})
			}
			m["docs"] = l
		}
		b, _ := json.Marshal(m)
		send("manifest", b)
	case strings.HasPrefix(r.URL.Path, "/api/replica/db/"):
		if f.busy > 0 {
			f.busy--
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(503)
			return
		}
		var i int
		fmt.Sscanf(r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:], "%d", &i)
		frames := f.chunks[i]
		plain := joinFrames(frames)
		if base := f.was[fmt.Sprintf("%d-%s", i, q.Get("base"))]; q.Get("base") != "" && base != nil {
			var set [][2]int
			var body []byte
			for k, fr := range frames {
				if k >= len(base) || !bytes.Equal(base[k], fr) {
					set = append(set, [2]int{k, len(fr)})
					body = append(body, fr...)
				}
			}
			h, _ := json.Marshal(map[string]any{"n": len(frames), "sha256": sum(plain), "set": set})
			plain = append(append([]byte("ADALSUB1"), 0, 0, byte(len(h)>>8), byte(len(h))), append(h, body...)...)
		}
		b, _ := lockPiece(plain, pw)
		send("db", b)
	case strings.HasPrefix(r.URL.Path, "/api/replica/doc/"):
		b, _ := lockPiece(f.docs[q.Get("name")], pw)
		send("doc", b)
	default:
		http.NotFound(w, r)
	}
}

func frame(s string) []byte { return bytes.Repeat([]byte(s), 2000) }

func newV2Main() *v2Main {
	f := &v2Main{snap: "s1", docsAt: "e:1", docs: map[string][]byte{"a.jpg": []byte("photo a"), "b.jpg": []byte("photo number b")}, bytes: map[string]int{}, was: map[string][][]byte{}}
	for i := 0; i < 3; i++ {
		var c [][]byte
		for k := 0; k < 64; k++ {
			c = append(c, frame(fmt.Sprintf("%d.%d ", i, k)))
		}
		f.chunks = append(f.chunks, c)
		f.sums = append(f.sums, fmt.Sprintf("%019x0", i))
		f.was[fmt.Sprintf("%d-%s", i, f.sums[i])] = c
	}
	return f
}

func v2Office(t *testing.T) *v2Main {
	withTemp(t)
	t.Setenv("ADAL_PC_NUMBER", "47040")
	f := newV2Main()
	srv := httptest.NewServer(f)
	k := loadKeys()
	k.AccessKey = "k1"
	saveKeys(k)
	oh, oc, ow, op := hostServer, clientName, busyWait, peerWait
	hostServer, clientName, busyWait, peerWait = srv.URL, "Reception", time.Millisecond, time.Millisecond
	t.Cleanup(func() { srv.Close(); hostServer, clientName, busyWait, peerWait = oh, oc, ow, op; officePeers = nil })
	return f
}

func TestOneRowChangedSendsAFewKB(t *testing.T) {
	f := v2Office(t)
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	first := f.bytes["db"]
	// Nothing changed: one short answer, nothing else asked.
	f.bytes, f.asked = map[string]int{}, nil
	for i := 0; i < 5; i++ {
		if err := syncReplica(); err != nil {
			t.Fatal(err)
		}
	}
	if f.bytes["db"] != 0 || f.bytes["manifest"] > 5*200 {
		t.Fatalf("idle: %v", f.bytes)
	}
	// One row: one frame of two chunks; one photo changed, one deleted.
	f.snap = "s2"
	for _, i := range []int{0, 2} {
		c := append([][]byte{}, f.chunks[i]...)
		c[7] = frame("changed ")
		f.chunks[i] = c
		f.sums[i] = fmt.Sprintf("%019x1", i)
		f.was[fmt.Sprintf("%d-%s", i, f.sums[i])] = c
	}
	f.docsAt, f.docs["c.jpg"] = "e:3", []byte("a new photo of hers")
	f.docsSet = []map[string]any{{"name": "c.jpg", "size": 19, "sum": "13", "parts": 1}}
	f.gone = []string{"a.jpg"}
	f.bytes, f.busy = map[string]int{}, 2 // busy twice: asked again, not given up
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	t.Logf("first %d bytes; one row and one photo: %v", first, f.bytes)
	if f.bytes["db"] > 2*(16<<10+1000) {
		t.Fatalf("one row sent %d bytes", f.bytes["db"])
	}
	st := loadState()
	if len(st.Docs) != 2 || st.DB.Chunks[2] != f.sums[2] || st.DB.Chunks[1] != f.sums[1] {
		t.Fatalf("%+v", st)
	}
	// The copy is exactly Main's, locked.
	for i := range f.chunks {
		b, _ := os.ReadFile(filepath.Join(piecesDir(), dbPieceName(i, f.sums[i])))
		plain, err := unlockPiece(b, "key-123")
		if err != nil || !bytes.Equal(plain, joinFrames(f.chunks[i])) || bytes.Contains(b, []byte("changed")) {
			t.Fatalf("chunk %d: %v", i, err)
		}
	}
	// A piece of an older program here (no frames): the whole piece comes.
	b, _ := lockPiece([]byte("one zstd frame of an older main PC"), "key-123")
	os.WriteFile(filepath.Join(piecesDir(), dbPieceName(1, f.sums[1])), b, 0o600)
	f.snap, f.chunks[1], f.sums[1] = "s3", f.chunks[0], fmt.Sprintf("%020x", 99)
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(piecesDir(), dbPieceName(1, f.sums[1])))
	if plain, err := unlockPiece(b, "key-123"); err != nil || !bytes.Equal(plain, joinFrames(f.chunks[1])) {
		t.Fatal("not whole", err)
	}
}

// The second Companion takes whole pieces and documents from the first, named by Main — also with its own server off.
func TestSecondCompanionAsksTheFirst(t *testing.T) {
	f := v2Office(t)
	if standby != nil {
		t.Fatal("the test needs this PC's server off")
	}
	served := 0
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/replica/piece/") || r.Header.Get("x-adal-number") == "" {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/replica/piece/")
		for i, c := range f.chunks {
			if name == dbPieceName(i, f.sums[i]) {
				b, _ := lockPiece(joinFrames(c), "key-123")
				if i == 1 {
					b, _ = lockPiece(joinFrames(c), "another agency's key")
				}
				served++
				w.Write(b)
				return
			}
		}
		for n, d := range f.docs {
			if name == docPieceName(rpDoc{Name: n, Sum: fmt.Sprintf("%x", len(d))}, 0) {
				b, _ := lockPiece(d, "key-123")
				served++
				w.Write(b)
				return
			}
		}
		http.NotFound(w, r)
	}))
	defer first.Close()
	var port int
	fmt.Sscanf(first.URL[strings.LastIndex(first.URL, ":")+1:], "%d", &port)
	officePeers = []officePeer{{Name: "Aaa first", IP: "127.0.0.1", Port: port}}
	if firstOfOffice() {
		t.Fatal("not the first")
	}
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	if f.bytes["doc"] != 0 || served != 5 {
		t.Fatalf("from Main %v, from the first %d", f.bytes, served)
	}
	if f.bytes["db"] > 2*len(joinFrames(f.chunks[1])) {
		t.Fatalf("only the piece with another key comes from Main: %v", f.bytes)
	}
	if st := loadState(); len(st.Docs) != 2 {
		t.Fatal("documents")
	}
}

func TestOldMainAsBefore(t *testing.T) {
	v2Office(t)
	f := &fakeMain{chunks: [][]byte{[]byte("SQLi"), []byte("te f")}, docs: map[string][]byte{"p.jpg": []byte("p")}, asked: map[string]int{}, password: "key-123"}
	m := httptest.NewServer(f.handler(t))
	defer m.Close()
	hostServer = m.URL
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	if st := loadState(); len(st.DB.Chunks) != 2 || len(st.Docs) != 1 {
		t.Fatalf("%+v", st)
	}
}
