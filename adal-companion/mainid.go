package main

// mainid.go — which main PC is ours, and finding it fast by its network card.
//
// The 5-digit PC number (typed once when the Companion joined, saved in
// companion.conf as ADAL_PC_NUMBER) is the main PC's identity: a main PC is
// only taken when it says that number is its own (POST
// /api/pc-access/check-number, which lets nothing in). Its network cards
// (MAC addresses, sent in the discovery reply and /api/companion/info) are
// only for finding it quickly: when the router hands out new addresses, the
// card is looked up in this PC's neighbour table (ARP) — no broadcast, no
// scan of the whole network — and the address it has now is used.
//
// Remembered in main-pc.json next to the program: { number, macs, url }.

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type mainIdentity struct {
	Number string   `json:"number,omitempty"`
	Macs   []string `json:"macs,omitempty"`
	URL    string   `json:"url,omitempty"`
	Seen   string   `json:"seen,omitempty"`
	// PCID: the main PC's permanent id (its data/sync-id.json pc_id): found by it
	// on the office network whatever its address (presence.go).
	PCID string `json:"pc_id,omitempty"`
}

var (
	identityMu   sync.Mutex
	identityPath = defaultIdentityPath
	// neighbourTableFn: replaced in tests.
	neighbourTableFn = neighbourTable
)

func defaultIdentityPath() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "main-pc.json")
	}
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "adal-companion-main-pc.json")
}

func loadIdentity() mainIdentity {
	identityMu.Lock()
	defer identityMu.Unlock()
	var id mainIdentity
	if b, err := os.ReadFile(identityPath()); err == nil {
		_ = json.Unmarshal(b, &id)
	}
	if n := confNumber(); n != "" {
		id.Number = n // typed when joining: always wins
	}
	return id
}

func saveIdentity(id mainIdentity) {
	identityMu.Lock()
	defer identityMu.Unlock()
	b, _ := json.MarshalIndent(id, "", "  ")
	tmp := identityPath() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, identityPath())
	}
}

// confNumber: ADAL_PC_NUMBER from the environment or companion.conf.
func confNumber() string {
	if v := cleanPCNumber(os.Getenv("ADAL_PC_NUMBER")); v != "" {
		return v
	}
	path, err := companionConfPath()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return numberInConf(string(data))
}

func numberInConf(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == "ADAL_PC_NUMBER" {
			return cleanPCNumber(v)
		}
	}
	return ""
}

// cleanPCNumber: the digits of a PC number, "" unless 5 or 6 of them.
func cleanPCNumber(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	if n := b.Len(); n == 5 || n == 6 {
		return b.String()
	}
	return ""
}

// normMAC: "AA-BB-CC-DD-EE-FF" / "aa:bb:…" → "aa:bb:cc:dd:ee:ff"; "" if not one.
func normMAC(s string) string {
	hw, err := net.ParseMAC(strings.ReplaceAll(strings.TrimSpace(s), "-", ":"))
	if err != nil || len(hw) != 6 {
		return ""
	}
	m := hw.String()
	if m == "00:00:00:00:00:00" || m == "ff:ff:ff:ff:ff:ff" {
		return ""
	}
	return m
}

