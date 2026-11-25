package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A main PC with photos, its change feed, and what it was asked.
type docMain struct {
	mu      sync.Mutex
	files   map[string][]byte // id → bytes
	v       map[string]int
	asked   []string
	bytes   int64
	rev     int
	names   []string
	rows    []map[string]any
	revoked bool
	lie     bool
	seen    int
	slow    time.Duration
}

func (m *docMain) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	slow := m.slow
	m.mu.Unlock()
	time.Sleep(slow)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.asked = append(m.asked, r.URL.Path)
	if m.revoked {
		w.WriteHeader(401)
		io.WriteString(w, `{"pc_access":true}`)
		return
	}
	switch {
	case r.URL.Path == "/api/companion/docs":
		out := map[string]any{"at": fmt.Sprintf("e:%d", m.rev), "names": m.names, "rows": m.rows}
		if !strings.HasPrefix(r.URL.Query().Get("at"), "e:") {
			out = map[string]any{"at": fmt.Sprintf("e:%d", m.rev), "reset": true}
		}
		m.names, m.rows = nil, nil
		json.NewEncoder(w).Encode(out)
	case r.URL.Path == "/api/companion/docs/check":
		w.Write([]byte(`{"differ":[]}`))
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		w.Header().Set("Cache-Control", "public, max-age=1, immutable")
		w.Header().Set("Content-Type", "text/javascript")
		io.WriteString(w, "code()")
	case strings.HasPrefix(r.URL.Path, "/api/files/") || strings.HasPrefix(r.URL.Path, "/api/companion/docs/file/"):
		p := strings.Split(r.URL.Path, "/")
		id := p[len(p)-2]
		b := m.files[id]
		if b == nil {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("x-adal-seen") != "" {
			m.seen++
			w.WriteHeader(204)
			return
		}
		sha := sum256(b)
		if m.lie {
			sha = strings.Repeat("a", 64)
		}
		d, _ := json.Marshal(ownDoc{ID: id, Name: "n" + id, V: fmt.Sprint(m.v[id]), SHA: sha, Size: int64(len(b))})
		w.Header().Set("X-Adal-Doc", base64.StdEncoding.EncodeToString(d))
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b))
		m.bytes += int64(len(b))
	default:
		io.WriteString(w, "other")
	}
}

func (m *docMain) count(sub string) (n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.asked {
		if strings.Contains(a, sub) {
			n++
		}
	}
	return
}

type door struct {
	t    *testing.T
	c    *http.Client
	main string
}

