//go:build windows

// AdalKeep.exe — starts Adal Keep with no command window anywhere.
//
//	AdalKeep.exe                   open Adal Keep (starts it first when needed)
//	AdalKeep.exe --background      start it without opening a window (Windows login)
//	AdalKeep.exe --set-shortcut-ids <.lnk>...   installer: tag the shortcuts (see brand.go)
//
// One copy per signed-in user stays in the background: it keeps the server
// running (and starts it again when it stops — after an update, for example),
// starts the Companion and the agent hidden, and puts the Adal Keep logo on
// the Adal Keep Brave window. Opening Adal Keep again only opens the page.
package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// uiURL: the one Adal Keep address (backend/.env PORT=4000).
var uiURL = "http://localhost:4000"

const createNoWindow = 0x08000000

var logFile *os.File

func main() {
	root := exeDir()
	os.MkdirAll(filepath.Join(root, "backend", "data"), 0o755)
	logFile, _ = os.OpenFile(filepath.Join(root, "backend", "data", "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)

	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--set-shortcut-ids" {
		for _, lnk := range args[1:] {
			if err := setShortcutAppID(lnk, root); err != nil {
				logf("shortcut %s: %v", lnk, err)
			} else {
				logf("shortcut %s: shows as Adal Keep on the taskbar", lnk)
			}
		}
		return
	}
	background := len(args) > 0 && args[0] == "--background"

	if _, err := os.Stat(filepath.Join(root, "runtime", "node.exe")); err != nil {
		showError("Node.js runtime not found.\nPlease reinstall Adal Keep.")
		return
	}

	// Already running for this user: just open the page.
	if !firstCopy() {
		if !background {
			serverReady(45 * time.Second)
			openUI(root)
		}
		return
	}

	logf("Adal Keep starting (background=%v)", background)
	startHidden(filepath.Join(root, "adal-agent.exe"))
	startHidden(filepath.Join(root, "adal-companion.exe"))
	go keepServerRunning(root)
	go brandWindows(root)

	if !background {
		serverReady(45 * time.Second)
		openUI(root)
	}
	select {} // stay in the background: server, Companion, logo
}

func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(p)
}

func logf(format string, a ...any) {
	if logFile != nil {
		fmt.Fprintf(logFile, "[%s] %s\r\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, a...))
	}
}

// firstCopy is true for the first AdalKeep.exe of this Windows session.
func firstCopy() bool {
	name, _ := windows.UTF16PtrFromString(`Local\AdalKeepLauncher`)
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		windows.CloseHandle(h)
		return false
	}
	return h != 0 // kept open for the life of the process
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func startHidden(exe string) {
	if _, err := os.Stat(exe); err != nil {
		return
	}
	cmd := hidden(exec.Command(exe))
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		logf("could not start %s: %v", filepath.Base(exe), err)
		return
	}
	go cmd.Wait()
}

// keepServerRunning runs the server with no window and starts it again when
// it stops. Output goes to backend\data\server.log.
func keepServerRunning(root string) {
	backend := filepath.Join(root, "backend")
	for {
		if serverReady(2 * time.Second) { // another copy (or a developer) runs it
			time.Sleep(10 * time.Second)
			continue
		}
		out, _ := os.OpenFile(filepath.Join(backend, "data", "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		cmd := hidden(exec.Command(filepath.Join(root, "runtime", "node.exe"), "server.js"))
		cmd.Dir = backend
		cmd.Stdout, cmd.Stderr = out, out
		logf("starting the server")
		t0 := time.Now()
		err := cmd.Run()
		if out != nil {
			out.Close()
		}
		logf("server stopped (%v) — starting it again", err)
		if time.Since(t0) < 15*time.Second {
			time.Sleep(30 * time.Second) // it fails at once: do not spin
		} else {
			time.Sleep(3 * time.Second)
		}
	}
}

// serverReady polls the health endpoint until it answers or the budget runs out.
func serverReady(budget time.Duration) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(budget)
	for {
		resp, err := client.Get(uiURL + "/api/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(700 * time.Millisecond)
	}
}

func braveExe() string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func profileDir(root string) string {
	return filepath.Join(root, "backend", "data", "browser-profile")
}

// openUI opens the Adal Keep page in Brave with the Adal Keep browser
// profile — the same profile and control port the server's automations use
// (backend/src/services/browser.js). So the page and every automation run are
// tabs of ONE window. When that Brave is already open, the page simply opens
// as a new tab in it.
func openUI(root string) {
	if b := braveExe(); b != "" {
		profile := profileDir(root)
		os.MkdirAll(profile, 0o755)
		args := []string{
			"--user-data-dir=" + profile,
			"--remote-debugging-port=9222",
			"--no-first-run",
			"--no-default-browser-check",
			"--hide-crash-restore-bubble",
			"--start-maximized",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			uiURL,
		}
		if err := exec.Command(b, args...).Start(); err == nil {
			return
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", uiURL).Start()
}

func showError(msg string) {
	title, _ := windows.UTF16PtrFromString("Adal Keep")
	text, _ := windows.UTF16PtrFromString(strings.ReplaceAll(msg, "\n", "\r\n"))
	windows.MessageBox(0, text, title, windows.MB_OK|windows.MB_ICONERROR)
}
