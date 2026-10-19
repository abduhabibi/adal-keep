package main

// license.go — the Companion works only while the main Adal Keep PC is paid
// for (or in its free trial). When the main PC is locked, the Companion stops
// sending files and opens the Adal Keep page in the browser, which shows the
// payment popup there too.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os/exec"
	"runtime"
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

// showPayPopup opens the Adal Keep page (it shows the payment popup while
// locked), unless it was opened less than `gap` ago.
func showPayPopup(gap time.Duration) {
	lockMu.Lock()
	if gap > 0 && time.Since(lastPopup) < gap {
		lockMu.Unlock()
		return
	}
	lastPopup = time.Now()
	lockMu.Unlock()

	url := strings.TrimRight(hostServer, "/") + "/"
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("⚠️ Could not open the payment page: %v", err)
	}
}

// lockedResponse tells whether an upload was refused because the main PC is locked.
func lockedResponse(resp *http.Response, body []byte) bool {
	return resp.StatusCode == http.StatusPaymentRequired && strings.Contains(string(body), "locked")
}