// learnMain: the main PC answered at u with these cards — remember them.
func learnMain(u string, macs []string) {
	id := loadIdentity()
	var clean []string
	for _, m := range macs {
		if n := normMAC(m); n != "" {
			clean = append(clean, n)
		}
	}
	changed := strings.TrimRight(u, "/") != id.URL
	if len(clean) > 0 && strings.Join(clean, ",") != strings.Join(id.Macs, ",") {
		if len(id.Macs) == 0 {
			log.Printf("🪪 Main PC's network card remembered: %s", strings.Join(clean, ", "))
		}
		id.Macs = clean
		changed = true
	}
	if !changed && time.Since(parseTime(id.Seen)) < time.Hour {
		return
	}
	id.URL = strings.TrimRight(u, "/")
	id.Seen = time.Now().UTC().Format(time.RFC3339)
	saveIdentity(id)
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

// numberCheck: replaced in tests.
var numberCheck = isMainWithNumber

// A main PC that answers slowly (a swamped PC: 13 s for one answer) is "not known yet", never "not ours"
// (2026-11-22: a 2–3 s timeout made the Companion drop its own main PC as "another main PC"). Every
// timeout, transport error or 5xx/429 marks the address unknown for a while; only a definite answer
// ("ok": false) is a refusal.
var (
	unknownMu sync.Mutex
	unknownAt = map[string]time.Time{}
	// askTimeout: how long the main PC gets to answer who it is.
	askTimeout = 20 * time.Second
)

func markUnknown(u string, unknown bool) {
	u = strings.TrimRight(u, "/")
	unknownMu.Lock()
	defer unknownMu.Unlock()
	if unknown {
		unknownAt[u] = time.Now()
	} else {
		delete(unknownAt, u)
	}
}

// wasUnknown: the last answer of u was no answer (a slow or busy PC), not a refusal.
func wasUnknown(u string) bool {
	unknownMu.Lock()
	defer unknownMu.Unlock()
	t, ok := unknownAt[strings.TrimRight(u, "/")]
	return ok && time.Since(t) < 2*time.Minute
}

// isMainWithNumber: the Adal Keep at u says this number is its own.
func isMainWithNumber(u, number string) bool {
	body, _ := json.Marshal(map[string]string{"number": number})
	c := &http.Client{Timeout: askTimeout}
	resp, err := c.Post(strings.TrimRight(u, "/")+"/api/pc-access/check-number", "application/json", bytes.NewReader(body))
	if err != nil {
		markUnknown(u, true)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		markUnknown(u, true)
		return false
	}
	var r struct {
		OK bool `json:"ok"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&r) != nil {
		markUnknown(u, true)
		return false
	}
	markUnknown(u, false)
	return r.OK
}

// serverIsOurs: with a number known, only the main PC that says it is its own.
// (Older main PCs without the check answer 404: taken, as before.)
func serverIsOurs(u string) bool {
	id := loadIdentity()
	if id.Number == "" {
		// No number to check (an old install): at least the network card it had.
		if len(id.Macs) == 0 {
			return true
		}
		macs := macsAt(u)
		if macs == nil {
			markUnknown(u, true) // no answer is not "another card"
			return false
		}
		markUnknown(u, false)
		return sameCard(id.Macs, macs)
	}
	return numberCheck(u, id.Number)
}

// macsAt: the network cards the Adal Keep at u says it has.
func macsAt(u string) []string {
	resp, err := (&http.Client{Timeout: askTimeout}).Get(strings.TrimRight(u, "/") + "/api/companion/info")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var info struct {
		Macs []string `json:"macs"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info)
	return normMACs(info.Macs)
}

// refusedServer: an Adal Keep answers at u and it is NOT our main PC (another
// agency's, a test PC). An address that does not answer is not "refused".
func refusedServer(u string) bool {
	return answersAdalKeep(u) && !acceptServer(u) && !wasUnknown(u)
}

var (
	oursMu sync.Mutex
	oursAt = map[string]time.Time{}
)

// confirmedOurs: u is our main PC — asked again at most every 5 minutes.
func confirmedOurs(u string) bool {
	u = strings.TrimRight(u, "/")
	oursMu.Lock()
	t, ok := oursAt[u]
	oursMu.Unlock()
	if ok && time.Since(t) < 5*time.Minute {
		return true
	}
	if !acceptServer(u) {
		// A main PC too busy to answer who it is keeps its place: asked again at the next look.
		return wasUnknown(u)
	}
	oursMu.Lock()
	oursAt[u] = time.Now()
	oursMu.Unlock()
	return true
}

// acceptServer: what discovery and the scan accept (replaced in tests).
// (and, with the agency's key here, it proves it has the same: book.go)
var acceptServer = func(u string) bool { return serverIsOurs(u) && provesOurs(u) }

// findByMAC: the main PC's current address from this PC's neighbour table,
// by the network card it had. "" when the card is not in the table (yet).
func findByMAC() string {
	id := loadIdentity()
	if len(id.Macs) == 0 {
		return ""
	}
	port := "4000"
	if u, err := url.Parse(id.URL); err == nil && u.Port() != "" {
		port = u.Port()
	}
	want := map[string]bool{}
	for _, m := range id.Macs {
		want[m] = true
	}
	for ip, mac := range neighbourTableFn() {
		if !want[mac] || neverLAN(net.ParseIP(ip)) {
			continue
		}
		u := "http://" + net.JoinHostPort(ip, port)
		if answersAdalKeep(u) && acceptServer(u) {
			return u
		}
	}
	return ""
}

func answersAdalKeep(u string) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(strings.TrimRight(u, "/") + "/api/companion/info")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var info struct {
		Service string `json:"service"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info)
	return resp.StatusCode == http.StatusOK && info.Service == "adal-keep"
}

// macsInReply: field 6 of the discovery reply (newer main PCs).
func macsInReply(parts []string) []string {
	if len(parts) < 6 {
		return nil
	}
	var out []string
	for _, m := range strings.Split(parts[5], ",") {
		if n := normMAC(m); n != "" {
			out = append(out, n)
		}
	}
	return out
}

func normMACs(in []string) []string {
	var out []string
	for _, m := range in {
		if n := normMAC(m); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// sameCard: any card in common.
func sameCard(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}
