//go:build windows

// single.go — one Adal Keep window, never two (the owner, 2026-11-24: "don't make the chrome
// tabs open in 2 windows when I open Adal Keep"). Opening Adal Keep while its window is
// already there brings that window to the front: the browser is never asked for another
// --app window (it would open a second one).
package main

import (
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

var (
	pIsIconic            = user32.NewProc("IsIconic")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
)

const swRestore = 9

// appWindows: the visible top-level windows of Adal Keep's own window profile.
func appWindows(root string) []windows.HWND {
	profile := strings.ToLower(profileDir(root))
	seen := map[uint32]bool{}
	var out []windows.HWND
	cb := syscall.NewCallback(func(h windows.HWND, _ uintptr) uintptr {
		if !windows.IsWindowVisible(h) || owner(h) != 0 || className(h) != "Chrome_WidgetWin_1" {
			return 1
		}
		var pid uint32
		windows.GetWindowThreadProcessId(h, &pid)
		is, known := seen[pid]
		if !known {
			is = strings.Contains(strings.ToLower(commandLine(pid)), profile)
			seen[pid] = is
		}
		if is {
			out = append(out, h)
		}
		return 1
	})
	windows.EnumWindows(cb, nil)
	return out
}

// focusAppWindow: Adal Keep's window is already open → in front (restored if minimized). True when there was one.
func focusAppWindow(root string) bool {
	ws := appWindows(root)
	if len(ws) == 0 {
		return false
	}
	h := uintptr(ws[0])
	if iconic, _, _ := pIsIconic.Call(h); iconic != 0 {
		pShowWindow.Call(h, swRestore)
	}
	pSetForegroundWindow.Call(h)
	return true
}
