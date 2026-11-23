//go:build windows

package main

// autostart_windows.go — this program starts with Windows (2026-11-23: a Companion
// was not running after a reboot, so the office's PCs did not update or copy each
// other). Only this background program, with no window: Adal Keep's window still
// opens only from its icon (the 2026-11-14 rule). Put right at every start.
// Also: a firewall that blocks it (Windows' own block rule, no allow rule) is
// repaired by the support task (elevated, support-setup.ps1) — this program asks
// it to run.

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

const runValue = "AdalKeepCompanion"

func ensureAutostart() {
	if os.Getenv("ADAL_NO_AUTOSTART") == "1" {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	want := `"` + exe + `"`
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		log.Printf("⚠️ autostart: %v", err)
		return
	}
	defer k.Close()
	if have, _, err := k.GetStringValue(runValue); err == nil && strings.EqualFold(have, want) {
		return
	}
	if err := k.SetStringValue(runValue, want); err != nil {
		log.Printf("⚠️ autostart: %v", err)
		return
	}
	log.Printf("🔁 Starts with Windows again (no window): %s", want)
}

// ensureFirewall: Windows lets the office reach this program (47810: updates and the
// copy for the other PCs). Checked by reading the rules (no rights needed); a missing
// allow rule or a block rule → the support task is asked to put it right.
func ensureFirewall() {
	time.Sleep(40 * time.Second)
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose")
	hideWindow(cmd)
	out, _ := cmd.CombinedOutput()
	allow, block := firewallState(string(out), exe)
	if allow && !block {
		return
	}
	log.Printf("🧱 Firewall: allow=%v block=%v for this program — asking the support task to repair it", allow, block)
	c := exec.Command("schtasks.exe", "/Run", "/TN", "Adal Keep Support (Companion)")
	hideWindow(c)
	_ = c.Run()
}
