//go:build windows

// single.go — one Adal Keep window, never two (the owner, 2026-11-24: "don't make the chrome
// tabs open in 2 windows when I open Adal Keep"). Opening Adal Keep while its window is
// already there brings that window to the front: the browser is never asked for another
// --app window (it would open a second one).
package main

import (
	"strings"
	"syscall"
	"time"
	"unsafe"

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

var programStart = time.Now()

// openingNow: no other AdalKeep.exe is opening the window at this moment. A second click does not
// wait for the first one: its window may be closed (X) by then, and must not come back.
func openingNow() (release func(), ok bool) {
	name, _ := windows.UTF16PtrFromString(`Local\AdalKeepOpening`)
	h, err := windows.CreateMutex(nil, false, name)
	if h == 0 {
		return func() {}, true // (cannot tell: as before)
	}
	if err == windows.ERROR_ALREADY_EXISTS {
		windows.CloseHandle(h)
		return nil, false
	}
	return func() { windows.CloseHandle(h) }, true
}

// profileHolders: the browsers that have this profile open, with a window or (closing) without.
func profileHolders(profile string) (pids []uint32) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		switch strings.ToLower(windows.UTF16ToString(e.ExeFile[:])) {
		case "adalbrowser.exe", "brave.exe", "chrome.exe", "msedge.exe":
			if holdsProfile(commandLine(e.ProcessID), profile) {
				pids = append(pids, e.ProcessID)
			}
		}
	}
	return pids
}
