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

// lastPing: what pingServer last wrote to the log.
var lastPing string

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
		Macs    []string `json:"macs"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info); err != nil {
		return true // it answered 200 — good enough
	}
	// The router gave this address to another PC, which also runs Adal Keep:
	// not ours unless it says our number is its own (mainid.go).
	// Checked every time (not only when the card changed): the address may
	// always have gone to another agency's PC. Nothing is sent to it.
	if !confirmedOurs(hostServer) {
		log.Printf("⚠️ %s is another main PC (not ours) — nothing is sent there, looking for ours", hostServer)
		hostServer = ""
		os.Setenv("ADAL_HOST_URL", "")
		return false
	}
	// Its network card: found by it next time the router moves it (mainid.go).
	learnMain(hostServer, info.Macs)
	// keepFindingServer asks every 30 seconds: say it only when something
	// changed, not two log lines every 30 seconds all day.
	said := strings.TrimSpace(info.Name) + "|" + hostServer + "|" + strings.Join(info.Lan, ", ")
	if said == lastPing {
		return true
	}
	lastPing = said
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
	st, err := f.Stat()
	if err != nil {
		return err
	}

	// The file itself is read straight from the disk while it is sent: only
	// the small parts around it are kept in memory (a scan used to be copied
	// into memory whole first). The bytes sent are the same as before.
	var head, tail bytes.Buffer
	sw := &switchWriter{to: &head}
	w := multipart.NewWriter(sw)
	if _, err := w.CreateFormFile("file", filename); err != nil {
		return err
	}
	sw.to = &tail
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
	size := st.Size()
	payload := io.MultiReader(bytes.NewReader(head.Bytes()), io.LimitReader(f, size), bytes.NewReader(tail.Bytes()))
	req, err := http.NewRequest(http.MethodPost, url, payload)
	if err != nil {
		return err
	}
	req.ContentLength = int64(head.Len()) + size + int64(tail.Len())
	// Lets Go send it again by itself when a kept-open connection turns out
	// closed by the main PC (the in-memory copy allowed that before).
	req.GetBody = func() (io.ReadCloser, error) {
		g, err := os.Open(filePath)
		if err != nil {
			return nil, err
		}
		return struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(head.Bytes()), io.LimitReader(g, size), bytes.NewReader(tail.Bytes())), g}, nil
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

// switchWriter lets the multipart parts before and after the file go into
// separate buffers.
type switchWriter struct{ to io.Writer }

func (s *switchWriter) Write(p []byte) (int, error) { return s.to.Write(p) }

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
	if standbyActing() {
		return false
	}
	log.Println("🔁 Re-scanning the LAN for the Adal Keep server...")
	if info := discoverServer(2500 * time.Millisecond); info != nil && strings.TrimRight(info.URL, "/") != strings.TrimRight(hostServer, "/") {
		log.Printf("👉 Server found at %s", info.URL)
		hostServer = info.URL
		rememberHostURL(info.URL)
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
