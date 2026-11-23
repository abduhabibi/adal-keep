//go:build windows

package main

// A crash of this program goes to Adal (Adal Keep Admin → Fleet → Crashes):
// the backend on this PC counts it (POST /api/tower/crash), grouped by message.
// Only the panic's message and the first lines of its stack; never blocks
// more than a few seconds, and the program still stops as before.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

// defer reportPanic() first thing in main().
func reportPanic() {
	if r := recover(); r != nil {
		sendCrash(fmt.Sprintf("panic: %v", r), string(debug.Stack()))
		panic(r)
	}
}

func sendCrash(message, stack string) {
	lines := strings.Split(stack, "\n")
	if len(lines) > 14 {
		lines = lines[:14]
	}
	body, _ := json.Marshal(map[string]string{"source": "launcher", "message": message, "where": "launcher", "stack": strings.Join(lines, "\n")})
	port := os.Getenv("PORT")
	if port == "" {
		port = "4000"
	}
	c := &http.Client{Timeout: 3 * time.Second}
	for _, base := range crashURLs("http://127.0.0.1:" + port) {
		if base == "" {
			continue
		}
		if r, err := c.Post(strings.TrimRight(base, "/")+"/api/tower/crash", "application/json", bytes.NewReader(body)); err == nil {
			r.Body.Close()
			if r.StatusCode < 300 {
				return
			}
		}
	}
}

func crashURLs(local string) []string { return []string{local} }
