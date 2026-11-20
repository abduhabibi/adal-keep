package main

// support.go — Settings → "Remote support by Adal" on a Companion PC (asked on
// 2026-11-20). Adal Keep's window on a Companion shows the main PC's pages, so
// the switch of THIS PC is answered here, on 127.0.0.1:47810, like the update
// buttons. The switch is <install>\support-off.flag (default ON: no file);
// the SYSTEM task "Adal Keep Support (Companion)" applies it (switching off
// does what "Adal Disconnect" does) and writes adal-support.log; AdalKeep.exe
// repairs the access at every start unless the flag is there.

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

func supportFlagFile() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "support-off.flag")
	}
	return "support-off.flag"
}

func supportIsOn() bool {
	_, err := os.Stat(supportFlagFile())
	return err != nil
}

// supportSet writes or removes the switch and, on Windows, starts the task that applies it.
func supportSet(on bool, who string) error {
	f := supportFlagFile()
	if on {
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else if err := os.WriteFile(f, []byte(fmt.Sprintf("off by %s at %s\n", who, time.Now().UTC().Format(time.RFC3339))), 0o644); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		_ = exec.Command("schtasks.exe", "/Run", "/TN", "Adal Keep Support (Companion)").Start()
	}
	return nil
}

// supportOriginOK: Adal Keep's own pages — on this PC or on the office network's main PC.
func supportOriginOK(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" {
		return false
	}
	h := u.Hostname()
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

func supportHandler(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		http.Error(w, "only from this PC", http.StatusForbidden)
		return
	}
	if o := r.Header.Get("Origin"); o != "" {
		if !supportOriginOK(o) {
			http.Error(w, "not from there", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Adal")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodPost {
		if r.Header.Get("X-Adal") == "" {
			http.Error(w, "missing header", http.StatusForbidden)
			return
		}
		var body struct {
			On bool `json:"on"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		who := os.Getenv("USERNAME")
		if who == "" {
			who = "this PC"
		}
		if err := supportSet(body.On, who); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else if r.Method != http.MethodGet {
		http.Error(w, "GET or POST", http.StatusMethodNotAllowed)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"on": supportIsOn(), "companion": true})
}
