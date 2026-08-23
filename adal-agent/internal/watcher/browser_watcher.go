package watcher

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/adalsoftware/adal-agent/internal/events"
	_ "modernc.org/sqlite"
)

type BrowserWatcher struct {
	sender   *events.Sender
	done     chan struct{}
	lastSeen map[string]time.Time
}

func NewBrowserWatcher(sender *events.Sender) *BrowserWatcher {
	return &BrowserWatcher{
		sender:   sender,
		done:     make(chan struct{}),
		lastSeen: make(map[string]time.Time),
	}
}

func (bw *BrowserWatcher) Start() {
	log.Println("🌐 Browser history watcher started (polling every 30s)")
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			bw.checkChromeHistory()
			bw.checkEdgeHistory()
		case <-bw.done:
			return
		}
	}
}

func (bw *BrowserWatcher) checkChromeHistory() {
	home, _ := os.UserHomeDir()
	dbPath := filepath.Join(home, "AppData", "Local", "Google", "Chrome", "User Data", "Default", "History")
	bw.readHistory(dbPath, "chrome")
}

func (bw *BrowserWatcher) checkEdgeHistory() {
	home, _ := os.UserHomeDir()
	dbPath := filepath.Join(home, "AppData", "Local", "Microsoft", "Edge", "User Data", "Default", "History")
	bw.readHistory(dbPath, "edge")
}

func (bw *BrowserWatcher) readHistory(dbPath, browser string) {
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return
	}

	tmpPath := dbPath + ".adal_tmp"
	data, err := os.ReadFile(dbPath)
	if err != nil {
		return
	}
	os.WriteFile(tmpPath, data, 0644)
	defer os.Remove(tmpPath)

	db, err := sql.Open("sqlite", tmpPath+"?mode=ro")
	if err != nil {
		return
	}
	defer db.Close()

	rows, err := db.Query("SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 5")
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var url, title string
		var visitTime int64
		rows.Scan(&url, &title, &visitTime)

		key := browser + ":" + url
		if last, exists := bw.lastSeen[key]; exists {
			chromeTime := time.Unix(0, (visitTime-11644473600000000)*100)
			if !chromeTime.After(last) {
				continue
			}
		}
		bw.lastSeen[key] = time.Now()

		bw.sender.Send("browser_visit", map[string]interface{}{
			"browser": browser,
			"url":     url,
			"title":   title,
		})
	}
}

func (bw *BrowserWatcher) Stop() {
	close(bw.done)
}
