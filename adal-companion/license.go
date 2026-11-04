package main

// license.go — the Companion works only while the main Adal Keep PC is paid
// for (or in its free trial). When the main PC is locked, the Companion stops
// sending files and says so in its log. Nothing opens by itself: the payment
// screen shows when Adal Keep is opened.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	lockCheckEvery = 2 * time.Minute
	popupEvery     = time.Hour        // while locked, show the popup again this often
	popupOnFileGap = 10 * time.Minute // a file dropped while locked shows it at most this often
)

var (
	lockMu    sync.Mutex
	locked    bool
	lastPopup time.Time
)

// serverLocked reports whether the main PC is locked (as last checked).
func serverLocked() bool {
	lockMu.Lock()
	defer lockMu.Unlock()
	return locked
}

// checkLock asks the main PC whether it is locked. An unreachable server
// changes nothing: the Companion only stops when the server says so.
func checkLock() {
	resp, err := httpClient.Get(strings.TrimRight(hostServer, "/") + "/api/subscription/status")
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var st struct {
		Mode string `json:"mode"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&st) != nil || st.Mode == "" {
		return
	}
	setLocked(st.Mode == "locked")
}

// setLocked records the state; going locked shows the popup right away.
func setLocked(now bool) {
	lockMu.Lock()
	was := locked
	locked = now
	lockMu.Unlock()
	switch {
	case now && !was:
		log.Printf("🔒 %s is locked (not paid) — the Companion stops sending files until it is unlocked", serverDisplayName)
		showPayPopup(0)
	case !now && was:
		log.Printf("🔓 %s is unlocked — the Companion is working again", serverDisplayName)
	case now:
		showPayPopup(popupEvery)
	}
}

// watchLock checks the main PC now and then for as long as the Companion runs.
func watchLock() {
	checkLock()
	go func() {
		for range time.Tick(lockCheckEvery) {
			checkLock()
		}
	}()
}

// showPayPopup: a note in the log, at most every `gap`. No page is opened.
func showPayPopup(gap time.Duration) {
	lockMu.Lock()
	defer lockMu.Unlock()
	if gap > 0 && time.Since(lastPopup) < gap {
		return
	}
	lastPopup = time.Now()
	log.Printf("🔒 %s needs paying: open Adal Keep to unlock it", serverDisplayName)
}

// lockedResponse tells whether an upload was refused because the main PC is locked.
func lockedResponse(resp *http.Response, body []byte) bool {
	return resp.StatusCode == http.StatusPaymentRequired && strings.Contains(string(body), "locked")
}
