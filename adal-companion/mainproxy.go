// mainproxy.go — the Companion's own online pages reach the main PC over the
// office network (asked on 2026-11-19: "make the Companion really fast, like
// on Main; it will back up later").
//
// While the window shows the online pages (127.0.0.1:47801, AdalKeep.exe),
// its calls, documents and uploads went through the internet. Now, whenever
// the main PC answers on the network, AdalKeep.exe hands them here
// (/lan-api/… → 127.0.0.1:47810/local/main/…) and this program sends them
// straight to the main PC with this Companion's key (the one it joined with,
// replica.go). Only this PC itself may ask (never another computer).
package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	mainProxyClient = &http.Client{Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
		ResponseHeaderTimeout: 3 * time.Minute,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
	}}
	proxyKeyMu sync.Mutex
)

// fromThisPC: only a program on this PC (AdalKeep.exe), never the network.
func fromThisPC(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback() && r.Header.Get("X-Adal") == "1"
}

// mainAccessKey: this Companion's key for the main PC (joined with its number once).
func mainAccessKey(fresh bool) (string, error) {
	proxyKeyMu.Lock()
	defer proxyKeyMu.Unlock()
	keys := loadKeys()
	if keys.AccessKey != "" && !fresh {
		return keys.AccessKey, nil
	}
	id := loadIdentity()
	if id.Number == "" {
		return "", errNoNumber
	}
	k, err := joinWithNumber(id.Number)
	if err != nil {
		return "", err
	}
	keys = loadKeys()
	keys.AccessKey = k
	return k, saveKeys(keys)
}

// Headers handed on each way (nothing else: no cookies, no Origin).
var proxyAsk = []string{"Content-Type", "Accept", "Accept-Encoding", "Range", "If-None-Match", "If-Modified-Since"}
var proxyAnswer = []string{"Content-Type", "Content-Length", "Content-Encoding", "Content-Disposition", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified", "Vary"}

func addMainProxy(mux *http.ServeMux) {
	// What this PC does as a main PC in waiting (standby.go), for its window.
	mux.HandleFunc("/local/standby", func(w http.ResponseWriter, r *http.Request) {
		if !fromThisPC(r) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(standbyStatus())
	})
	// Where this program finds the main PC now (by its network card, discovery):
	// AdalKeep.exe tries it too, so the window stays on the office network.
	mux.HandleFunc("/local/host", func(w http.ResponseWriter, r *http.Request) {
		if !fromThisPC(r) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(strings.TrimRight(hostServer, "/")))
	})
	mux.HandleFunc("/local/main/", func(w http.ResponseWriter, r *http.Request) {
		if !fromThisPC(r) {
			http.NotFound(w, r)
			return
		}
		if hostServer == "" {
			http.Error(w, `{"error":"no main PC"}`, http.StatusBadGateway)
			return
		}
		key, err := mainAccessKey(false)
		if err != nil {
			http.Error(w, `{"error":"not joined to the main PC"}`, http.StatusBadGateway)
			return
		}
		target := strings.TrimRight(hostServer, "/") + "/api/" + strings.TrimPrefix(r.URL.Path, "/local/main/")
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
		if err != nil {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		req.ContentLength = r.ContentLength
		for _, h := range proxyAsk {
			if v := r.Header.Get(h); v != "" {
				req.Header.Set(h, v)
			}
		}
		req.Header.Set("x-adal-pc", key)
		resp, err := mainProxyClient.Do(req)
		if err != nil {
			http.Error(w, `{"error":"the main PC does not answer on the network"}`, http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for _, h := range proxyAnswer {
			if v := resp.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.Header().Set("X-Adal-Via", "lan")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})
}
