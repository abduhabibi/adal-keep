package watcher

import (
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/adalsoftware/adal-agent/internal/events"
)

type ActiveWindowWatcher struct {
	sender       *events.Sender
	done         chan struct{}
	lastWindowTitle string
}

func NewActiveWindowWatcher(sender *events.Sender) *ActiveWindowWatcher {
	return &ActiveWindowWatcher{sender: sender, done: make(chan struct{})}
}

func (aw *ActiveWindowWatcher) Start() {
	log.Println("🪟 Active window watcher started (polling every 5s)")
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			title := getActiveWindowTitle()
			if title != "" && title != aw.lastWindowTitle {
				aw.lastWindowTitle = title
				aw.sender.Send("active_window", map[string]interface{}{
					"title": title,
				})
			}
		case <-aw.done:
			return
		}
	}
}

func getActiveWindowTitle() string {
	cmd := exec.Command("powershell", "-Command",
		"(Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Sort-Object -Property MainWindowTitle | Select-Object -First 1).MainWindowTitle")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (aw *ActiveWindowWatcher) Stop() {
	close(aw.done)
}
