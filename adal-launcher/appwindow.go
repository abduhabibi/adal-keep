//go:build windows

// appwindow.go — Adal Keep's window opens at once, whatever the server is doing.
//
// The window's address is this small local door (127.0.0.1:47802). It passes
// everything to the server; while the server is not answering it shows
// "Adal Keep is starting…" and goes on by itself. So the icon always opens
// something, and when the server cannot start the window says why (the end of
// server.log) instead of nothing happening.
package main

import (
	"fmt"
	"html"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const appAddr = "127.0.0.1:47802"

var appURL = "http://" + appAddr + "/"

func appDoorOpen() bool {
	c, err := net.DialTimeout("tcp", appAddr, time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func logTail(root string) string {
	b, err := os.ReadFile(filepath.Join(root, "backend", "data", "server.log"))
	if err != nil {
		return "(no server.log yet)"
	}
	if len(b) > 1500 {
		b = b[len(b)-1500:]
	}
	return string(b)
}

const startingPage = `<!doctype html><html><head><meta charset="utf-8"><title>Adal Keep</title><meta http-equiv="refresh" content="2">
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,Segoe UI,sans-serif;background:#0f172a;color:#f1f5f9;text-align:center}
.d{width:44px;height:44px;margin:0 auto 18px;border:4px solid #334155;border-top-color:#14b8a6;border-radius:50%%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
pre{max-width:80vw;max-height:40vh;overflow:auto;text-align:left;font-size:12px;background:#020617;padding:12px;border-radius:8px}</style></head>
<body><div><div class="d"></div><h1 style="font-size:20px;margin:0 0 6px">Adal Keep is starting…</h1><p style="color:#94a3b8;margin:0">This opens by itself.</p>%s</div></body></html>`

func startAppDoor(root string) {
	ln, err := net.Listen("tcp", appAddr)
	if err != nil {
		logf("app door: %v", err)
		return
	}
	began := time.Now()
	target, _ := url.Parse(uiURL)
	own := "http://" + appAddr
	proxy := httputil.NewSingleHostReverseProxy(target)
	direct := proxy.Director
	proxy.Director = func(r *http.Request) {
		direct(r)
		r.Host = target.Host
		// Only this PC reaches the door: it must not look forwarded from elsewhere.
		r.Header["X-Forwarded-For"] = nil
		// Adal Keep's own page counts as the server's own. Any other website
		// keeps its address, and the server refuses it.
		if r.Header.Get("Origin") == own {
			r.Header.Set("Origin", uiURL)
		}
	}
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
		if strings.HasPrefix(r.URL.Path, "/api") || strings.HasPrefix(r.URL.Path, "/uploads") {
			http.Error(w, "Adal Keep is starting", http.StatusServiceUnavailable)
			return
		}
		why := ""
		if time.Since(began) > 90*time.Second {
			why = "<p style=\"color:#fca5a5\">It is taking too long. What the server said:</p><pre>" + html.EscapeString(logTail(root)) + "</pre>"
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, startingPage, why)
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != appAddr { // another website's name pointed here
			http.Error(w, "Not this address", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
}
