// book.go — the address book: where each PC of this agency is, by its permanent id (2026-11-26, the owner:
// hundreds of agencies, Main moved .6 → .3 → .5 in two days and every move cost sweeps, lost copies and
// 20 s time-outs; no account and nothing for a person to set up).
//
// In this order, the network sweep last:
//  1. the last address a PC was heard at (kept on disk, presence-book.json, over a restart);
//  2. what it says on the office network (presence.go, every 5 s and at once when its address changes),
//     SIGNED with a key made from the agency's backup key — another agency's PC on the same Wi-Fi, even one
//     that knows the number, is never taken; a signed message counts only from an address it names;
//  3. online: Main's heartbeat (keep_meta /_pc, its addresses, written every ~15 s and at once when they
//     change), read when Main is not heard on the network;
//  4. only then the sweep (steady.go: with pauses).
//
// Off: ADAL_PRESENCE_SIGN=0 (unsigned, as before), ADAL_BOOK=0 (no file, no online look).
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const presenceSkew = 15 * time.Minute

var (
	sigRe       = regexp.MustCompile(`^s1:(\d{10,13}):([0-9.,]{0,200}):([0-9a-f]{32})$`)
	presenceKey = cachedPresenceKey // replaced in tests
	keyMu       sync.Mutex
	keyFrom     string
	keyBytes    []byte
	keyAt       time.Time
	signedAt    = map[string]int64{} // pc id → newest signed time heard (under presenceMu)
	refused     int64
	bookRoot    string
)

func presenceSignOn() bool { return os.Getenv("ADAL_PRESENCE_SIGN") != "0" }
func bookOn() bool         { return os.Getenv("ADAL_BOOK") != "0" }

// signKeyOf: the announce key from the agency's backup key (the same in backend services/pcPresence.js).
func signKeyOf(backup string) []byte {
	if backup == "" {
		return nil
	}
	m := hmac.New(sha256.New, []byte(backup))
	m.Write([]byte("adal-presence-v1"))
	return m.Sum(nil)
}

func cachedPresenceKey() []byte {
	keyMu.Lock()
	defer keyMu.Unlock()
	if time.Since(keyAt) > time.Minute {
		keyAt = time.Now()
		if pw := loadKeys().Password; pw != keyFrom {
			keyFrom, keyBytes = pw, signKeyOf(pw)
		}
	}
	return keyBytes
}

func macOf(key []byte, body string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(body))
	return hex.EncodeToString(m.Sum(nil))[:32]
}

// signPresence: the message with its signature, naming this PC's addresses (as it was without a key).
func signPresence(text string, key []byte, addrs []string, ts int64) string {
	if len(key) == 0 || !presenceSignOn() {
		return text
	}
	p := strings.Split(text, "|")
	for len(p) < 7 {
		p = append(p, "")
	}
	var ok []string
	for _, a := range addrs {
		if ip := net.ParseIP(a); ip != nil && ip.To4() != nil && len(ok) < 8 {
			ok = append(ok, ip.To4().String())
		}
	}
	body := strings.Join(p[:7], "|") + fmt.Sprintf("|s1:%d:%s", ts, strings.Join(ok, ","))
	return body + ":" + macOf(key, body)
}

// checkSigned: true signed by our agency, false refused, and "not signed" (an older program, no key here).
func checkSigned(text, id, ip string, now time.Time) (signed, ok bool, addrs []string) {
	p := strings.Split(strings.TrimSpace(text), "|")
	var m []string
	if len(p) > 7 {
		m = sigRe.FindStringSubmatch(p[7])
	}
	presenceMu.Lock()
	defer presenceMu.Unlock()
	if m == nil {
		_, was := signedAt[id]
		return false, !was && os.Getenv("ADAL_PRESENCE_STRICT") != "1", nil
	}
	key := presenceKey()
	if len(key) == 0 {
		return false, true, nil
	}
	body := strings.Join(p[:7], "|") + "|s1:" + m[1] + ":" + m[2]
	ts, _ := strconv.ParseInt(m[1], 10, 64)
	named := false
	for _, a := range strings.Split(m[2], ",") {
		named = named || a == ip
	}
	at := time.UnixMilli(ts)
	if !hmac.Equal([]byte(macOf(key, body)), []byte(m[3])) || !named || at.Sub(now).Abs() > presenceSkew || ts < signedAt[id]-60000 {
		return false, false, nil
	}
	signedAt[id] = max(ts, signedAt[id])
	return true, true, strings.Split(m[2], ",")
}

