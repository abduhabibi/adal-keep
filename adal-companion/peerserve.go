package main

// A Companion newer than its main PC (installed from the USB, say) hands its signed release to Main
// (the owner, 2026-11-27: "the PCs update each other so all of them always run the same version").
//
//   GET /peer/release        the release kept here ({ manifest, signature }), only when Adal's signature holds
//   GET /peer/file/<sha256>  one piece that release names, only when its SHA-256 still matches
//
// Main checks the signature and every SHA-256 again itself (adal-keep-backend services/peerUpdate.js):
// this PC is not trusted, and nothing here writes. Off: ADAL_PEER_UPDATES=0.

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
)

func peerUpdatesOn() bool { return os.Getenv("ADAL_PEER_UPDATES") != "0" }

// peerNames: every SHA-256 the kept release names (pieces, their plain forms, patches).
func peerNames(m *releaseManifest) map[string]bool {
	ok := map[string]bool{}
	for _, p := range allPieces(m) {
		ok[strings.ToLower(p.SHA256)] = true
		if p.Raw != nil {
			ok[strings.ToLower(p.Raw.SHA256)] = true
		}
	}
	return ok
}

func (u *updater) peerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/peer/release", func(w http.ResponseWriter, r *http.Request) {
		if !peerUpdatesOn() {
			http.NotFound(w, r)
			return
		}
		m, env := u.current()
		if m == nil || env == nil {
			http.Error(w, "no signed release kept here", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"`+m.SHA+`"`)
		json.NewEncoder(w).Encode(env)
	})
	mux.HandleFunc("/peer/file/", func(w http.ResponseWriter, r *http.Request) {
		if !peerUpdatesOn() {
			http.NotFound(w, r)
			return
		}
		sha := strings.ToLower(strings.TrimPrefix(r.URL.Path, "/peer/file/"))
		m, _ := u.current()
		if m == nil || !hexSHA.MatchString(sha) || !peerNames(m)[sha] {
			http.Error(w, "not in the signed release kept here", http.StatusNotFound)
			return
		}
		p := u.piecePath(sha)
		if p == "" || fileSHA(p) != sha {
			http.Error(w, "not kept here", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, p)
	})
}
