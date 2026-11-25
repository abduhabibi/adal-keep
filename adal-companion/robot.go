// robot.go — the main PC's robots work in THIS PC's Adal Browser when they
// were started here (asked on 2026-11-19: "make the companion do every little
// thing that the main can"). The robots and the data stay on the main PC; it
// drives the browser here over the office network (backend
// services/remoteBrowsers.js).
//
//   - Every minute this program tells the main PC, with its approved key,
//     where the robot browser is: POST /api/companion/robot-browser
//     {token, port, name}. The token is new each time this program starts.
//   - GET  /robot/json/version   starts the robot browser if it is closed
//     (Adal Browser, its own profile "robot-profile", on this PC's screen) and
//     answers its DevTools address, rewritten to come through here.
//   - /robot/ws/…                the DevTools connection, passed to the
//     browser on 127.0.0.1 only.
//   - POST /robot/file?name=…    a file a robot uploads (it lives on the main
//     PC): kept in robot-files (a day), its path here answered.
//
// Every call needs the token (header x-adal-robot): only the main PC this
// Companion joined knows it. The browser's own port is never on the network.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var (
	robotDebugPort = envInt("ADAL_ROBOT_DEBUG_PORT", 9223)
	robotToken     = newRobotToken()
	robotMu        sync.Mutex
	robotCmd       *exec.Cmd
)

func newRobotToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// robotAllowed: the call carries this program's token.
func robotAllowed(r *http.Request) bool {
	t := r.Header.Get("x-adal-robot")
	return t != "" && len(t) == len(robotToken) && t == robotToken
}