// signedNotThere: our Main signed where it is now, and u is not one of those addresses (no 3 s wait for a
// dead old address).
func signedNotThere(u string) bool {
	e, ok := presenceOf(loadIdentity().PCID)
	if !ok || !e.Signed {
		return false
	}
	for _, a := range e.Addrs {
		if strings.Contains(u, "//"+a+":") {
			return false
		}
	}
	return true
}

// ownAddrs: this PC's office addresses now.
func ownAddrs() []string {
	var out []string
	for _, n := range ownNets() {
		out = append(out, n.IP.To4().String())
	}
	return out
}

// ── kept on disk ───────────────────────────────────────────────────────────

type bookEntry struct {
	ID, IP, Role, Name string
	Port               int
	Signed             bool
	At                 time.Time
}

var (
	bookMu   sync.Mutex
	bookLast = map[string]bookEntry{}
	bookSave *time.Timer
)

func bookFile() string { return filepath.Join(bookRoot, "presence-book.json") }

func loadBook(root string) {
	bookMu.Lock()
	defer bookMu.Unlock()
	bookRoot = root
	if !bookOn() {
		return
	}
	if b, err := os.ReadFile(bookFile()); err == nil {
		_ = json.Unmarshal(b, &bookLast)
	}
}

// bookHeard: a PC heard at an address: kept (written a few seconds later, when something changed).
func bookHeard(e presenceEntry, signed bool) {
	bookMu.Lock()
	defer bookMu.Unlock()
	if !bookOn() || bookRoot == "" {
		return
	}
	was, had := bookLast[e.ID]
	bookLast[e.ID] = bookEntry{ID: e.ID, IP: e.IP, Role: e.Role, Name: e.Name, Port: e.Port, Signed: signed, At: e.At}
	if had && was.IP == e.IP && was.Port == e.Port && time.Since(was.At) < 10*time.Minute {
		return
	}
	if bookSave == nil {
		bookSave = time.AfterFunc(3*time.Second, func() {
			bookMu.Lock()
			f := bookFile()
			b, _ := json.MarshalIndent(bookLast, "", " ")
			bookSave = nil
			bookMu.Unlock()
			_ = writeAtomic(f, b, 0o644)
		})
	}
}

// lastKnown: where that PC was heard last (any time ago), "" when never.
func lastKnown(id string) string {
	bookMu.Lock()
	defer bookMu.Unlock()
	e, ok := bookLast[id]
	if !ok || id == "" || e.IP == "" {
		return ""
	}
	return "http://" + net.JoinHostPort(e.IP, strconv.Itoa(e.Port))
}

// companionsHeard: the other Companions of this agency heard lately (signed when this PC has the key).
func companionsHeard() []string {
	strict := len(presenceKey()) > 0
	presenceMu.Lock()
	defer presenceMu.Unlock()
	var out []string
	for _, e := range presenceMap {
		if e.Role == "companion" && time.Since(e.At) <= 2*time.Minute && (e.Signed || !strict) {
			out = append(out, e.url())
		}
	}
	return out
}

// ── online: Main's heartbeat ───────────────────────────────────────────────

var (
	cloudLook   time.Time
	cloudMu     sync.Mutex
	cloudLookFn = mainAddrsOnline // replaced in tests
)

// mainFromCloud: Main's addresses from its heartbeat online (at most every 30 s), the first that is ours.
func mainFromCloud() string {
	bookMu.Lock()
	root := bookRoot
	bookMu.Unlock()
	if !bookOn() || root == "" {
		return ""
	}
	cloudMu.Lock()
	if time.Since(cloudLook) < 30*time.Second {
		cloudMu.Unlock()
		return ""
	}
	cloudLook = time.Now()
	cloudMu.Unlock()
	for _, u := range cloudLookFn(root) {
		if u != strings.TrimRight(hostServer, "/") && answersAdalKeep(u) && acceptServer(u) {
			log.Printf("☁️ Main PC found by its heartbeat online at %s", u)
			return u
		}
	}
	return ""
}

