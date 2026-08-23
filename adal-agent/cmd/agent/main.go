package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adalsoftware/adal-agent/internal/events"
	"github.com/adalsoftware/adal-agent/internal/watcher"
)

func main() {
	serverURL := os.Getenv("ADAL_SERVER_URL")
	if serverURL == "" {
		serverURL = "http://localhost:4000"
	}

	clientID := os.Getenv("ADAL_CLIENT_ID")
	if clientID == "" {
		clientID = "client-" + fmt.Sprintf("%d", time.Now().Unix())
	}

	log.Printf("🚀 Adal Agent starting... Server: %s, Client: %s", serverURL, clientID)

	sender := events.NewSender(serverURL, clientID)
	fw := watcher.NewFileWatcher(sender)
	bw := watcher.NewBrowserWatcher(sender)
	aw := watcher.NewActiveWindowWatcher(sender)

	go fw.Start()
	go bw.Start()
	go aw.Start()
	go sender.StartHeartbeat()

	log.Println("✅ All watchers running. Press Ctrl+C to stop.")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("🛑 Shutting down...")
	fw.Stop()
	bw.Stop()
	aw.Stop()
}
