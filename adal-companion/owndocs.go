// owndocs.go — the photos and documents the people at this PC use are kept on its own disk, and shown
// from there (the owner, 2026-11-25; Main hangs on a Wi-Fi stick: about 415 KB/s for everybody).
//
//   - The window (AdalKeep.exe) asks everything of Main through this program (an http proxy on
//     127.0.0.1 only; with this program away the window goes to Main directly, Chromium's own
//     fallback). Everything is handed on as it is, but the photos, the documents and the pages' own
//     code (/assets, names with a fingerprint): from this disk when they are here and not changed.
//   - Not changed: Main says what changes (one open question, backend services/docFeed.js). Main slow
//     or off: what is here is shown as it was.
//   - Kept as they come, whole, checked by SHA-256, in parts of 4 MB, LOCKED with the agency's key like
//     the locked copy (replica.go), and their list too. At most ADAL_OWN_DOCS_MB (1024) or a tenth of
//     the free disk; the ones used longest ago go first.
//   - A new or changed photo of a girl opened here lately comes by itself.
//   - Shown only to who Main answered before with the same key and sign-in; this PC removed or
//     suspended on Main: all of it is deleted. Opening a document is in Main's audit list as ever.
//   - Works with this PC's own server off (ADAL_STANDBY=0).
//
// Off: ADAL_OWN_DOCS=0 (the window then goes to Main directly).
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ownPart    = 4 << 20
	ownMaxFile = 64 << 20
	ownKeepFor = 90 * 24 * time.Hour
	whoFor     = 30 * 24 * time.Hour
)

var (
	ownPort   = envInt("ADAL_OWN_PORT", 47812) // also in adal-launcher owndoor.go
	ownMaxMB  = envInt("ADAL_OWN_DOCS_MB", 1024)
	docPath   = regexp.MustCompile(`^/api/files/([0-9a-zA-Z_-]{1,40})/(download|thumbnail)$`)
	assetPath = regexp.MustCompile(`^/assets/[\w.\-]{1,200}$`)
	girlPath  = regexp.MustCompile(`^/api/profiles/(\d{1,20})$`)
	own       *ownStore
	// As a window has it: nothing waits forever on a connection, an answer may take its time.
	ownTransport = &http.Transport{DialContext: (&net.Dialer{Timeout: 4 * time.Second, KeepAlive: 30 * time.Second}).DialContext, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second, DisableCompression: true}
	ownSlow      = 4 * time.Second // a photo that is here too: Main has this long to answer
)

func ownDocsOn() bool { return os.Getenv("ADAL_OWN_DOCS") != "0" }

type ownDoc struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	V    string `json:"v"`
	SHA  string `json:"sha"`
	Size int64  `json:"size"`
}

type ownEntry struct {
	Doc  ownDoc            `json:"doc"`
	Hdr  map[string]string `json:"hdr"`
	Size int64             `json:"size"`
	Used int64             `json:"used"`
	Old  bool              `json:"old,omitempty"` // changed on Main: only shown while Main does not answer
}

type ownIndex struct {
	Number  string               `json:"number"`
	At      string               `json:"at"` // up to where Main's changes are known
	Entries map[string]*ownEntry `json:"entries"`
	Girls   map[string]int64     `json:"girls"` // opened here: profile → when
	Who     map[string]int64     `json:"who"`   // the key and sign-in Main answered (hashed) → when
	Seen    []ownSeen            `json:"seen,omitempty"`
}

type ownSeen struct {
	Path string            `json:"path"`
	Hdr  map[string]string `json:"hdr"`
}

type ownStore struct {
	mu     sync.Mutex
	ix     ownIndex
	loaded bool
	dirty  bool
	fresh  time.Time            // Main's changes are known up to now
	away   bool                 // Main did not answer the last question
	lately map[string]time.Time // changed lately (by name and by id)
	never  map[string]bool      // Main does not say what it is: not kept, asked as the window asks it
	hits   int64
	saved  int64 // bytes not asked of Main
	getMu  sync.Mutex
	client *http.Client
}

func ownDir() string { return filepath.Join(replicaDirFn(), "own") }

