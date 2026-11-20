package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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