func (d door) get(path, cookie string, h ...string) (int, string, http.Header) {
	d.t.Helper()
	req, _ := http.NewRequest("GET", d.main+path, nil)
	req.Header.Set("Cookie", cookie)
	for i := 0; i+1 < len(h); i += 2 {
		req.Header.Set(h[i], h[i+1])
	}
	resp, err := d.c.Do(req)
	if err != nil {
		d.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	time.Sleep(30 * time.Millisecond) // (kept once it is all here)
	return resp.StatusCode, string(b), resp.Header
}

func ownFixture(t *testing.T) (*docMain, *httptest.Server, *ownStore, door) {
	t.Helper()
	dir := t.TempDir()
	replicaDirFn = func() string { return filepath.Join(dir, "replica") }
	os.MkdirAll(replicaDirFn(), 0o700)
	m := &docMain{files: map[string][]byte{"7": bytes.Repeat([]byte("secret photo "), 3000)}, v: map[string]int{}}
	ts := httptest.NewServer(m)
	was, wasGet, wasSlow := hostServer, lanGet, ownSlow
	hostServer = ts.URL
	lanGet = func(path, etag string, from int64) (*http.Response, error) { return http.Get(ts.URL + path) }
	if err := saveKeys(replicaKeys{Password: "pw-of-the-agency", AccessKey: "k"}); err != nil {
		t.Fatal(err)
	}
	o := newOwnStore()
	ps := httptest.NewServer(o)
	pu, _ := url.Parse(ps.URL)
	t.Cleanup(func() {
		ps.Close()
		ts.Close()
		hostServer, lanGet, ownSlow, replicaDirFn = was, wasGet, wasSlow, defaultReplicaDir
	})
	// (Go never proxies 127.0.0.1 by itself; here it must)
	return m, ts, o, door{t, &http.Client{Transport: &http.Transport{Proxy: func(*http.Request) (*url.URL, error) { return pu, nil }}}, ts.URL}
}

const photo = "/api/files/7/download"

func TestOwnPhotoFromThisDisk(t *testing.T) {
	m, ts, o, d := ownFixture(t)
	if err := o.news(0); err != nil {
		t.Fatal(err)
	}
	_, first, _ := d.get(photo, "adal_pc=a")
	code, again, h := d.get(photo, "adal_pc=a")
	if code != 200 || again != first || h.Get("X-Adal-From") != "disk" || m.count("/files/7") != 1 {
		t.Fatalf("second time: %d %q, Main asked %d times", code, h.Get("X-Adal-From"), m.count("/files/7"))
	}
	if h.Get("Content-Type") != "image/jpeg" || h.Get("X-Adal-Doc") != "" {
		t.Fatal(h)
	}
	if code, b, _ := d.get(photo, "adal_pc=a", "Range", "bytes=7-11"); code != 206 || b != "photo" {
		t.Fatal(code, b)
	}
	// Opening it is in Main's audit list (the part asked by the viewer is not a second one).
	o.tellSeen()
	if m.seen != 1 {
		t.Fatal("seen", m.seen)
	}
	// Locked on this disk, the list too.
	o.save()
	n := 0
	filepath.Walk(ownDir(), func(p string, i os.FileInfo, _ error) error {
		if i != nil && !i.IsDir() {
			n++
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte("secret")) || bytes.Contains(b, []byte("jpeg")) {
				t.Error("readable on disk:", p)
			}
		}
		return nil
	})
	if n != 2 {
		t.Fatal(n, "files")
	}
	// Main off: shown to who Main let in, to nobody else; after a restart of this program too.
	ts.Close()
	o2 := newOwnStore()
	*o = ownStore{client: o2.client, lately: o2.lately, never: o2.never}
	o.news(0)
	if code, b, h := d.get(photo, "adal_pc=a"); code != 200 || b != first || !strings.HasPrefix(h.Get("X-Adal-From"), "disk") {
		t.Fatal("Main off:", code, h)
	}
	if code, _, _ := d.get(photo, "adal_pc=stranger"); code != 502 {
		t.Fatal("a stranger saw it:", code)
	}
}

func TestOwnChangedPhotoComesByItself(t *testing.T) {
	m, _, o, d := ownFixture(t)
	o.news(0)
	d.get(photo, "adal_pc=a")
	m.mu.Lock()
	m.files["7"], m.v["7"], m.names, m.rev = bytes.Repeat([]byte("new "), 2000), 1, []string{"n7"}, 1
	m.mu.Unlock()
	if err := o.news(0); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	o.getMu.Lock() // fetched by now
	o.getMu.Unlock()
	asked := m.count("/api/files/7")
	_, b, h := d.get(photo, "adal_pc=a")
	if !strings.HasPrefix(b, "new ") || h.Get("X-Adal-From") != "disk" || m.count("/api/files/7") != asked {
		t.Fatal(b[:10], h, m.asked)
	}
}

func TestOwnNewPhotoOfAGirlOpenedHere(t *testing.T) {
	m, _, o, d := ownFixture(t)
	o.news(0)
	d.get("/api/profiles/31", "adal_pc=a")
	m.mu.Lock()
	m.files["8"], m.files["9"] = []byte("hers"), []byte("not hers")
	m.rows = []map[string]any{{"id": "8", "profile": 31, "mime": "application/pdf", "size": 4}, {"id": "9", "profile": 32, "mime": "application/pdf", "size": 4}}
	m.mu.Unlock()
	o.news(0)
	time.Sleep(50 * time.Millisecond)
	o.getMu.Lock()
	o.getMu.Unlock()
	if m.count("docs/file/8/") != 1 || m.count("/9/") != 0 {
		t.Fatal(m.asked)
	}
}

