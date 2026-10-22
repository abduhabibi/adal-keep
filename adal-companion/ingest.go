package main

// ingest.go — the upload path.
//
// The raw file goes to /api/companion/ingest: the
// server puts it in the file tray (or straight onto a profile field) and
// re-runs the passport verification ticks, which is what makes the operator's
// three green lights move while the employee is still standing at the
// scanner.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"
)

// waitForStableFile blocks until the file stops growing and is no longer
// locked by the scanner/copier writing it, so a half-written passport scan is
// never uploaded (a truncated PDF would fail the "document read" tick).
func waitForStableFile(path string, maxWait time.Duration) bool {
	deadline := time.Now().Add(maxWait)
	last := int64(-1)
	stable := 0

	for time.Now().Before(deadline) {
		info, err := os.Stat(path)
		if err != nil {
			return false
		}
		if info.Size() > 0 && info.Size() == last && !isFileLocked(path) {
			stable++
			if stable >= 2 {
				return true
			}
		} else {
			stable = 0
		}
		last = info.Size()
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

// isFileLocked reports whether another process still holds the file open for
// writing (Windows scanners keep the handle until the scan is flushed).
func isFileLocked(path string) bool {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return true
	}
	f.Close()
	return false
}

// serverDisplayName remembers the company name reported by /companion/info so
// log lines can say "Adal Sunrise Recruitment" instead of an IP.
var serverDisplayName = "Adal Keep"

// pingServer confirms the discovered address really is an Adal Keep server
// and reports which company it belongs to.
func pingServer() bool {
	url := strings.TrimRight(hostServer, "/") + "/api/companion/info"
	resp, err := httpClient.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var info struct {
		Name    string   `json:"name"`
		Port    int      `json:"port"`
		Primary string   `json:"primary_address"`
		Lan     []string `json:"lan_addresses"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info); err != nil {
		return true // it answered 200 — good enough
	}
	if strings.TrimSpace(info.Name) != "" {
		serverDisplayName = "Adal " + strings.TrimSpace(info.Name)
		log.Printf("✅ Connected to %s", serverDisplayName)
	}
	if len(info.Lan) > 0 {
		log.Printf("   Server LAN address(es): %s", strings.Join(info.Lan, ", "))
	}
	return true
}

// postIngest uploads one file to the server's Companion ingest endpoint.
func postIngest(filePath, filename string) error {
	clientID := fmt.Sprintf("companion-%s", clientName)

	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, f); err != nil {
		return err
	}
	_ = w.WriteField("client_id", clientID)
	_ = w.WriteField("filename", filename)

	// Optional pinning, set by IT in the shortcut for a dedicated PC that
	// always scans one document type onto one profile.
	if pid := strings.TrimSpace(os.Getenv("ADAL_PROFILE_ID")); pid != "" {
		_ = w.WriteField("profile_id", pid)
	}
	if field := strings.TrimSpace(os.Getenv("ADAL_FIELD")); field != "" {
		_ = w.WriteField("field", field)
	}
	if err := w.Close(); err != nil {
		return err
	}

	url := strings.TrimRight(hostServer, "/") + "/api/companion/ingest"
	req, err := http.NewRequest(http.MethodPost, url, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("X-Adal-Client", clientID)

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if lockedResponse(resp, body) {
		setLocked(true)
		return errLocked
	}
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		// The main PC answered and does not want this file: sending it again will not help.
		return rejectedError{fmt.Sprintf("server rejected the file (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))}
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return serverError{fmt.Sprintf("server could not store the file (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))}
	}

	var out struct {
		Mode       string `json:"mode"`
		FileID     int64  `json:"fileId"`
		TicksCount *int   `json:"ticks_count"`
		AllGreen   *bool  `json:"all_green"`
	}
	_ = json.Unmarshal(body, &out)

	where := "file tray"
	if out.Mode == "profile" {
		where = "profile field"
	}
	log.Printf("✅ %s → %s (file #%d)", filename, where, out.FileID)
	if out.TicksCount != nil {
		green := "not all green yet"
		if out.AllGreen != nil && *out.AllGreen {
			green = "ALL GREEN — ready for police clearance"
		}
		log.Printf("   Passport ticks: %d/3 · %s", *out.TicksCount, green)
	}
	return nil
}

// uploadToIngest delivers a file and, on transport failure, re-scans the LAN
// once — a DHCP lease change is the most likely reason a previously working
// server address stopped answering.
// errLocked: the main PC refused the file because it is not paid for.
var errLocked = fmt.Errorf("the main Adal Keep PC is locked")

func uploadToIngest(filePath, filename string) {
	err := postIngest(filePath, filename)
	switch {
	case err == nil:
		return
	case err == errLocked:
		log.Printf("🔒 Not sent yet (%s is locked until it is paid for): %s", serverDisplayName, filename)
		queueForRetry(filePath, filename)
		return
	case isRejected(err):
		log.Printf("❌ %s: %v", filename, err)
		return
	}
	log.Printf("⚠️ Ingest failed: %v", err)
	if rediscover() {
		if postIngest(filePath, filename) == nil {
			return
		}
	}
	// Never dropped: it waits and is sent as soon as the main PC answers.
	queueForRetry(filePath, filename)
}

// rediscover looks for the main PC on the LAN again (a DHCP lease change is
// the usual reason a known address stops answering). True when it moved.
func rediscover() bool {
	log.Println("🔁 Re-scanning the LAN for the Adal Keep server...")
	if info := discoverServer(2500 * time.Millisecond); info != nil && strings.TrimRight(info.URL, "/") != strings.TrimRight(hostServer, "/") {
		log.Printf("👉 Server found at %s", info.URL)
		hostServer = info.URL
		return true
	}
	return false
}

// serverError: the main PC answered but failed (5xx) — it is reachable.
type serverError struct{ msg string }

func (e serverError) Error() string { return e.msg }

type rejectedError struct{ msg string }

func (e rejectedError) Error() string { return e.msg }

func isRejected(err error) bool { _, ok := err.(rejectedError); return ok }
