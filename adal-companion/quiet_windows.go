//go:build windows

package main

// On Windows the Companion has no window (built with -H windowsgui): its log
// goes to companion.log next to the program, and only one copy runs.

import (
	"log"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func init() {
	name, _ := windows.UTF16PtrFromString(`Local\AdalKeepCompanion`)
	if _, err := windows.CreateMutex(nil, false, name); err == windows.ERROR_ALREADY_EXISTS {
		os.Exit(0) // already running
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