// robotBrowserExe: Adal Browser of this install, else the PC's own Brave, Chrome or Edge (as on the main PC since
// 2026-11-23: every Windows has Edge) — always with a profile of the robots' own, never a person's, and no window.
func robotBrowserExe(root string) string {
	c := []string{
		filepath.Join(root, "browser", "AdalBrowser.exe"),
		filepath.Join(root, "browser", "chrome.exe"), // Adal Browser's own folder, not yet renamed
	}
	for _, d := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
		if d == "" {
			continue
		}
		c = append(c,
			filepath.Join(d, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
			filepath.Join(d, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(d, "Microsoft", "Edge", "Application", "msedge.exe"))
	}
	for _, p := range c {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// robotProfile: a profile a newer browser wrote is refused by another: one for each.
func robotProfile(root, exe string) string {
	switch strings.ToLower(filepath.Base(exe)) {
	case "brave.exe":
		return filepath.Join(root, "robot-profile-brave")
	case "msedge.exe":
		return filepath.Join(root, "robot-profile-edge")
	case "chrome.exe":
		if filepath.Dir(exe) != filepath.Join(root, "browser") {
			return filepath.Join(root, "robot-profile-chrome")
		}
	}
	return filepath.Join(root, "robot-profile")
}

// robotArgs: light, and for another PC's work nothing to see on this one: no window, no taskbar button.
func robotArgs(profile string, quiet bool) []string {
	a := []string{
		fmt.Sprintf("--remote-debugging-port=%d", robotDebugPort),
		"--remote-debugging-address=127.0.0.1",
		"--user-data-dir=" + profile,
		"--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--noerrdialogs",
		"--disable-background-networking", "--disable-notifications", "--disable-breakpad", "--disable-popup-blocking",
		"--disable-backgrounding-occluded-windows", "--mute-audio",
		"--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,SpareRendererForSitePerProcess,AutofillServerCommunication,IntensiveWakeUpThrottling",
	}
	if quiet {
		a = append(a, "--headless=new", "--window-size=1366,900")
	} else {
		a = append(a, "--start-maximized")
	}
	return append(a, "about:blank")
}

func robotLocal(path string) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", robotDebugPort, path)
}

// robotVersion: the browser's /json/version (it answers only while it is open).
func robotVersion() (map[string]any, error) {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(robotLocal("/json/version"))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var v map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// ensureRobotBrowser: the robot browser open on this PC (opened when it is not).
// quiet — opened for another PC's work (this PC helps): nothing to see here.
func ensureRobotBrowser(root string, quiet bool) (map[string]any, error) {
	if v, err := robotVersion(); err == nil {
		return v, nil
	}
	robotMu.Lock()
	defer robotMu.Unlock()
	if v, err := robotVersion(); err == nil {
		return v, nil
	}
	exe := robotBrowserExe(root)
	if exe == "" {
		return nil, fmt.Errorf("no Adal Browser on this PC")
	}
	profile := robotProfile(root, exe)
	os.MkdirAll(profile, 0o755)
	cmd := exec.Command(exe, robotArgs(profile, quiet)...)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("Adal Browser did not start: %v", err)
	}
	robotCmd = cmd
	go cmd.Wait()
	log.Printf("🤖 robot browser opened for the main PC (%s)", filepath.Base(exe))
	for i := 0; i < 60; i++ {
		time.Sleep(500 * time.Millisecond)
		if v, err := robotVersion(); err == nil {
			return v, nil
		}
	}
	return nil, fmt.Errorf("Adal Browser opened but did not answer")
}

var wsHostRe = regexp.MustCompile(`^ws://[^/]+`)

// robotRewrite: the DevTools address as the main PC reaches it (through here).
func robotRewrite(wsURL, host string) string {
	return wsHostRe.ReplaceAllString(wsURL, "ws://"+host+"/robot/ws")
}

var robotFileName = regexp.MustCompile(`[^\w.\-]+`)

func robotFilesDir(root string) string { return filepath.Join(root, "robot-files") }

// tidyRobotFiles: files sent for an upload are kept a day.
func tidyRobotFiles(root string) {
	entries, _ := os.ReadDir(robotFilesDir(root))
	for _, e := range entries {
		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > 24*time.Hour {
			os.RemoveAll(filepath.Join(robotFilesDir(root), e.Name()))
		}
	}
}

// robotNow: how this PC is at this moment (the main PC asks every PC just before a run, 0.6 s at most).
func robotNow(root string) map[string]any {
	out := map[string]any{"cores": runtime.NumCPU(), "browser": robotBrowserExe(root) != "", "updating": updatingNow.Load()}
	for k, v := range powerLately() {
		out[k] = v
	}
	if v := ownVersionOnce(); v != "" {
		out["version"] = v
	}
	return out
}

var (
	powerMu   sync.Mutex
	powerAt   time.Time
	powerLast map[string]any
	versionMu sync.Mutex
	versionAt time.Time
	versionV  string
)

// powerLately: powerNow, at most every 3 s (its load is the one since the last look).
func powerLately() map[string]any {
	powerMu.Lock()
	defer powerMu.Unlock()
	if powerLast == nil || time.Since(powerAt) > 3*time.Second {
		n := powerNow()
		if _, ok := n["load"]; !ok && powerLast != nil {
			if l, ok := powerLast["load"]; ok {
				n["load"] = l
			}
		}
		powerLast, powerAt = n, time.Now()
	}
	return powerLast
}

func ownVersionOnce() string {
	versionMu.Lock()
	defer versionMu.Unlock()
	if versionAt.IsZero() || time.Since(versionAt) > time.Minute {
		versionV, versionAt = ownVersion(), time.Now()
	}
	return versionV
}

func addRobotRoutes(mux *http.ServeMux, root string) {
	mux.HandleFunc("/robot/now", func(w http.ResponseWriter, r *http.Request) {
		if !robotAllowed(r) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(robotNow(root))
	})
	mux.HandleFunc("/robot/json/version", func(w http.ResponseWriter, r *http.Request) {
		if !robotAllowed(r) {
			http.NotFound(w, r)
			return
		}
		v, err := ensureRobotBrowser(root, r.URL.Query().Get("quiet") == "1")
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		if s, ok := v["webSocketDebuggerUrl"].(string); ok {
			v["webSocketDebuggerUrl"] = robotRewrite(s, r.Host)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	})
	mux.HandleFunc("/robot/ws/", func(w http.ResponseWriter, r *http.Request) {
		if !robotAllowed(r) || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.NotFound(w, r)
			return
		}
		robotPipe(w, r, strings.TrimPrefix(r.URL.Path, "/robot/ws"))
	})
	mux.HandleFunc("/robot/file", func(w http.ResponseWriter, r *http.Request) {
		if !robotAllowed(r) || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		name := robotFileName.ReplaceAllString(filepath.Base(r.URL.Query().Get("name")), "_")
		if name == "" || name == "." || name == ".." {
			name = "file"
		}
		dir := robotFilesDir(root)
		os.MkdirAll(dir, 0o755)
		tidyRobotFiles(root)
		// Its own folder, so the website sees the file's own name (passport.jpg).
		sub, err := os.MkdirTemp(dir, "f")
		var f *os.File
		if err == nil {
			f, err = os.Create(filepath.Join(sub, name))
		}
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_, err = io.Copy(f, http.MaxBytesReader(w, r.Body, 64<<20))
		f.Close()
		if err != nil {
			os.RemoveAll(sub)
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"path": f.Name()})
	})
}

// robotPipe: the main PC's DevTools connection, handed to the browser here.
func robotPipe(w http.ResponseWriter, r *http.Request, path string) {
	back, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", robotDebugPort), 3*time.Second)
	if err != nil {
		http.Error(w, "the robot browser is closed", http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		back.Close()
		http.Error(w, "no", http.StatusInternalServerError)
		return
	}
	front, buf, err := hj.Hijack()
	if err != nil {
		back.Close()
		return
	}
	// The same upgrade, to the browser on this PC (its own name, no Origin).
	out := r.Clone(r.Context())
	out.URL.Path, out.URL.RawPath, out.RequestURI = path, "", ""
	out.Host = fmt.Sprintf("127.0.0.1:%d", robotDebugPort)
	out.Header.Del("x-adal-robot")
	out.Header.Del("Origin")
	if err := out.Write(back); err != nil {
		front.Close()
		back.Close()
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(back, io.MultiReader(bufReader(buf), front)); done <- struct{}{} }()
	go func() { io.Copy(front, back); done <- struct{}{} }()
	<-done
	front.Close()
	back.Close()
}

// bufReader: what the server already read from the main PC after the request.
func bufReader(rw *bufio.ReadWriter) io.Reader {
	if rw == nil || rw.Reader.Buffered() == 0 {
		return strings.NewReader("")
	}
	b, _ := rw.Reader.Peek(rw.Reader.Buffered())
	return strings.NewReader(string(b))
}

// announceOnce: 8 s at most. A busy main PC that did not answer held this for 30 s, and the next one came 50 s later:
// it was "gone" (45 s) though it was there (2026-11-25).
func announceOnce(body map[string]any, key string, answer any) error {
	done := make(chan error, 1)
	go func() {
		_, err := mainJSON(http.MethodPost, "/api/companion/robot-browser", body, key, answer)
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(8 * time.Second):
		return fmt.Errorf("the main PC did not answer in 8 s")
	}
}

// announceRobot: every 20 seconds, while joined to a main PC on the network.
func announceRobot() {
	for {
		keys := loadKeys()
		if keys.AccessKey != "" && hostServer != "" {
			body := map[string]any{"token": robotToken, "port": lanHTTPPort, "name": clientName, "cores": runtime.NumCPU()}
			// How strong it is right now: the main PC gives the heavy work to the strongest.
			for k, v := range powerLately() {
				body[k] = v
			}
			// Its internet: the run goes to the PC that finishes first (netprobe.go).
			for k, v := range netNow() {
				body[k] = v
			}
			// The office health page: its version, Wi-Fi and whether it reaches the other PCs (office.go).
			for k, v := range officeNow() {
				body[k] = v
			}
			var answer struct {
				Peers []officePeer `json:"peers"`
			}
			if err := announceOnce(body, keys.AccessKey, &answer); err != nil {
				log.Printf("🤖 robot browser not announced: %v (again in 5 s)", err)
				time.Sleep(5 * time.Second)
				continue
			}
			rememberPeers(answer.Peers)
		}
		time.Sleep(20 * time.Second)
	}
}
