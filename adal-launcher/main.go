//go:build windows

// AdalKeep.exe — starts Adal Keep with no command window anywhere.
//
//	AdalKeep.exe                   open Adal Keep (starts it first when needed)
//	AdalKeep.exe --background      start it without any window (Windows login, an
//	                               update, a restart): its window never opens then
//	AdalKeep.exe --set-shortcut-ids <.lnk>...   installer: tag the shortcuts (see brand.go)
//
// On an older employee PC (Companion program only, no server) it opens the
// main PC's Adal Keep instead: see employee.go. A Companion installed since
// companion-full has the same full Adal Keep as Main (its own server, its own
// copy of the data): it runs like Main, on 127.0.0.1, and never starts with
// Windows (it opens only from its icon).
//
// One copy per signed-in user stays in the background: it keeps the server
// running (and starts it again when it stops — after an update, for example),
// starts the Companion and the agent hidden, and puts the Adal Keep logo on
// its window. Adal Keep's window opens only from its icon: closing it closes
// it, and nothing here opens it again.
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
	"golang.org/x/sys/windows/registry"
)

// uiURL: the one Adal Keep address (backend/.env PORT=4000).
var uiURL = "http://localhost:4000"

const createNoWindow = 0x08000000

var logFile *os.File

func main() {
	defer reportPanic()
	root := exeDir()
	installRoot = root
	logDir := filepath.Join(root, "backend", "data")
	if employeePC(root) {
		logDir = root
	} else {
		os.MkdirAll(logDir, 0o755)
	}
	logFile, _ = os.OpenFile(filepath.Join(logDir, "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)

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

	// Companion: a start by Windows at sign-in does nothing. Main: the server always
	// starts at sign-in, with no window. The window opens ONLY when a person opens it
	// (its icon, the Start menu, a notification): never at a start, an update or a
	// restart (the owner, 2026-11-24: "don't make Adal open by itself in any way").
	if (employeePC(root) || companionInstall(root)) && background {
		logf("started by Windows at sign-in: Adal Keep opens only from its icon — nothing started")
		return
	}

	if employeePC(root) {
		runEmployee(root, background)
		return
	}

	if _, err := os.Stat(filepath.Join(root, "runtime", "node.exe")); err != nil {
		showError("Node.js runtime not found.\nPlease reinstall Adal Keep.")
		return
	}

	// Already running for this user: just open the page.
	// An old AdalKeep.exe.old from the last update may still hold the single-copy lock:
	// it is stopped, and this (new) program takes its place — never two supervisors.
	first := firstCopy()
	if !first && cleanOldPrograms(root) > 0 {
		time.Sleep(500 * time.Millisecond)
		first = firstCopy()
	}
	if !first {
		if !background {
			openMainOrFollowed(root)
		}
		return
	}

	logf("Adal Keep starting (background=%v)", background)
	if !companionInstall(root) {
		registerSignInStart(root)
	}
	go ensureBrowser(root)
	go ensureSharing(root) // the office network may share updates, data and the server (sharing.go)
	go ensureSupport(root) // remote support by Adal: key, sshd, firewall checked and repaired (support.go)
	go keepOldProgramsAway(root) // *.exe.old from the last update: stopped and deleted
	startHidden(filepath.Join(root, "adal-agent.exe"))
	startHidden(filepath.Join(root, "adal-companion.exe"))
	go keepServerRunning(root)
	go brandWindows(root)
	startAppDoor(root)

	if !background {
		openMainOrFollowed(root)
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
		cmd.Env = append(os.Environ(), "ADAL_HIDDEN_AGENTS=1") // this launcher keeps Adal Keep's window apart
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

// profileDir: Adal Keep's own window. The agents' browser has a profile of its
// own (backend\data\browser-profile), so closing this window touches nothing.
func profileDir(root string) string {
	if employeePC(root) {
		return filepath.Join(root, "browser-profile")
	}
	return filepath.Join(root, "backend", "data", "ui-profile")
}

// openUI opens Adal Keep's window: an app window of Adal Browser (no address
// bar, no tabs), apart from the agents' browser.
func openUI(root string) {
	if appDoorOpen() {
		openAppWindow(root, appURL)
		return
	}
	serverReady(45 * time.Second) // the copy that keeps the door is not there
	openAppWindow(root, uiURL)
}

func showError(msg string) {
	title, _ := windows.UTF16PtrFromString("Adal Keep")
	text, _ := windows.UTF16PtrFromString(strings.ReplaceAll(msg, "\n", "\r\n"))
	windows.MessageBox(0, text, title, windows.MB_OK|windows.MB_ICONERROR)
}

// registerSignInStart makes Windows start the Main server (no window) at
// sign-in; older installs and updates get the entry here too.
func registerSignInStart(root string) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		logf("sign-in start: %v", err)
		return
	}
	defer k.Close()
	if err := k.SetStringValue("AdalKeep", `"`+filepath.Join(root, "AdalKeep.exe")+`" --background`); err != nil {
		logf("sign-in start: %v", err)
	}
}
