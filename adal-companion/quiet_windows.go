//go:build windows

package main

// On Windows the Companion has no window (built with -H windowsgui): its log
// goes to companion.log next to the program, and only one copy runs.

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func init() {
	name, _ := windows.UTF16PtrFromString(`Local\AdalKeepCompanion`)
	if _, err := windows.CreateMutex(nil, false, name); err == windows.ERROR_ALREADY_EXISTS {
		// Already running. Opened from its icon: say so instead of nothing.
		if wantsStatus() {
			messageBox("Adal Keep Companion is already running in the background.\r\n\r\n" +
				"It sends new documents from Downloads and Desktop to Adal Keep by itself.")
		}
		os.Exit(0)
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "companion.log")
		if st, err := os.Stat(p); err == nil && st.Size() > 5<<20 {
			os.Rename(p, p+".old") // keep it small
		}
		if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			log.SetOutput(f)
		}
	}
}

func messageBox(text string) {
	t, _ := windows.UTF16PtrFromString("Adal Keep Companion")
	m, _ := windows.UTF16PtrFromString(text)
	windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONINFORMATION|windows.MB_SETFOREGROUND)
}

// announce: opened from its icon (--show) — say it is running and where it sends.
func announce(connected bool, server string, dirs []string) {
	if !wantsStatus() {
		return
	}
	msg := "Adal Keep Companion is running in the background.\r\n\r\n"
	if connected {
		msg += "Connected to " + server + ".\r\n"
	} else {
		msg += "The Adal Keep server was not found yet (" + server + ") — it keeps looking.\r\n"
	}
	msg += "Watching: " + strings.Join(dirs, ", ") + "\r\n"
	if n := pendingCount(); n > 0 {
		msg += fmt.Sprintf("%d file(s) waiting to be sent — they go as soon as the main PC answers.\r\n", n)
	}
	msg += "\r\nYou can close this message; it keeps working."
	go messageBox(msg)
}
