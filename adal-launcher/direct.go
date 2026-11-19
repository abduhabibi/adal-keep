//go:build windows

// direct.go — an Adal Companion opens the main PC directly whenever it can.
//
// Joined with the PC number, the Companion works from the agency's online
// copy, and then every click and change goes through the cloud — slow
// (asked on 2026-11-17: "it connects but the update gets really sluggish").
// So whenever the main PC can be reached — the address the Companion found on
// the network (companion.conf), or one of the office addresses the main PC
// sends online every 15 s — the window opens the main PC itself instead.
package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// privateAddr: "192.168.1.5:4000" → "http://192.168.1.5:4000" for an office,
// Tailscale or other private address only; "" for anything else.
func privateAddr(s string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(s))
	if err != nil {
		host, port = strings.TrimSpace(s), "4000"
	}
	ip := net.ParseIP(host).To4()
	if ip == nil {
		return ""
	}
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return ""
	}
	tailscale := ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127
	if !ip.IsPrivate() && !ip.IsLoopback() && !tailscale {
		return ""
	}
	return "http://" + host + ":" + port
}

// answersAsAdalKeep: an Adal Keep server answers there within `wait`.
func answersAsAdalKeep(u string, wait time.Duration) bool {
	c := &http.Client{Timeout: wait}
	resp, err := c.Get(u + "/api/companion/info")
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

// companionHost: where adal-companion.exe finds the main PC now (empty when it does not say).
func companionHost() string {
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:47810/local/host", nil)
	req.Header.Set("X-Adal", "1")
	resp, err := (&http.Client{Timeout: time.Second}).Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	return privateAddr(strings.TrimPrefix(strings.TrimSpace(string(b)), "http://"))
}

// candidates: the saved address first, then the ones the main PC sent.
func candidates(root, tries string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimRight(u, "/")
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	add(mainPCURL(root))
	add(companionHost())
	for _, t := range strings.Split(tries, ",") {
		if len(out) >= 10 {
			break
		}
		add(privateAddr(t))
	}
	return out
}

// numberCheck: replaced in tests.
var numberCheck = isMainWithNumber

// isOurMain: u is an Adal Keep that says the number this Companion joined with
// is its own. Never any other main PC on the same Wi-Fi (another agency's,
// a test PC), and never one from the online list whose address another office
// shares. Without a saved number nothing can be verified: only the address
// saved here (companion.conf) is kept, as before; every other one is refused.
func isOurMain(root, u string, wait time.Duration) bool {
	if !answersAsAdalKeep(u, wait) {
		return false
	}
	number := savedNumber(root)
	if number == "" {
		return strings.TrimRight(u, "/") == mainPCURL(root)
	}
	return numberCheck(u, number)
}

// firstAnswering asks them all at once; the first of OUR main PC (its number)
// to answer wins ("" none).
func firstAnswering(root string, list []string, wait time.Duration) string {
	if len(list) == 0 {
		return ""
	}
	got := make(chan string, len(list))
	for _, u := range list {
		go func(u string) {
			if isOurMain(root, u, wait) {
				got <- u
			} else {
				got <- ""
			}
		}(u)
	}
	for range list {
		if u := <-got; u != "" {
			return u
		}
	}
	return ""
}

// findMainPC: the main PC's address when it answers now, else "". One found
// from the main PC's own list is saved for the Companion too.
func findMainPC(root, tries string) string {
	if signedOut(root) { // logged out of it: another main PC is being chosen (leave.go)
		return ""
	}
	u := firstAnswering(root, candidates(root, tries), 2*time.Second)
	if u != "" && u != mainPCURL(root) {
		rememberMainURL(root, u)
	}
	return u
}

// rememberMainURL writes companion.conf the way the Companion does (it may
// update it later when the main PC moves); an address typed by hand stays.
func rememberMainURL(root, u string) {
	p := filepath.Join(root, "companion.conf")
	if signedOut(root) {
		return
	}
	if old, err := os.ReadFile(p); err == nil && !strings.HasPrefix(string(old), "# Written by the Adal Keep Companion.") {
		return
	}
	body := "# Written by the Adal Keep Companion. Edit ADAL_HOST_URL or delete\r\n" +
		"# this file to let the Companion search the LAN again.\r\n" +
		"ADAL_HOST_URL=" + u + "\r\n"
	// The main PC's number (its identity) stays with it.
	if old, err := os.ReadFile(p); err == nil {
		for _, line := range strings.Split(string(old), "\n") {
			if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok && strings.TrimSpace(k) == "ADAL_PC_NUMBER" {
				body += "ADAL_PC_NUMBER=" + strings.TrimSpace(v) + "\r\n"
			}
		}
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err == nil {
		logf("main PC found at %s (from its own list)", u)
	}
}
