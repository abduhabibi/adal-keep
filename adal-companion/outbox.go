package main

// outbox.go — a file the Companion could not hand to the main PC is never
// dropped. It waits in companion-outbox.json (next to the program, so it
// survives a restart) and is sent again every 30 seconds — and when the
// Companion starts — until the main PC confirms it has stored it.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type waiting struct {
	Path  string    `json:"path"`
	Name  string    `json:"name"`
	Since time.Time `json:"since"`
	Tries int       `json:"tries"`
}

var (
	outboxMu sync.Mutex
	outbox   []waiting
)

func outboxFile() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "companion-outbox.json")
	}
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "adal-companion-outbox.json")
}

func saveOutbox() { // caller holds outboxMu
	data, _ := json.MarshalIndent(outbox, "", "  ")
	tmp := outboxFile() + ".tmp"
	if os.WriteFile(tmp, data, 0o644) == nil {
		os.Rename(tmp, outboxFile())
	}
}

// queueForRetry keeps a file to send later (once per file).
func queueForRetry(path, name string) {
	outboxMu.Lock()
	defer outboxMu.Unlock()
	for _, w := range outbox {
		if w.Path == path {
			return
		}
	}
	outbox = append(outbox, waiting{Path: path, Name: name, Since: time.Now()})
	saveOutbox()
	log.Printf("📥 %s waits to be sent (%d waiting) — it is sent as soon as the main PC answers", name, len(outbox))
}

func pendingCount() int {
	outboxMu.Lock()
	defer outboxMu.Unlock()
	return len(outbox)
}

// retryOutbox sends what is waiting; what the main PC stored leaves the list.
func retryOutbox() {
	outboxMu.Lock()
	list := append([]waiting(nil), outbox...)
	outboxMu.Unlock()
	if len(list) == 0 || serverLocked() {
		return
	}
	done := map[string]bool{}
	for _, w := range list {
		if _, err := os.Stat(w.Path); err != nil {
			log.Printf("⚠️ %s was moved or deleted before it could be sent — dropped from the waiting list", w.Name)
			done[w.Path] = true
			continue
		}
		err := postIngest(w.Path, w.Name)
		switch {
		case err == nil:
			log.Printf("✅ sent after waiting: %s", w.Name)
			done[w.Path] = true
		case isRejected(err):
			log.Printf("❌ the main PC refused %s for good: %v", w.Name, err)
			done[w.Path] = true
		default:
			if err == errLocked {
				return
			}
			if _, failing := err.(serverError); failing && w.Tries >= 20 {
				// Reachable but failing on this one file for ~10 minutes: stop.
				// The original stays where it is on this PC.
				log.Printf("❌ the main PC keeps failing on %s (%v) — stopped trying; the file is still in its folder", w.Name, err)
				done[w.Path] = true
				continue
			}
			// Main PC still unreachable: try the rest later too.
			outboxMu.Lock()
			for i := range outbox {
				if outbox[i].Path == w.Path {
					outbox[i].Tries++
				}
			}
			outboxMu.Unlock()
			if rediscover() {
				continue
			}
			goto save
		}
	}
save:
	outboxMu.Lock()
	kept := outbox[:0]
	for _, w := range outbox {
		if !done[w.Path] {
			kept = append(kept, w)
		}
	}
	outbox = kept
	saveOutbox()
	outboxMu.Unlock()
}

// watchOutbox loads the waiting list and retries it every 30 seconds.
func watchOutbox() {
	if data, err := os.ReadFile(outboxFile()); err == nil {
		outboxMu.Lock()
		json.Unmarshal(data, &outbox)
		n := len(outbox)
		outboxMu.Unlock()
		if n > 0 {
			log.Printf("📥 %d file(s) still waiting from before — sending them now", n)
		}
	}
	go func() {
		retryOutbox()
		for range time.Tick(30 * time.Second) {
			retryOutbox()
		}
	}()
}
