//go:build windows

// online.go — Adal Keep on an employee PC while the main PC is off.
//
// The Companion install carries the phone app's pages (the "online" folder):
// they work from the agency's online copy in Supabase, not from the main PC.
// AdalKeep.exe serves them to this PC only (127.0.0.1) and opens them when the
// main PC does not answer. The first time, the page asks for the PC's number
// and the main PC says Yes, like a phone, so that needs the main PC on once.
//
// /tg fetches a document from Telegram for the page: Telegram does not let
// pages read its files. Documents are encrypted; the page decrypts them.
package main

import (
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"time"
)

const onlineAddr = "127.0.0.1:47801"

var onlineURL = "http://" + onlineAddr + "/"

func hasOnlinePages(root string) bool {
	return fileExists(filepath.Join(root, "online", "index.html"))
}

// offlineURL: what opens while the main PC does not answer.
func offlineURL(root string) string {
	if hasOnlinePages(root) {
		return onlineURL
	}
	return connectURL
}

func telegramFile(w http.ResponseWriter, r *http.Request) {
	u, err := url.Parse(r.URL.Query().Get("u"))
	if r.Method != http.MethodGet || err != nil || u.Scheme != "https" || u.Host != "api.telegram.org" {
		http.Error(w, "Telegram addresses only", http.StatusForbidden)
		return
	}
	c := &http.Client{Timeout: 2 * time.Minute}
	resp, err := c.Get(u.String())
	if err != nil {
		http.Error(w, "Telegram did not answer", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// startOnlinePage serves the online folder; false when there is none or the port is taken.
func startOnlinePage(root string) bool {
	if !hasOnlinePages(root) {
		return false
	}
	ln, err := net.Listen("tcp", onlineAddr)
	if err != nil {
		logf("online pages: %v", err)
		return false
	}
	// Windows' registry can name these wrongly, and then the page will not load.
	for ext, t := range map[string]string{".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2"} {
		mime.AddExtensionType(ext, t)
	}
	dir := filepath.Join(root, "online")
	files := http.FileServer(http.Dir(dir))
	mux := http.NewServeMux()
	mux.HandleFunc("/tg", telegramFile)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		p := path.Clean("/" + r.URL.Path)
		if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(p))); err == nil && (!st.IsDir() || p == "/") {
			files.ServeHTTP(w, r)
			return
		}
		// A page's own address (/profiles/12): the app draws it.
		b, err := os.ReadFile(filepath.Join(dir, "index.html"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	})
	// Only this PC's own address: another website's name pointed here is refused.
	guard := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != onlineAddr {
			http.Error(w, "Not this address", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
	go http.Serve(ln, guard)
	return true
}
