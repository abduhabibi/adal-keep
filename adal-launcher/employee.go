//go:build windows

// employee.go — AdalKeep.exe on an employee PC (the Companion install).
//
// There is no server on this PC: Adal Keep runs on the main PC. AdalKeep.exe
// starts the Companion (it sends new scans to the main PC and finds that PC on
// the network, saving its address in companion.conf), then opens the main PC's
// Adal Keep in an app-style Brave window with the Adal Keep logo on the taskbar.
// Started at Windows login and from the Adal Keep icon. When the main PC
// cannot be reached it opens the online copy (online.go); on an install without
// those pages it says so, keeps trying, and opens the window once it answers.
package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	neturl "net/url"
	"os"
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

func runEmployee(root string, background bool) {
	if !firstCopy() {
		// Already running for this user: just open the window again.
		// With the online pages a few seconds only: the online copy works without the main PC.
		wait := 8 * time.Second
		if hasOnlinePages(root) {
			wait = 4 * time.Second
		}
		if u := waitForMainPC(root, wait); u != "" {
			openAppWindow(root, companionURL(root, u))
		} else {
			// The first copy serves the online pages (or "Looking for the main PC").
			openAppWindow(root, offlineURL(root))
		}
		return
	}

	logf("Adal Keep (employee PC) starting")
	go ensureBrowser(root)
	startHidden(filepath.Join(root, "adal-companion.exe"))
	go brandWindows(root)
	online := startOnlinePage(root)
	// At Windows login: the Companion works; the window opens from the icon.
	if background && !openAtStart(root) {
		select {}
	}

	// The Companion may still be searching the network: give it a moment.
	budget := 40 * time.Second
	if online {
		budget = 5 * time.Second // the online pages work without the main PC: no waiting for it
	}
	u := waitForMainPC(root, budget)
	if u == "" && online {
		logf("main PC not reachable — opening the online copy")
		openAppWindow(root, onlineURL)
		select {}
	}
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
	openAppWindow(root, companionURL(root, u))
	select {} // stay in the background: the Adal Keep logo on its window
}

// companionURL: the main PC's page, marked as opened in a Companion that has
// the online pages — there it gives this PC its own online account once
// (lib/companionOnline.js), so the Companion works without the main PC.
func companionURL(root, u string) string {
	if !hasOnlinePages(root) {
		return u
	}
	return strings.TrimRight(u, "/") + "/?adal_companion=1"
}

// openAppWindow: the main PC's Adal Keep as its own app-style window (no
// address bar, no tabs), in this PC's Adal Keep browser profile.
func openAppWindow(root, url string) {
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
	// The main PC is reached over plain http: without this, every CV saved from it
	// is held back with a "may be dangerous" warning. Only this one address.
	if u, err := neturl.Parse(url); err == nil && u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		args = append(args, "--unsafely-treat-insecure-origin-as-secure="+u.Scheme+"://"+u.Host)
	}
	// One that cannot start must not leave the person with nothing: the next one opens.
	for _, b := range browsers() {
		cmd := exec.Command(b, args...)
		if err := cmd.Start(); err != nil {
			logf("could not start %s: %v", b, err)
			continue
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil { // a clean end only means a window was already open
				logf("%s stopped at once: %v", filepath.Base(b), err)
				continue
			}
		case <-time.After(4 * time.Second):
		}
		logf("opened %s in %s (app window)", url, filepath.Base(b))
		return
	}
	logf("no browser could open — using the default one")
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
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
			openAppWindow(root, companionURL(root, u))
			return
		}
	}
	logf("main PC %s does not answer — opening this PC's page", u)
	openUI(root)
}
