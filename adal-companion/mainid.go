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

// isMainWithNumber: the Adal Keep at u says this number is its own.
func isMainWithNumber(u, number string) bool {
	body, _ := json.Marshal(map[string]string{"number": number})
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Post(strings.TrimRight(u, "/")+"/api/pc-access/check-number", "application/json", bytes.NewReader(body))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var r struct {
		OK bool `json:"ok"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&r)
	return r.OK
}

// serverIsOurs: with a number known, only the main PC that says it is its own.
// (Older main PCs without the check answer 404: taken, as before.)
func serverIsOurs(u string) bool {
	id := loadIdentity()
	if id.Number == "" {
		return true
	}
	return numberCheck(u, id.Number)
}

// acceptServer: what discovery and the scan accept (replaced in tests).
var acceptServer = serverIsOurs

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
		if !want[mac] {
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
