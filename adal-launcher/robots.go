//go:build windows

// robots.go — Adal Robots (backend\robots\adal-robots.mjs, its own Node) kept running on the main
// PC by this launcher, with no window, started again when it stops. The server's own start of it
// (services/robotsLink.js keepRobotsRunning) steps aside: the server gets ADAL_ROBOTS_SPAWN=0.
// One already answering on 127.0.0.1:4010 (started by an older server, detached) is left to run:
// never two Adal Robots.
package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const robotsHealth = "http://127.0.0.1:4010/health"

func robotsAnswer() bool {
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Get(robotsHealth)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// robotsHere: this install has Adal Robots (a release since 7e455b5) and is the main PC's.
func robotsHere(root string) bool {
	if employeePC(root) || companionInstall(root) {
		return false
	}
	_, err := os.Stat(filepath.Join(root, "backend", "robots", "adal-robots.mjs"))
	return err == nil
}

func keepRobotsRunning(root string) {
	backend := filepath.Join(root, "backend")
	for {
		if !robotsHere(root) || robotsAnswer() {
			time.Sleep(30 * time.Second)
			continue
		}
		out, _ := os.OpenFile(filepath.Join(backend, "data", "robots.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		cmd := hidden(exec.Command(filepath.Join(root, "runtime", "node.exe"), filepath.Join("robots", "adal-robots.mjs")))
		cmd.Env = append(os.Environ(), "ADAL_ROBOTS_IN_APP=", "ADAL_HIDDEN_AGENTS=1")
		cmd.Dir = backend
		cmd.Stdout, cmd.Stderr = out, out
		logf("starting Adal Robots")
		t0 := time.Now()
		err := cmd.Run()
		if out != nil {
			out.Close()
		}
		logf("Adal Robots stopped (%v) — starting it again", err)
		if time.Since(t0) < 15*time.Second {
			time.Sleep(30 * time.Second) // it fails at once: do not spin
		} else {
			time.Sleep(3 * time.Second)
		}
	}
}
