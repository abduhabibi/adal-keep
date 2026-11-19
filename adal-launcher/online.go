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
	"encoding/json"
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
	forgetRoutes(root, mux)
	// The pairing page (connect.html) on this PC: the number typed there finds
	// the main PC on this network first (fast, no internet needed) …
	mux.HandleFunc("/lan-number", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-Adal") != "1" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		var in struct{ Number string }
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in)
		u, msg := joinByNumber(root, cleanNumber(in.Number), "")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"url": u, "error": msg})
	})
	// … else it pairs online with it (from anywhere); either way the log-out is over.
	mux.HandleFunc("/chosen", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-Adal") != "1" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		chosenMainPC(root)
		w.WriteHeader(http.StatusNoContent)
	})
	// The online account the window keeps: adal-companion.exe reads Adal's
	// signed updates from Supabase with it (adal-companion/selfupdate.go).
	mux.HandleFunc("/cloud-creds", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-Adal") != "1" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		var c struct {
			URL      string `json:"url"`
			Anon     string `json:"anon"`
			Email    string `json:"email"`
			Password string `json:"password"`
			Agency   string `json:"agency"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&c) != nil || c.URL == "" || c.Email == "" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		b, _ := json.Marshal(c)
		os.WriteFile(filepath.Join(root, "companion-cloud.json"), b, 0o600)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/main", func(w http.ResponseWriter, r *http.Request) {
		// Only the online pages ask (a header another website cannot send unasked).
		if r.Header.Get("X-Adal") != "1" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		// With this Companion's own id (hand.go): the main PC's page knows it is this one again.
		json.NewEncoder(w).Encode(map[string]string{"url": findMainPC(root, r.URL.Query().Get("try")), "cid": companionID(root)})
	})
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
