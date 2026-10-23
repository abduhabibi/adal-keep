//go:build windows

// employee.go — AdalKeep.exe on an employee PC (the Companion install).
//
// There is no server on this PC: Adal Keep runs on the main PC. AdalKeep.exe
// starts the Companion (it sends new scans to the main PC and finds that PC on
// the network, saving its address in companion.conf), then opens the main PC's
// Adal Keep in an app-style Brave window with the Adal Keep logo on the taskbar.
// Started at Windows login and from the Adal Keep icon. When the main PC
// cannot be reached it says so, keeps trying, and opens the window once it answers.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// employeePC: installed by "Install Adal Companion" — no server here.
func employeePC(root string) bool {
	return !fileExists(filepath.Join(root, "runtime", "node.exe")) &&
		fileExists(filepath.Join(root, "adal-companion.exe"))
}

// mainPCURL: the main PC's address the Companion found (or IT pinned).
func mainPCURL(root string) string {
	if v := strings.TrimSpace(os.Getenv("ADAL_HOST_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	f, err := os.Open(filepath.Join(root, "companion.conf"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == "ADAL_HOST_URL" {
			return strings.TrimRight(strings.TrimSpace(v), "/")
		}
	}
	return ""
}

// waitForMainPC: the address once known and answering, or "" after budget.
func waitForMainPC(root string, budget time.Duration) string {
	for end := time.Now().Add(budget); ; {
		if u := mainPCURL(root); u != "" {
			uiURL = u
			if serverReady(3 * time.Second) {
				return u
			}
		}
		if time.Now().After(end) {
			return ""
		}
		time.Sleep(2 * time.Second)
	}
}

const unreachableMsg = "The main Adal Keep PC is not reachable.\n\n" +
	"Make sure it is turned on and that this PC is on the same network (Wi-Fi / cable).\n\n" +
	"Adal Keep keeps trying and opens by itself as soon as the main PC answers."

func runEmployee(root string) {
	if !firstCopy() {
		// Already running for this user: just open the window again.
		if u := waitForMainPC(root, 8*time.Second); u != "" {
			openAppWindow(root, u)
		} else {
			// The first copy serves the "Looking for the main PC" page.
			openAppWindow(root, connectURL)
		}
		return
	}

	logf("Adal Keep (employee PC) starting")
	startHidden(filepath.Join(root, "adal-companion.exe"))
	go brandWindows(root)

	// The Companion may still be searching the network: give it a moment.
	u := waitForMainPC(root, 40*time.Second)
	if u == "" {
		logf("main PC not reachable yet — showing the connect page, still trying")
		if startConnectPage(root) {
			// The page opens Adal Keep itself once the main PC answers.
			openAppWindow(root, connectURL)
			select {}
		}
		go showError(unreachableMsg) // does not stop the retries
		for u == "" {
			u = waitForMainPC(root, 15*time.Second)
		}
	}
	logf("main PC answers at %s", u)
	openAppWindow(root, u)
	select {} // stay in the background: the Adal Keep logo on its window
}

// openAppWindow: the main PC's Adal Keep as its own app-style window (no
// address bar, no tabs), in this PC's Adal Keep browser profile.
func openAppWindow(root, url string) {
	b := pickBrowser()
	if b == "" {
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		return
	}
	profile := profileDir(root)
	os.MkdirAll(profile, 0o755)
	args := []string{
		"--user-data-dir=" + profile,
		"--app=" + url,
		"--no-first-run",
		"--no-default-browser-check",
		"--hide-crash-restore-bubble",
		"--start-maximized",
	}
	if err := exec.Command(b, args...).Start(); err != nil {
		logf("could not start %s: %v", b, err)
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		return
	}
	logf("opened %s in %s (app window)", url, filepath.Base(b))
}

// followedMainURL: on a full install, the main PC chosen in Settings → Main PC
// (backend/data/main-pc.json). "" when this PC is the main PC itself.
func followedMainURL(root string) string {
	b, err := os.ReadFile(filepath.Join(root, "backend", "data", "main-pc.json"))
	if err != nil {
		return ""
	}
	var f struct {
		MainURL string `json:"main_url"`
	}
	if json.Unmarshal(b, &f) != nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(f.MainURL), "/")
}

// openMainOrFollowed opens this PC's Adal Keep, or — when this PC follows
// another main PC — that PC's Adal Keep in an app window. When the main PC
// does not answer, this PC's own page opens: it says which PC it follows and
// lets the person change it in Settings.
func openMainOrFollowed(root string) {
	u := followedMainURL(root)
	if u == "" {
		openUI(root)
		return
	}
	client := &http.Client{Timeout: 4 * time.Second}
	if resp, err := client.Get(u + "/api/health"); err == nil {
		resp.Body.Close()
		if resp.StatusCode < 500 {
			logf("this PC follows the main PC at %s", u)
			openAppWindow(root, u)
			return
		}
	}
	logf("main PC %s does not answer — opening this PC's page", u)
	openUI(root)
}
