package watcher

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/adalsoftware/adal-agent/internal/events"
	"github.com/fsnotify/fsnotify"
)

type FileWatcher struct {
	sender  *events.Sender
	watcher *fsnotify.Watcher
	done    chan struct{}
}

func NewFileWatcher(sender *events.Sender) *FileWatcher {
	return &FileWatcher{sender: sender, done: make(chan struct{})}
}

func (fw *FileWatcher) Start() {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("❌ File watcher init failed: %v", err)
		return
	}
	fw.watcher = w

	dirs := []string{}
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "Downloads"),
		filepath.Join(home, "Documents"),
		"C:\\Users\\Public\\Documents",
	}
	for _, d := range candidates {
		if _, err := os.Stat(d); err == nil {
			dirs = append(dirs, d)
		}
	}

	for _, d := range dirs {
		if err := w.Add(d); err != nil {
			log.Printf("⚠️ Cannot watch %s: %v", d, err)
		} else {
			log.Printf("📁 Watching: %s", d)
		}
	}

	go func() {
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				name := strings.ToLower(ev.Name)
				isRelevant := strings.HasSuffix(name, ".pdf") ||
					strings.HasSuffix(name, ".jpg") ||
					strings.HasSuffix(name, ".jpeg") ||
					strings.HasSuffix(name, ".png") ||
					strings.HasSuffix(name, ".docx") ||
					strings.HasSuffix(name, ".xlsx")
				if isRelevant && (ev.Op&fsnotify.Create == fsnotify.Create || ev.Op&fsnotify.Write == fsnotify.Write) {
					info, _ := os.Stat(ev.Name)
					size := int64(0)
					if info != nil {
						size = info.Size()
					}
					fw.sender.Send("file_detected", map[string]interface{}{
						"path":      ev.Name,
						"extension": filepath.Ext(ev.Name),
						"size_bytes": size,
						"operation": ev.Op.String(),
					})
					log.Printf("📄 File detected: %s (%d bytes)", filepath.Base(ev.Name), size)
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				log.Printf("⚠️ File watcher error: %v", err)
			case <-fw.done:
				return
			}
		}
	}()
}

func (fw *FileWatcher) Stop() {
	close(fw.done)
	if fw.watcher != nil {
		fw.watcher.Close()
	}
}
