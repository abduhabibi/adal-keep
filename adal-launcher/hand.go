//go:build windows

// hand.go — the window never has to type the main PC's number again.
//
// Asked on 2026-11-19 ("it is logging out fast"): the window's key on the
// main PC lived in a cookie of one address only, so when the router handed
// the main PC a new address (the Companion follows it by its network card),
// or the window opened its Tailscale or other office address, or the
// browser's data was cleared, the main PC did not know the window and asked
// for the number again. Now every window AdalKeep.exe opens on the main PC
// carries, after # (never sent to any server), the number it joined with and
// this Companion's own id: the page comes back in by itself, at the same
// place on the main PC's list (so a suspension there still holds). Not after
// "Log out of this main PC" (signedOut): then the number is typed again.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// companionID: this Companion's own id (made once, kept next to the program).
func companionID(root string) string {
	p := filepath.Join(root, "companion-id")
	if b, err := os.ReadFile(p); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 16 {
			return s
		}
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	id := hex.EncodeToString(b)
	if os.WriteFile(p, []byte(id), 0o600) != nil {
		return ""
	}
	return id
}

// savedNumber: the main PC's number this Companion joined with (companion.conf,
// else the Companion's main-pc.json), "" when none.
func savedNumber(root string) string {
	if f, err := os.Open(filepath.Join(root, "companion.conf")); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "="); ok && strings.TrimSpace(k) == "ADAL_PC_NUMBER" {
				if n := cleanNumber(v); n != "" {
					return n
				}
			}
		}
	}
	var id struct {
		Number string `json:"number"`
	}
	if b, err := os.ReadFile(filepath.Join(root, "main-pc.json")); err == nil && json.Unmarshal(b, &id) == nil {
		return cleanNumber(id.Number)
	}
	return ""
}

// handFor: "adal_number=…&adal_cid=…" for the window, "" when logged out or no number.
func handFor(root, number string) string {
	if signedOut(root) || number == "" {
		return ""
	}
	h := "adal_number=" + url.QueryEscape(number)
	if cid := companionID(root); cid != "" {
		h += "&adal_cid=" + cid
	}
	return h
}

// withHand: the address with the hand after # (unchanged when it has one or there is none).
func withHand(root, u string) string {
	h := handFor(root, savedNumber(root))
	if h == "" || strings.Contains(u, "#") {
		return u
	}
	return u + "#" + h
}