func newOwnStore() *ownStore {
	return &ownStore{lately: map[string]time.Time{}, never: map[string]bool{}, client: &http.Client{Transport: ownTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func ownKey(path string) string { h := sha256.Sum256([]byte(path)); return hex.EncodeToString(h[:16]) }

// load: the list (locked); another agency's main PC: all of it goes.
func (o *ownStore) load() string {
	pw := loadKeys().Password
	if o.loaded || pw == "" {
		return pw
	}
	o.loaded = true
	o.ix = ownIndex{}
	if b, err := os.ReadFile(filepath.Join(ownDir(), "index.bin")); err == nil {
		if plain, err := unlockPiece(b, pw); err == nil {
			json.Unmarshal(plain, &o.ix)
		}
	}
	if n := mainNumber(); o.ix.Number != "" && n != "" && o.ix.Number != n {
		os.RemoveAll(ownDir())
		o.ix = ownIndex{}
	}
	o.ix.Number = mainNumber()
	if o.ix.Entries == nil {
		o.ix.Entries = map[string]*ownEntry{}
	}
	if o.ix.Girls == nil {
		o.ix.Girls = map[string]int64{}
	}
	if o.ix.Who == nil {
		o.ix.Who = map[string]int64{}
	}
	return pw
}

func (o *ownStore) save() {
	o.mu.Lock()
	defer o.mu.Unlock()
	pw := o.load()
	if !o.dirty || pw == "" {
		return
	}
	b, _ := json.Marshal(o.ix)
	if locked, err := lockPiece(b, pw); err == nil {
		os.MkdirAll(ownDir(), 0o700)
		if writeAtomic(filepath.Join(ownDir(), "index.bin"), locked, 0o600) == nil {
			o.dirty = false
		}
	}
}

// wipe: this PC was removed or suspended on Main, or signed out.
func (o *ownStore) wipe(why string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.ix.Entries) > 0 {
		log.Printf("🖼 The photos and documents kept here are deleted: %s", why)
	}
	os.RemoveAll(ownDir())
	o.ix, o.loaded, o.dirty = ownIndex{}, false, false
}

func partFile(key string, k int) string {
	return filepath.Join(ownDir(), fmt.Sprintf("%s-%d.bin", key, k))
}

func partsOf(size int64) int {
	if size <= 0 {
		return 1
	}
	return int((size + ownPart - 1) / ownPart)
}

// read: the whole file as Main sent it, checked.
func (o *ownStore) read(key string, e *ownEntry, pw string) ([]byte, error) {
	out := make([]byte, 0, e.Size)
	for k := 0; k < partsOf(e.Size); k++ {
		b, err := os.ReadFile(partFile(key, k))
		if err != nil {
			return nil, err
		}
		p, err := unlockPiece(b, pw)
		if err != nil {
			return nil, err
		}
		out = append(out, p...)
	}
	if sum256(out) != e.Doc.SHA {
		return nil, errors.New("damaged")
	}
	return out, nil
}

// keep: a whole answer of Main, locked, its SHA-256 the one Main said.
func (o *ownStore) keep(path string, doc ownDoc, hdr map[string]string, body []byte, asked time.Time) error {
	if int64(len(body)) != doc.Size || sum256(body) != doc.SHA {
		return errors.New("not the file the main PC described")
	}
	o.mu.Lock()
	pw := o.load()
	o.mu.Unlock()
	if pw == "" {
		return errors.New("no key yet")
	}
	key := ownKey(path)
	if err := os.MkdirAll(ownDir(), 0o700); err != nil {
		return err
	}
	for k := 0; k < partsOf(doc.Size); k++ {
		end := min(int64(len(body)), int64(k+1)*ownPart)
		locked, err := lockPiece(body[int64(k)*ownPart:end], pw)
		if err != nil {
			return err
		}
		if err := writeAtomic(partFile(key, k), locked, 0o600); err != nil {
			return err
		}
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.load()
	if was := o.ix.Entries[path]; was != nil {
		for k := partsOf(doc.Size); k < partsOf(was.Size); k++ {
			os.Remove(partFile(key, k))
		}
	}
	// (changed on Main while it was on its way: asked again)
	old := o.lately[doc.Name].After(asked) || doc.ID != "" && o.lately["id "+doc.ID].After(asked)
	o.ix.Entries[path] = &ownEntry{Doc: doc, Hdr: hdr, Size: doc.Size, Used: time.Now().Unix(), Old: old}
	o.dirty = true
	o.trim()
	return nil
}

func (o *ownStore) drop(path string) {
	if e := o.ix.Entries[path]; e != nil {
		for k := 0; k < partsOf(e.Size); k++ {
			os.Remove(partFile(ownKey(path), k))
		}
		delete(o.ix.Entries, path)
		o.dirty = true
	}
}

// trim: bounded; the ones used longest ago go first.
func (o *ownStore) trim() {
	limit := int64(ownMaxMB) << 20
	if free := diskFree(replicaDirFn()); free > 0 && free/10 < limit {
		limit = free / 10
	}
	var total int64
	var paths []string
	for p, e := range o.ix.Entries {
		total += e.Size
		paths = append(paths, p)
	}
	sort.Slice(paths, func(i, j int) bool { return o.ix.Entries[paths[i]].Used < o.ix.Entries[paths[j]].Used })
	for _, p := range paths {
		if total <= limit && time.Since(time.Unix(o.ix.Entries[p].Used, 0)) < ownKeepFor {
			break
		}
		total -= o.ix.Entries[p].Size
		o.drop(p)
	}
}

// who: the PC's key and the sign-in a request carries (hashed).
func whoOf(h http.Header) string {
	s := sha256.Sum256([]byte(h.Get("Cookie") + "|" + h.Get("Authorization") + "|" + h.Get("x-adal-pc")))
	return hex.EncodeToString(s[:16])
}

// isFresh: Main's changes are known up to now.
func (o *ownStore) isFresh() bool { return time.Since(o.fresh) < 75*time.Second }

// ── the window's door ──────────────────────────────────────────────────────

var hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "X-Adal-Door"}

// officeHost: an address of the office's network with Adal Keep's port (nothing else goes through here).
func officeHost(hostport string) bool {
	h, _, err := net.SplitHostPort(hostport)
	if err != nil {
		h = hostport
	}
	ip := net.ParseIP(h)
	return ip != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback())
}

func isMain(hostport string) bool {
	u, err := url.Parse(hostServer)
	return err == nil && u.Host != "" && strings.EqualFold(u.Host, hostport)
}

func startOwnDoor() {
	if !ownDocsOn() {
		return
	}
	own = newOwnStore()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", ownPort))
	if err != nil {
		log.Printf("🖼 the window's door (:%d): %v", ownPort, err)
		return
	}
	go (&http.Server{Handler: own, ReadHeaderTimeout: 30 * time.Second}).Serve(ln)
	go own.follow()
	go own.seenLoop()
}

func (o *ownStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h, _, _ := net.SplitHostPort(r.RemoteAddr); h != "127.0.0.1" && h != "::1" {
		http.Error(w, "only this PC", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodConnect { // ws:// (a robot's live view)
		tunnel(w, r)
		return
	}
	if r.Header.Get("X-Adal-Door") != "" || r.URL.Host == "" || r.URL.Scheme != "http" {
		http.Error(w, "a door for Adal Keep's window", http.StatusBadRequest)
		return
	}
	if r.Method == http.MethodGet && isMain(r.URL.Host) {
		switch {
		case docPath.MatchString(r.URL.Path) && r.URL.RawQuery == "", assetPath.MatchString(r.URL.Path):
			o.doc(w, r)
			return
		case girlPath.MatchString(r.URL.Path):
			o.mu.Lock()
			if o.load() != "" {
				o.ix.Girls[girlPath.FindStringSubmatch(r.URL.Path)[1]] = time.Now().Unix()
				o.dirty = true
			}
			o.mu.Unlock()
		}
	}
	resp, err := o.ask(r, nil)
	if err != nil {
		http.Error(w, `{"error":"the main PC does not answer on the network"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	pass(w, resp)
	copyAtOnce(w, resp.Body)
}

func pass(w http.ResponseWriter, resp *http.Response) {
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	for _, h := range hopHeaders {
		w.Header().Del(h)
	}
	w.Header().Del("X-Adal-Doc")
	w.WriteHeader(resp.StatusCode)
}

// ask: the request handed on to Main as it came.
func (o *ownStore) ask(r *http.Request, more map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), r.Body)
	if err != nil {
		return nil, err
	}
	req.ContentLength = r.ContentLength
	req.Host = r.Host
	for k, v := range r.Header {
		req.Header[k] = v
	}
	for _, h := range hopHeaders {
		req.Header.Del(h)
	}
	req.Header.Set("X-Adal-Door", "1") // (never in a circle)
	if isMain(r.URL.Host) {
		req.Header.Set("x-adal-flush", "1")
	}
	if req.Header.Get("Accept-Encoding") == "" {
		req.Header.Set("Accept-Encoding", "identity") // (as the window asked: never unpacked on the way)
	}
	for k, v := range more {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	return o.client.Do(req)
}

// doc: a photo, a document or a page's code: from this disk when it may be, else Main's answer, kept.
func (o *ownStore) doc(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	asset := assetPath.MatchString(path)
	who := whoOf(r.Header)
	o.mu.Lock()
	pw := o.load()
	e := o.ix.Entries[path]
	allowed := asset || time.Since(time.Unix(o.ix.Who[who], 0)) < whoFor
	fresh := asset || o.away || o.isFresh() && e != nil && !e.Old
	o.mu.Unlock()
	if pw != "" && e != nil && allowed && fresh && o.show(w, r, path, e, pw, "disk") {
		return
	}
	// Main is asked; a range or a condition is not (the answer would not be whole), nor gzip (it is kept as it is).
	// Here too, but maybe changed: Main has a moment to answer, then it is shown as it was.
	asked := time.Now()
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	var slow *time.Timer
	if pw != "" && e != nil && allowed {
		slow = time.AfterFunc(ownSlow, stop)
	}
	more := map[string]string{"x-adal-own": "1"}
	if o.mayKeep(path) {
		more = map[string]string{"x-adal-own": "1", "Range": "", "If-Range": "", "If-None-Match": "", "If-Modified-Since": "", "Accept-Encoding": encodingOf(asset, r)}
	}
	resp, err := o.ask(r.WithContext(ctx), more)
	if slow != nil {
		slow.Stop()
	}
	if err != nil || resp.StatusCode >= 500 {
		if resp != nil {
			resp.Body.Close()
		}
		// Main is off or does not answer: what is here, as it was.
		if pw != "" && e != nil && allowed && o.show(w, r, path, e, pw, "disk, the main PC does not answer") {
			return
		}
		http.Error(w, `{"error":"the main PC does not answer on the network"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	o.mu.Lock()
	if pw != "" && !asset {
		switch resp.StatusCode {
		case http.StatusOK:
			o.ix.Who[who] = time.Now().Unix()
			o.dirty = true
		case http.StatusUnauthorized, http.StatusForbidden:
			delete(o.ix.Who, who)
			o.dirty = true
		case http.StatusNotFound:
			if resp.Header.Get("X-Adal-Pending") == "" {
				o.drop(path)
			}
		}
	}
	o.mu.Unlock()
	doc, ok := docOf(resp, asset)
	hdr := map[string]string{}
	for _, h := range []string{"Content-Type", "Content-Disposition", "Cache-Control", "Content-Encoding", "Vary"} {
		if v := resp.Header.Get(h); v != "" {
			hdr[h] = v
		}
	}
	if !ok && resp.StatusCode == http.StatusOK {
		o.mu.Lock()
		if len(o.never) > 2000 {
			o.never = map[string]bool{}
		}
		o.never[path] = true
		o.mu.Unlock()
	}
	pass(w, resp)
	if !ok || pw == "" || resp.StatusCode != http.StatusOK {
		copyAtOnce(w, resp.Body)
		return
	}
	var buf bytes.Buffer
	in := &heard{r: resp.Body}
	copyAtOnce(w, io.TeeReader(in, &buf))
	if !in.whole {
		return // cut
	}
	if asset {
		if strings.Contains(hdr["Content-Type"], "html") || !readable(buf.Bytes(), hdr["Content-Encoding"]) {
			return
		}
		doc = ownDoc{Name: path, SHA: sum256(buf.Bytes()), Size: int64(buf.Len())}
	}
	if err := o.keep(path, doc, hdr, buf.Bytes(), asked); err != nil && int64(buf.Len()) == doc.Size {
		log.Printf("🖼 not kept: %v", err)
	}
}

func (o *ownStore) mayKeep(path string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return !o.never[path] && o.load() != ""
}

// heard: whether an answer came to its end.
type heard struct {
	r     io.Reader
	whole bool
}

func (h *heard) Read(b []byte) (int, error) {
	n, err := h.r.Read(b)
	if err == io.EOF {
		h.whole = true
	}
	return n, err
}

func readable(b []byte, enc string) bool {
	if enc == "" {
		return true
	}
	if enc != "gzip" {
		return false
	}
	z, err := gzip.NewReader(bytes.NewReader(b))
	if err == nil {
		_, err = io.Copy(io.Discard, z)
	}
	return err == nil
}

func encodingOf(asset bool, r *http.Request) string {
	if asset && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		return "gzip"
	}
	return "identity"
}

// docOf: what Main says the file is (X-Adal-Doc); a page's code has its fingerprint in its name.
func docOf(resp *http.Response, asset bool) (d ownDoc, ok bool) {
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent || resp.ContentLength > ownMaxFile {
		return
	}
	if asset {
		return d, strings.Contains(resp.Header.Get("Cache-Control"), "immutable")
	}
	b, err := base64.StdEncoding.DecodeString(resp.Header.Get("X-Adal-Doc"))
	if err != nil || json.Unmarshal(b, &d) != nil || !hexSHA.MatchString(d.SHA) || d.Size < 0 || d.Size > ownMaxFile || d.Name == "" {
		return ownDoc{}, false
	}
	return d, true
}

// show: from this disk (a range too: the pdf viewer asks for parts).
func (o *ownStore) show(w http.ResponseWriter, r *http.Request, path string, e *ownEntry, pw, from string) bool {
	if h := e.Hdr["Content-Encoding"]; h != "" && !strings.Contains(r.Header.Get("Accept-Encoding"), h) {
		return false
	}
	body, err := o.read(ownKey(path), e, pw)
	if err != nil { // damaged, or the agency's key is another one
		o.mu.Lock()
		o.drop(path)
		o.mu.Unlock()
		return false
	}
	o.mu.Lock()
	e.Used = time.Now().Unix()
	o.hits++
	o.saved += e.Size
	o.dirty = true
	if strings.HasSuffix(path, "/download") && r.Header.Get("Range") == "" { // the audit list, as ever
		h := map[string]string{}
		for _, k := range []string{"Cookie", "Authorization", "x-adal-pc"} {
			if v := r.Header.Get(k); v != "" {
				h[k] = v
			}
		}
		if len(o.ix.Seen) < 500 {
			o.ix.Seen = append(o.ix.Seen, ownSeen{path, h})
		}
	}
	o.mu.Unlock()
	for k, v := range e.Hdr {
		w.Header().Set(k, v)
	}
	w.Header().Set("ETag", `"`+e.Doc.SHA[:32]+`"`)
	w.Header().Set("X-Adal-From", from)
	if e.Hdr["Content-Encoding"] != "" { // (a range of a packed file would be nonsense)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
		return true
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
	return true
}

func tunnel(w http.ResponseWriter, r *http.Request) {
	if !officeHost(r.Host) {
		http.Error(w, "only the office's network", http.StatusForbidden)
		return
	}
	up, err := net.DialTimeout("tcp", r.Host, 5*time.Second)
	if err != nil {
		http.Error(w, "no answer", http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		up.Close()
		return
	}
	c, rw, err := hj.Hijack()
	if err != nil {
		up.Close()
		return
	}
	io.WriteString(c, "HTTP/1.1 200 OK\r\n\r\n")
	go func() { io.Copy(up, rw.Reader); up.Close() }()
	io.Copy(c, up)
	c.Close()
}

// ── what changes on Main ───────────────────────────────────────────────────

type docNews struct {
	At    string   `json:"at"`
	Reset bool     `json:"reset"`
	Names []string `json:"names"`
	Rows  []struct {
		ID      string `json:"id"`
		Profile any    `json:"profile"`
		Gone    bool   `json:"gone"`
		Mime    string `json:"mime"`
		Size    int64  `json:"size"`
	} `json:"rows"`
}

func (o *ownStore) follow() {
	for {
		pause := 20 * time.Second
		if signedOut() {
			o.wipe("signed out")
		} else if hostServer != "" {
			if err := o.news(50); err == nil {
				pause = 200 * time.Millisecond
			}
		}
		o.save()
		time.Sleep(pause)
	}
}

// news: one open question; what changed is marked (and a girl's of this PC fetched).
func (o *ownStore) news(wait int) error {
	o.mu.Lock()
	pw := o.load()
	at := o.ix.At
	o.mu.Unlock()
	if pw == "" {
		return errors.New("no key yet")
	}
	resp, err := lanGet("/api/companion/docs?at="+url.QueryEscape(at)+"&wait="+strconv.Itoa(wait), "", 0)
	o.mu.Lock()
	o.away = err != nil
	o.mu.Unlock()
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if bytes.Contains(b, []byte(`"suspended":true`)) || bytes.Contains(b, []byte(`"pc_access":true`)) {
			o.wipe("this PC was removed or suspended on the main PC")
		}
		return fmt.Errorf("the main PC answered %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("the main PC answered %d", resp.StatusCode)
	}
	var n docNews
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&n); err != nil || n.At == "" {
		return errors.New("a bad answer")
	}
	if n.Reset { // Main started again: which of the ones here differ
		if n.Names, err = o.differ(); err != nil {
			return err
		}
	}
	var get []string
	o.mu.Lock()
	changed := map[string]bool{}
	for _, x := range n.Names {
		changed[x] = true
	}
	ids := map[string]bool{}
	for _, r := range n.Rows {
		ids[r.ID] = true
	}
	for x, t := range o.lately {
		if time.Since(t) > 10*time.Minute {
			delete(o.lately, x)
		}
	}
	for x := range changed {
		o.lately[x] = time.Now()
	}
	for x := range ids {
		o.lately["id "+x] = time.Now()
	}
	for p, e := range o.ix.Entries {
		if m := docPath.FindStringSubmatch(p); m != nil && (changed[e.Doc.Name] || ids[m[1]]) {
			e.Old = true
			get = append(get, p)
			o.dirty = true
		}
	}
	for _, r := range n.Rows {
		girl := fmt.Sprint(r.Profile)
		if f, ok := r.Profile.(float64); ok {
			girl = strconv.FormatInt(int64(f), 10)
		}
		if r.Gone {
			o.drop("/api/files/" + r.ID + "/download")
			o.drop("/api/files/" + r.ID + "/thumbnail")
		} else if time.Since(time.Unix(o.ix.Girls[girl], 0)) < 30*24*time.Hour && r.Size < 8<<20 {
			if strings.HasPrefix(r.Mime, "image/") {
				get = append(get, "/api/files/"+r.ID+"/thumbnail")
			}
			get = append(get, "/api/files/"+r.ID+"/download")
		}
	}
	if o.ix.At != n.At {
		o.ix.At, o.dirty = n.At, true
	}
	o.fresh = time.Now()
	for g, t := range o.ix.Girls {
		if time.Since(time.Unix(t, 0)) > 30*24*time.Hour {
			delete(o.ix.Girls, g)
		}
	}
	o.mu.Unlock()
	if len(get) > 0 {
		go o.fetch(get)
	}
	return nil
}

func (o *ownStore) differ() ([]string, error) {
	have := [][2]string{}
	o.mu.Lock()
	for _, e := range o.ix.Entries {
		if e.Doc.V != "" {
			have = append(have, [2]string{e.Doc.Name, e.Doc.V})
		}
	}
	o.mu.Unlock()
	if len(have) == 0 {
		return nil, nil
	}
	key, err := mainAccessKey(false)
	if err != nil {
		return nil, err
	}
	var r struct {
		Differ []string `json:"differ"`
	}
	_, err = mainJSON(http.MethodPost, "/api/companion/docs/check", map[string]any{"have": have}, key, &r)
	return r.Differ, err
}

// fetch: new and changed ones of the girls opened here, one after the other.
func (o *ownStore) fetch(paths []string) {
	o.getMu.Lock()
	defer o.getMu.Unlock()
	done := map[string]bool{}
	for _, p := range paths {
		if done[p] {
			continue
		}
		done[p] = true
		o.mu.Lock()
		e := o.ix.Entries[p]
		ok := e != nil && !e.Old
		o.mu.Unlock()
		if ok {
			continue
		}
		if err := o.fetchOne(p); err != nil {
			log.Printf("🖼 %v", err)
		}
	}
}

func (o *ownStore) fetchOne(path string) error {
	key, err := mainAccessKey(false)
	if err != nil {
		return err
	}
	asked := time.Now()
	var doc ownDoc
	hdr := map[string]string{}
	var body []byte
	for tries := 0; ; { // parts of 4 MB: a cut one is asked again, not the whole
		d, h, b, code, err := o.part(path, key, int64(len(body)))
		if code == http.StatusNotFound {
			o.mu.Lock()
			o.drop(path)
			o.mu.Unlock()
			return nil
		}
		if err != nil || doc.SHA != "" && d.SHA != doc.SHA {
			if tries++; tries > 3 {
				return fmt.Errorf("a photo or document did not come: %v", err)
			}
			if err == nil { // another one by now
				doc, body = ownDoc{}, nil
			}
			time.Sleep(time.Duration(tries) * 2 * time.Second)
			continue
		}
		if d.SHA == "" {
			return nil // not one to keep
		}
		doc, hdr, body = d, h, append(body, b...)
		if len(b) == 0 || int64(len(body)) >= doc.Size {
			return o.keep(path, doc, hdr, body, asked)
		}
	}
}

func (o *ownStore) part(path, key string, from int64) (d ownDoc, hdr map[string]string, b []byte, code int, err error) {
	ctx, stop := context.WithTimeout(context.Background(), 2*time.Minute)
	defer stop()
	// (its own route: the program fetching one is not a person opening it, for the audit list)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(hostServer, "/")+"/api/companion/docs/file/"+strings.TrimPrefix(path, "/api/files/"), nil)
	if err != nil {
		return
	}
	req.Header.Set("x-adal-pc", key)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, from+ownPart-1))
	resp, err := o.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if code = resp.StatusCode; code >= 500 {
		err = fmt.Errorf("the main PC answered %d", code)
		return
	}
	d, ok := docOf(resp, false)
	if !ok || from > 0 && code != http.StatusPartialContent {
		d = ownDoc{}
		return
	}
	hdr = map[string]string{}
	for _, h := range []string{"Content-Type", "Content-Disposition", "Cache-Control"} {
		if v := resp.Header.Get(h); v != "" {
			hdr[h] = v
		}
	}
	b, err = io.ReadAll(io.LimitReader(resp.Body, ownMaxFile+1))
	return
}

// seenLoop: documents opened from this disk, told to Main for its audit list (kept while it is off).
func (o *ownStore) seenLoop() {
	for k := 1; ; k++ {
		time.Sleep(3 * time.Second)
		o.tellSeen()
		if k%5 == 0 {
			o.save()
		}
	}
}

func (o *ownStore) tellSeen() {
	for {
		o.mu.Lock()
		if len(o.ix.Seen) == 0 || hostServer == "" {
			o.mu.Unlock()
			return
		}
		s := o.ix.Seen[0]
		o.mu.Unlock()
		req, err := http.NewRequest(http.MethodGet, strings.TrimRight(hostServer, "/")+s.Path, nil)
		if err != nil {
			return
		}
		for k, v := range s.Hdr {
			req.Header.Set(k, v)
		}
		req.Header.Set("x-adal-own", "1")
		req.Header.Set("x-adal-seen", "1")
		resp, err := o.client.Do(req)
		if err != nil {
			return // Main is off: told when it is back
		}
		resp.Body.Close()
		if resp.StatusCode >= 500 {
			return
		}
		o.mu.Lock()
		if len(o.ix.Seen) > 0 {
			o.ix.Seen = o.ix.Seen[1:]
			o.dirty = true
		}
		o.mu.Unlock()
	}
}

// serveOwn: for the online pages (mainproxy.go), Main away: a photo or document kept here.
func serveOwn(w http.ResponseWriter, r *http.Request, path string) bool {
	if own == nil || r.Method != http.MethodGet || !docPath.MatchString(path) {
		return false
	}
	own.mu.Lock()
	pw := own.load()
	e := own.ix.Entries[path]
	own.mu.Unlock()
	return pw != "" && e != nil && own.show(w, r, path, e, pw, "disk")
}
