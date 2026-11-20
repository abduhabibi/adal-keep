//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func hideCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// cmdLine: cmd.exe /c <line>, the line handed over as it is (Go's own quoting
// is for programs, not for cmd), with no window.
func cmdLine(line string) *exec.Cmd {
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000, CmdLine: `cmd.exe /c ` + line}
	return cmd
}