func mainAddrsOnline(root string) []string {
	c := readCloud(root)
	if c == nil {
		return nil
	}
	h := &http.Client{Timeout: 8 * time.Second}
	tok, err := c.token(h)
	if err != nil {
		return nil
	}
	req, _ := http.NewRequest(http.MethodGet, c.URL+"/rest/v1/keep_meta?key=eq./_pc&select=data", nil)
	req.Header.Set("apikey", c.Anon)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := h.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var rows []struct {
		Data struct {
			At     string   `json:"at"`
			Lan    []string `json:"lan"`
			Port   int      `json:"port"`
			Acting bool     `json:"acting"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&rows) != nil || len(rows) == 0 || rows[0].Data.Acting {
		return nil
	}
	d := rows[0].Data
	if at, err := time.Parse(time.RFC3339, d.At); err != nil || time.Since(at) > 10*time.Minute {
		return nil
	}
	port := d.Port
	if port <= 0 || port > 65535 {
		port = 4000
	}
	var out []string
	for _, a := range d.Lan {
		if ip := net.ParseIP(a); ip != nil && lanUsable(ip) && onOwnNet(ip) {
			out = append(out, "http://"+net.JoinHostPort(ip.String(), strconv.Itoa(port)))
		}
	}
	return out
}

// ── this PC's own address ─────────────────────────────────────────────────

var robotKick = make(chan struct{}, 1)

// watchOwnAddress: this PC's addresses changed: said at once (three times), and Main told at once.
func watchOwnAddress(say func(), stop <-chan struct{}) {
	was := strings.Join(ownAddrs(), ",")
	every := time.Duration(envInt("ADAL_ADDR_WATCH_MS", 2000)) * time.Millisecond
	for {
		select {
		case <-stop:
			return
		case <-time.After(every):
		}
		now := strings.Join(ownAddrs(), ",")
		if now == was {
			continue
		}
		log.Printf("📍 This PC's address changed: %s → %s — said at once", orNone(was), orNone(now))
		was = now
		say()
		go func() {
			for _, d := range []time.Duration{time.Second, 2 * time.Second} {
				time.Sleep(d)
				say()
			}
		}()
		select {
		case robotKick <- struct{}{}:
		default:
		}
	}
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// ── "Are you ours?" ───────────────────────────────────────────────────────

var (
	proofMu  sync.Mutex
	proofYes = map[string]time.Time{}
)

// provesOurs: a PC found at u (by the sweep, the broadcast, its card, online) has the agency's key: it
// signs a fresh question. One that cannot (an older program) is taken as before, unless our Main was
// heard signing: then it is not our Main (2026-11-26, a test: another agency's PC with our number, found by
// the sweep, was taken).
func provesOurs(u string) bool {
	key := presenceKey()
	if len(key) == 0 || !presenceSignOn() {
		return true
	}
	u = strings.TrimRight(u, "/")
	proofMu.Lock()
	if time.Since(proofYes[u]) < time.Minute {
		proofMu.Unlock()
		return true
	}
	proofMu.Unlock()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return false
	}
	nonce := hex.EncodeToString(b)
	resp, err := (&http.Client{Timeout: 4 * time.Second}).Get(u + "/api/companion/info?proof=" + nonce)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var info struct {
		PCID string `json:"pc_id"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&info)
	got := resp.Header.Get("X-Adal-Proof")
	if got == "" {
		presenceMu.Lock()
		_, signs := signedAt[loadIdentity().PCID]
		presenceMu.Unlock()
		if signs {
			log.Printf("🛑 %s says it is Adal Keep but cannot prove it is this agency's: not taken", u)
		}
		return !signs
	}
	if !hmac.Equal([]byte(got), []byte(macOf(key, "proof|"+nonce+"|"+info.PCID))) {
		log.Printf("🛑 %s is another agency's Adal Keep (its proof is not ours): not taken", u)
		return false
	}
	proofMu.Lock()
	proofYes[u] = time.Now()
	proofMu.Unlock()
	return true
}
