//go:build windows

// browser.go — which browser opens Adal Keep.
//
// Brave first: the automations drive it. Setup installs Brave in the
// background, so right after an install it may still be on its way: then the
// launcher waits for it (and says so) instead of opening another browser.
// Without Brave, Chrome or Edge open Adal Keep the same way (same profile,
// same control port), so the automations still work. The default browser is
// the last resort.
package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// appPath: where Windows says an installed program is (App Paths).
func appPath(exe string) string {
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		k, err := registry.OpenKey(root, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`+exe, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("")
		k.Close()
		v = strings.Trim(v, `"`)
		if err == nil && fileExists(v) {
			return v
		}
	}
	return ""
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if p != "" && fileExists(p) {
			return p
		}
	}
	return ""
}

func braveExe() string {
	return firstExisting(
		filepath.Join(os.Getenv("ProgramFiles"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		appPath("brave.exe"),
	)
}

// otherChromium: Chrome or Edge (Edge is on every Windows 10/11).
func otherChromium() string {
	return firstExisting(
		filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "Application", "chrome.exe"),
		appPath("chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
		appPath("msedge.exe"),
	)
}

// braveInstalling: Brave's setup (started by the Adal Keep installer) is running.
func braveInstalling() bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		name := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		if strings.Contains(name, "bravesetup") || strings.Contains(name, "brave_installer") ||
			strings.Contains(name, "bravebrowser") || name == "braveupdate.exe" {
			return true
		}
	}
	return false
}

// notify shows a message without holding anything up.
func notify(msg string) {
	go func() {
		title, _ := windows.UTF16PtrFromString("Adal Keep")
		text, _ := windows.UTF16PtrFromString(msg)
		windows.MessageBox(0, text, title, windows.MB_OK|windows.MB_ICONINFORMATION|windows.MB_SETFOREGROUND)
	}()
}

// pickBrowser: Brave (waiting for it while it installs), else Chrome/Edge.
func pickBrowser() string {
	if b := braveExe(); b != "" {
		return b
	}
	if braveInstalling() {
		logf("Brave is still installing — waiting for it")
		notify("Adal Keep is finishing the Brave install.\r\n\r\nIt opens by itself in a moment — you can close this message.")
		for end := time.Now().Add(4 * time.Minute); time.Now().Before(end); time.Sleep(2 * time.Second) {
			if b := braveExe(); b != "" {
				time.Sleep(3 * time.Second) // let the installer finish its last files
				return b
			}
			if !braveInstalling() {
				break
			}
		}
	}
	if b := otherChromium(); b != "" {
		logf("Brave not found — using %s", b)
		return b
	}
	logf("no Brave, Chrome or Edge found — opening the default browser")
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
