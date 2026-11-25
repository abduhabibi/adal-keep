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
			if isOurMain(root, u, 3*time.Second) && serverReady(3*time.Second) {
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
		// Already running for this user: just open the window again — the
		// online copy at once (it never searches for the main PC).
		if signedOut(root) { // logged out of its main PC: its number again (leave.go)
			openAppWindow(root, joinURL(root))
			return
		}
		if hasOnlinePages(root) {
			if u := firstAnswering(root, candidates(root, ""), 2*time.Second); u != "" {
				openAppWindow(root, companionURL(root, u))
			} else {
				openAppWindow(root, offlineURL(root))
			}
			return
		}
		if u := waitForMainPC(root, 8*time.Second); u != "" {
			openAppWindow(root, companionURL(root, u))
		} else {
			// The first copy serves the online pages (or "Looking for the main PC").
			openAppWindow(root, offlineURL(root))
		}
		return
	}

	logf("Adal Keep (employee PC) starting")
	go ensureBrowser(root)
	go ensureSharing(root) // the office network may share updates, data and the server (sharing.go)
	go ensureSupport(root) // remote support by Adal: key, sshd, firewall checked and repaired (support.go)
	startHidden(filepath.Join(root, "adal-companion.exe"))
	go brandWindows(root)
	online := startOnlinePage(root)
	go retryLeaves(root) // a main PC this Companion logged out of while it was off
	// At Windows login (or any start without a person): the Companion works; the window opens
	// only from its icon (the owner, 2026-11-24: "don't make Adal open by itself in any way").
	if background {
		select {}
	}

	// With the online pages the Companion starts at once, without looking for
	// the main PC: they work with the main PC on (through the online link) or
	// off, anywhere. Not paired yet, they ask for the main PC's number.
	// Logged out of its main PC ("Connect to another PC"): the page to choose one.
	if signedOut(root) {
		logf("logged out of the main PC — asking for the main PC's number")
		openAppWindow(root, joinURL(root))
		select {}
	}
	if online {
		// The main PC answering at its saved address: opened directly (fast).
		// Otherwise the online copy at once; it opens the main PC itself as
		// soon as it can be reached (direct.go, lib/companionDirect.js).
		if u := firstAnswering(root, candidates(root, ""), 2*time.Second); u != "" {
			logf("main PC answers at %s — opening it directly", u)
			openAppWindow(root, companionURL(root, u))
			select {}
		}
		logf("opening the online copy (it opens the main PC once it answers)")
		openAppWindow(root, onlineURL)
		select {}
	}
	// An older install without the online pages: it needs the main PC.
	u := waitForMainPC(root, 40*time.Second)
	if u == "" {
		logf("main PC not reachable yet — showing the connect page, still trying")
		if ensureConnectPage(root) {
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

// joinURL: where the main PC's number is typed — connect.html in the online
// pages (on the network or, from anywhere, online), else the small page.
func joinURL(root string) string {
	if hasOnlinePages(root) {
		return onlineURL + "connect.html?pair=1"
	}
	ensureConnectPage(root)
	return connectURL
}

// companionURL: the main PC's page, marked as opened in a Companion that has
// the online pages — there it gives this PC its own online account once
// (lib/companionOnline.js), so the Companion works without the main PC.
func companionURL(root, u string) string {
	if !hasOnlinePages(root) {
		return withHand(root, u)
	}
	return withHand(root, strings.TrimRight(u, "/")+"/?adal_companion=1")
}

// openAppWindow: the main PC's Adal Keep as its own app-style window (no
// address bar, no tabs), in this PC's Adal Keep browser profile.
func openAppWindow(root, url string) {
	// Already open: that window in front, never a second one (single.go).
	if focusAppWindow(root) {
		logf("Adal Keep's window is already open — brought to the front")
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
	// The main PC is reached over plain http: without this, every CV saved from it
	// is held back with a "may be dangerous" warning. Only this one address.
	if u, err := neturl.Parse(url); err == nil && u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		args = append(args, "--unsafely-treat-insecure-origin-as-secure="+u.Scheme+"://"+u.Host)
	}
	// Another click is opening it this very moment: that one does (one window, single.go).
	release, mine := openingNow()
	if !mine {
		logf("Adal Keep's window is being opened already")
		return
	}
	defer release()
	logf("opening %s", url)
	o := windowOpener{
		browsers: browsers(), args: args, log: logf,
		focus:   func() bool { return focusAppWindow(root) },
		holders: func() []uint32 { return profileHolders(profile) },
		wait:    profileWait(), shown: 10 * time.Second, step: 250 * time.Millisecond,
	}
	// The default browser: only for the click this program was started by, never later by itself.
	if time.Since(programStart) < 2*time.Minute {
		o.lastResort = func() { exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start() }
	}
	o.open()
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
		Mode    string `json:"mode"`
	}
	if json.Unmarshal(b, &f) != nil {
		return ""
	}
	// A Companion with its own copy (companion-full): its own server, its own page.
	if f.Mode == "companion" {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(f.MainURL), "/")
}

// companionInstall: installed with the Companion installer since companion-full
// (the same full Adal Keep, marked so it joins an agency instead of starting one).
func companionInstall(root string) bool {
	return fileExists(filepath.Join(root, "companion-install"))
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
