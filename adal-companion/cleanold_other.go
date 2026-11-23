//go:build !windows

package main

import (
	"os/exec"
	"strings"
)

// stopProgramsAt: (Linux, macOS: developers' PCs) pkill by full path.
func stopProgramsAt(paths []string, except int) {
	for _, p := range paths {
		if strings.TrimSpace(p) != "" {
			exec.Command("pkill", "-f", "^"+p).Run()
		}
	}
}
