package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

var (
	hostServer = os.Getenv("ADAL_HOST_URL")
	clientName = os.Getenv("ADAL_CLIENT_NAME")
	watchDirs  []string
	httpClient = &http.Client{Timeout: 30 * time.Second}
)

func main() {
	log.SetFlags(log.LstdFlags)
	log.Printf("🚀 Adal Companion v3.0 — LAN auto-discovery + tray ingest")

	// Company name first (used in every log line and in the client id).
	if host := hostServer; host != "" {
		log.Printf("🌐 Server from ADAL_HOST_URL: %s", host)
	} else {
		hostServer = resolveHostURL()
	}
	if clientName == "" {
		h, _ := os.Hostname()
		clientName = h
	}

	log.Printf("   Server: %s", hostServer)
	log.Printf("   Client: %s", clientName)
	log.Printf("   Upload: /api/companion/ingest (file tray)")

	// Confirm we reached the right machine, and retry discovery once if not.
	if !pingServer() {
		log.Printf("⚠️ %s did not answer /api/companion/info", hostServer)
		if info := discoverServer(2500 * time.Millisecond); info != nil {
			hostServer = info.URL
			log.Printf("👉 Retrying via %s", hostServer)
			pingServer()
		}
	}

	// Not paid for: stop and show the payment popup on this PC too.
	watchLock()
	// Files that could not be sent before wait in the outbox until delivered.
	watchOutbox()

	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, "Downloads"),
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "OneDrive", "Desktop"), // Desktop kept in OneDrive
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			watchDirs = append(watchDirs, d)
			log.Printf("   📁 Watching: %s", d)
		}
	}

	announce(serverReachable(), serverDisplayName+" ("+hostServer+")", watchDirs)

	if len(watchDirs) == 0 {
		log.Fatal("❌ No directories to watch")
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Fatalf("❌ Watcher error: %v", err)
	}
	defer watcher.Close()

	for _, d := range watchDirs {
		watcher.Add(d)
	}

	log.Println("✅ Companion running. Monitoring files...")
	processed := make(map[string]time.Time)

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Create|fsnotify.Write) == 0 {
				continue
			}
			ext := strings.ToLower(filepath.Ext(event.Name))
			relevant := map[string]bool{
				".jpg": true, ".jpeg": true, ".png": true, ".bmp": true,
				".pdf": true, ".docx": true, ".xlsx": true,
			}
			if !relevant[ext] {
				continue
			}
			if last, exists := processed[event.Name]; exists && time.Since(last) < 5*time.Second {
				continue
			}
			// Only files that just arrived. Windows also reports files that were
			// already there when the antivirus or Explorer touches them.
			if at, ok := arrivedAt(event.Name); ok && time.Since(at) > 10*time.Minute {
				continue
			}
			processed[event.Name] = time.Now()
			// A scanner writes a file in bursts; never upload it half-way.
			if !waitForStableFile(event.Name, 20*time.Second) {
				log.Printf("⚠️ Still changing after 20s — uploading anyway: %s", filepath.Base(event.Name))
			}
			log.Printf("📄 Detected: %s", filepath.Base(event.Name))
			processAndUpload(event.Name)

		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Printf("⚠️ Error: %v", err)
		}
	}
}

// processAndUpload hands the file to the server's /api/companion/ingest: it
// goes into the file tray (or straight onto a profile field) and the passport
// checks run again.
func processAndUpload(filePath string) {
	if serverLocked() {
		log.Printf("🔒 Not sent yet (%s is locked until it is paid for): %s", serverDisplayName, filepath.Base(filePath))
		queueForRetry(filePath, filepath.Base(filePath)) // sent once it is unlocked
		showPayPopup(popupOnFileGap)
		return
	}
	uploadToIngest(filePath, filepath.Base(filePath))
}

// wantsStatus: opened from the shortcut (--show), not at Windows login.
func wantsStatus() bool {
	for _, a := range os.Args[1:] {
		if a == "--show" {
			return true
		}
	}
	return false
}

// serverReachable: the Adal Keep server answers right now.
func serverReachable() bool {
	resp, err := httpClient.Get(strings.TrimRight(hostServer, "/") + "/api/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}
