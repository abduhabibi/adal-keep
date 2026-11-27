//go:build windows

// defaultbrowser.go — Adal Keep opens in the person's own default browser (Chrome, Edge,
// Firefox…), not in an Adal Browser app window (the owner, 2026-11-27: "option 5").
//
// Only on a person's click (the icon, the Start menu): a start at sign-in (--background)
// never opens anything. One window: when a browser window already shows Adal Keep
// (its tab in front, title "Adal …"), that window comes to the front and nothing new
// opens. Otherwise the browser gets one new tab; a tab of Adal Keep already open behind
// steps aside by itself (the page's own one-tab rule, frontend lib/oneTab.js).
// Off: ADAL_DEFAULT_BROWSER=0 (this PC's environment or backend\.env) — the app window as before.
package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var pGetWindowTextW = user32.NewProc("GetWindowTextW")

// envValue: the variable from this PC's environment, else from backend\.env (where the server's are kept).
func envValue(root, name string) string {
	if v, ok := os.LookupEnv(name); ok {
		return strings.TrimSpace(v)
	}
	f, err := os.Open(filepath.Join(root, "backend", ".env"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == name {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}

func defaultBrowserOn(root string) bool { return envValue(root, "ADAL_DEFAULT_BROWSER") != "0" }

func windowTitle(h windows.HWND) string {
	buf := make([]uint16, 256)
	n, _, _ := pGetWindowTextW.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

// adalTabWindows: browser windows whose tab in front is Adal Keep ("Adal <agency> - Google Chrome",
// "… — Mozilla Firefox"). Never the robots' or WhatsApp's browsers (their own data folders), never the
// Admin app ("… — Adal Keep Admin").
func adalTabWindows(root string) []windows.HWND {
	data := strings.ToLower(filepath.Join(root, "backend", "data"))
	var out []windows.HWND
	cb := syscall.NewCallback(func(h windows.HWND, _ uintptr) uintptr {
		if !windows.IsWindowVisible(h) || owner(h) != 0 {
			return 1
		}
		if c := className(h); c != "Chrome_WidgetWin_1" && c != "MozillaWindowClass" {
			return 1
		}
		t := windowTitle(h)
		if !strings.HasPrefix(t, "Adal ") || strings.Contains(t, "Adal Keep Admin") {
			return 1
		}
		var pid uint32
		windows.GetWindowThreadProcessId(h, &pid)
		if strings.Contains(strings.ToLower(commandLine(pid)), data) {
			return 1
		}
		out = append(out, h)
		return 1
	})
	windows.EnumWindows(cb, nil)
	return out
}

// openInDefaultBrowser: Adal Keep's page in the default browser — its window in front when it is open already.
func openInDefaultBrowser(root, url string) {
	// The app window of before still open: that one in front, never a second Adal Keep beside it.
	if focusAppWindow(root) {
		logf("Adal Keep's app window is already open — brought to the front")
		return
	}
	if ws := adalTabWindows(root); len(ws) > 0 {
		h := uintptr(ws[0])
		if iconic, _, _ := pIsIconic.Call(h); iconic != 0 {
			pShowWindow.Call(h, swRestore)
		}
		pSetForegroundWindow.Call(h)
		logf("Adal Keep is open in the default browser already — brought to the front")
		return
	}
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start(); err != nil {
		logf("default browser: %v — the app window instead", err)
		openAppWindow(root, url)
		return
	}
	logf("opened %s in the default browser", url)
}
