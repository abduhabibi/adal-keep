//go:build windows

package main

// support.go — remote support by Adal, part of Adal Keep (asked on 2026-11-20:
// no more double-clicking "Adal Connect"; Main's key had vanished).
//
// The installer set up OpenSSH, Adal's key and the firewall rules, and
// registered a SYSTEM scheduled task ("Adal Keep Support (Main|Companion)") that
// runs C:\ProgramData\AdalSupport\support-setup.ps1: it checks the key line,
// sshd (running, Automatic) and the firewall rules and repairs what is missing
// (and does what "Adal Disconnect" does when Settings → "Remote support by
// Adal" is off: <install>\support-off.flag). At every start this launcher:
//
//   - looks (sc.exe, no rights needed) whether sshd runs and is Automatic and
//     says so in launcher.log;
//   - asks the task to check and repair — quietly, no window. Elevated already,
//     it runs the script itself; with no task and no elevation it logs that and
//     skips (it never shows a Windows prompt for this).
//
// The key lives outside the install folder, so an update never removes it.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

func supportRole(root string) string {
	if employeePC(root) {
		return "Companion"
	}
	return "Main"
}

func supportTaskName(role string) string { return "Adal Keep Support (" + role + ")" }

func supportScript() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "AdalSupport", "support-setup.ps1")
}

// supportOff: Settings → "Remote support by Adal" is off.
func supportOff(root string) bool {
	_, err := os.Stat(filepath.Join(root, "support-off.flag"))
	return err == nil
}

func runQuiet(name string, args ...string) (string, error) {
	cmd := hidden(exec.Command(name, args...))
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// sshdState: whether the service exists, runs and starts by itself.
func sshdState() (exists, running, auto bool) {
	q, err := runQuiet("sc.exe", "query", "sshd")
	if err != nil && !strings.Contains(q, "STATE") {
		return false, false, false
	}
	running = strings.Contains(q, "RUNNING")
	c, _ := runQuiet("sc.exe", "qc", "sshd")
	auto = strings.Contains(c, "AUTO_START")
	return true, running, auto
}

func isElevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

// ensureSupport: checked at each start, a little after it, with no window.
func ensureSupport(root string) {
	time.Sleep(25 * time.Second)
	role := supportRole(root)
	off := supportOff(root)
	exists, running, auto := sshdState()
	switch {
	case off:
		logf("remote support: switched off in Settings — the task keeps it off (sshd present=%v running=%v)", exists, running)
	case exists && running && auto:
		logf("remote support: sshd running and Automatic — checking the key and firewall")
	default:
		logf("remote support: sshd present=%v running=%v automatic=%v — repairing", exists, running, auto)
	}
	script := supportScript()
	if _, err := os.Stat(script); err != nil {
		logf("remote support: %s is not on this PC (installed before it was built in) — skipped; install Adal Keep once more to set it up", script)
		return
	}
	if isElevated() {
		out, err := runQuiet("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
			"-File", script, "-Mode", "Auto", "-InstDir", root, "-Role", role)
		logf("remote support: checked directly (elevated): err=%v %s", err, strings.TrimSpace(out))
		return
	}
	if out, err := runQuiet("schtasks.exe", "/Run", "/TN", supportTaskName(role)); err != nil {
		logf("remote support: cannot elevate (the task %q did not start: %v %s) — skipped", supportTaskName(role), err, strings.TrimSpace(out))
		return
	}
	logf("remote support: task started")
}