func TestOwnWrongHashIsNotKept(t *testing.T) {
	m, _, o, d := ownFixture(t)
	o.news(0)
	m.lie = true
	d.get(photo, "adal_pc=a")
	d.get(photo, "adal_pc=a")
	if m.count("/files/7") != 2 || len(o.ix.Entries) != 0 {
		t.Fatal("kept a file that is not the one described")
	}
	// A damaged one on this disk is never shown: Main is asked again.
	m.lie = false
	d.get(photo, "adal_pc=a")
	p := partFile(ownKey(photo), 0)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	b[len(b)/2] ^= 1
	os.WriteFile(p, b, 0o600)
	if code, got, h := d.get(photo, "adal_pc=a"); code != 200 || h.Get("X-Adal-From") != "" || got != string(m.files["7"]) {
		t.Fatal(code, h)
	}
}

func TestOwnRemovedPCLosesThem(t *testing.T) {
	m, _, o, d := ownFixture(t)
	o.news(0)
	d.get(photo, "adal_pc=a")
	m.revoked = true
	o.news(0)
	if _, err := os.Stat(ownDir()); err == nil {
		t.Fatal("still on the disk")
	}
	if code, _, _ := d.get(photo, "adal_pc=a"); code != 401 {
		t.Fatal(code)
	}
}

func TestOwnBounded(t *testing.T) {
	m, _, o, d := ownFixture(t)
	was := ownMaxMB
	ownMaxMB = 1
	defer func() { ownMaxMB = was }()
	o.news(0)
	for i := 0; i < 5; i++ {
		id := fmt.Sprint(100 + i)
		m.mu.Lock()
		m.files[id] = bytes.Repeat([]byte{byte(i)}, 400<<10)
		m.mu.Unlock()
		d.get("/api/files/"+id+"/download", "adal_pc=a")
		if e := o.ix.Entries["/api/files/"+id+"/download"]; e != nil {
			e.Used -= int64(100 - i)
		}
	}
	if len(o.ix.Entries) != 2 || o.ix.Entries["/api/files/104/download"] == nil {
		t.Fatal(len(o.ix.Entries), "kept")
	}
	f, _ := os.ReadDir(ownDir())
	if len(f) != 2 {
		t.Fatal(len(f), "files")
	}
}

func TestOwnBigOneInParts(t *testing.T) {
	m, _, o, d := ownFixture(t)
	o.news(0)
	m.files["5"] = bytes.Repeat([]byte("0123456789"), 1<<20) // 10 MB
	if err := o.fetchOne("/api/files/5/download"); err != nil {
		t.Fatal(err)
	}
	if m.count("docs/file/5/") != 3 {
		t.Fatal(m.asked)
	}
	d.get(photo, "adal_pc=a") // Main lets this window in
	if _, b, h := d.get("/api/files/5/download", "adal_pc=a"); b != string(m.files["5"]) || h.Get("X-Adal-From") != "disk" {
		t.Fatal(len(b), h)
	}
}

func TestOwnSlowMain(t *testing.T) {
	m, _, o, d := ownFixture(t)
	o.news(0)
	d.get(photo, "adal_pc=a")
	o.fresh = time.Time{} // changes not known
	ownSlow = 100 * time.Millisecond
	m.mu.Lock()
	m.slow = 2 * time.Second
	m.mu.Unlock()
	t0 := time.Now()
	if code, _, h := d.get(photo, "adal_pc=a"); code != 200 || h.Get("X-Adal-From") == "" || time.Since(t0) > time.Second {
		t.Fatal(code, h, time.Since(t0))
	}
}

func TestOwnDoorPassesTheRestOn(t *testing.T) {
	m, _, _, d := ownFixture(t)
	if code, b, _ := d.get("/api/anything", "adal_pc=a"); code != 200 || b != "other" {
		t.Fatal(code, b)
	}
	d.get("/assets/index-abc123.js", "adal_pc=a")
	if _, b, h := d.get("/assets/index-abc123.js", "adal_pc=a"); b != "code()" || h.Get("X-Adal-From") != "disk" || m.count("/assets/") != 1 {
		t.Fatal(b, h, m.asked)
	}
}
