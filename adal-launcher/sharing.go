//go:build windows

package main

// sharing.go — what "Adal Connect" did by hand on each PC, now in Adal Keep
// itself (asked on 2026-11-20: "adal connect won't run in every PC … add this
// system into adal keep too, but make it secure"): the PCs of an office share
// updates, the copy of the agency (data and documents), the server in waiting
// and which Companion stands in for the main PC. Windows lets that in only
// with a firewall rule, which only an administrator can add:
//
//   - a new install adds them (the installer runs as administrator);
//   - a PC installed before asks once — Windows' own "Allow?" prompt, after
//     Adal Keep says why — and, when it is declined, not again for a week.
//
// The rules let in only the office network itself (localsubnet), only these
// ports, and every piece that comes over them is still checked (updates are
// signed by Adal, the copy is locked with the agency's key).

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

const sharingRule = "Adal Keep Sharing (LAN)"

// sharingCommands: what the administrator prompt runs (one cmd line).
func sharingCommands() string {
	return strings.Join([]string{
		`netsh advfirewall firewall delete rule name="Adal Keep Sharing (LAN)"`,
		`netsh advfirewall firewall add rule name="Adal Keep Sharing (LAN)" dir=in action=allow protocol=UDP localport=45455,45456 remoteip=localsubnet profile=any`,
		`netsh advfirewall firewall delete rule name="Adal Keep Sharing (LAN) TCP"`,
		`netsh advfirewall firewall add rule name="Adal Keep Sharing (LAN) TCP" dir=in action=allow protocol=TCP localport=47810 remoteip=localsubnet profile=any`,
	}, " & ")
}

func sharingRulesThere() bool {
	cmd := exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name="+sharingRule)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	out, err := cmd.Output()
	return err == nil && strings.Contains(string(out), sharingRule)
}

type sharingAsk struct {
	At string `json:"at"`
}

// askedLately: the prompt was shown in the last week (the answer is not asked again sooner).
func askedLately(root string, now time.Time) bool {
	b, err := os.ReadFile(filepath.Join(root, "sharing-asked.json"))
	if err != nil {
		return false
	}
	var a sharingAsk
	if json.Unmarshal(b, &a) != nil {
		return false
	}
	t, err := time.Parse(time.RFC3339, a.At)
	return err == nil && now.Sub(t) < 7*24*time.Hour
}

// ensureSharing: the rules there, or asked for once (a few seconds after start).
func ensureSharing(root string) {
	time.Sleep(20 * time.Second)
	if sharingRulesThere() || askedLately(root, time.Now()) {
		return
	}
	b, _ := json.Marshal(sharingAsk{At: time.Now().UTC().Format(time.RFC3339)})
	os.WriteFile(filepath.Join(root, "sharing-asked.json"), b, 0o644)
	title, _ := windows.UTF16PtrFromString("Adal Keep")
	text, _ := windows.UTF16PtrFromString("Let this PC share with the office's other Adal Keep PCs?\r\n\r\n" +
		"Updates, the agency's data and documents (locked with the agency's key), and standing in for the main PC when it is away.\r\n\r\n" +
		"Only the office network is let in. Windows asks for permission once.")
	if r, _ := windows.MessageBox(0, text, title, windows.MB_OKCANCEL|windows.MB_ICONQUESTION|windows.MB_SETFOREGROUND); r != 1 { // IDOK
		logf("office sharing: not allowed now (asked again in a week)")
		return
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	exe, _ := windows.UTF16PtrFromString("cmd.exe")
	args, _ := windows.UTF16PtrFromString("/c " + sharingCommands())
	if err := windows.ShellExecute(0, verb, exe, args, nil, windows.SW_HIDE); err != nil {
		logf("office sharing: %v", err)
		return
	}
	logf("office sharing: rules asked for")
}
