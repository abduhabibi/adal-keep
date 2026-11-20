package main

import (
	"net"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// setBroadcast: SO_BROADCAST on a UDP socket (sockopt_*.go).
func setBroadcast(c *net.UDPConn) {
	if rc, err := c.SyscallConn(); err == nil {
		_ = rc.Control(func(fd uintptr) { _ = setSockoptBroadcast(fd) })
	}
}

// hideWindow: a program started from here shows no console window (hide_*.go).
func hideWindow(cmd *exec.Cmd) { hideCmd(cmd) }

// isActingURL: this PC's own Adal Keep standing in for the main PC (127.0.0.1:4140).
func isActingURL(u string) bool {
	return isLoopbackURL(u) && strings.HasSuffix(strings.TrimRight(u, "/"), ":"+strconv.Itoa(actingPort))
}

// windowsTar: Windows' own tar (never another one on the PATH, such as Git's).
func windowsTar() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return filepath.Join(root, "System32", "tar.exe")
	}
	return "tar.exe"
}

// selfReplaced: a new adal-companion.exe was put in place by an update.
var selfReplaced bool

// restartSelfSoon: the new adal-companion.exe takes over — started by a small
// waiting command once this one has ended (its ports and its one-copy lock free).
func restartSelfSoon() {
	if strings.HasSuffix(strings.ToLower(filepath.Base(os.Args[0])), ".test.exe") {
		return // the tests: never ended
	}
	time.Sleep(3 * time.Second)
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := cmdLine(restartLine(exe))
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		log.Printf("⚠️ the new Companion could not be started now (it is used from the next start): %v", err)
		return
	}
	log.Printf("🔄 The new Companion takes over in a few seconds")
	os.Exit(0)
}

// restartLine: wait about 3 s (this program ends meanwhile), then start the new one.
func restartLine(exe string) string {
	return `ping -n 4 127.0.0.1 >nul & start "" "` + exe + `"`
}
