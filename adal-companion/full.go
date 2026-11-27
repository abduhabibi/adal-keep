// full.go — every Adal Companion keeps its own full copy of the agency and runs
// on it when the main PC is off (asked on 2026-11-22: "when main is off, the
// adal companion should still work"; "main is just a name").
//
//   - The server: the main PC's own (server\, kept by standby.go's bundle loop,
//     over the office network, never by a person) runs on this PC ALL the time,
//     on 127.0.0.1:4140, on its own data folder server\backend\data (the
//     database too: a newer server is put in place around it).
//   - The copy: that server joins the agency by itself with the key the main PC
//     gave this program (ADAL_SYNC_JOIN_KEY: no number typed), takes a snapshot
//     of the main PC's database once (paced on the main PC, replicaThrottle),
//     then keeps it the same both ways with every PC of the agency it reaches —
//     the main PC or any other Companion — field by field (sync/engine.js).
//     The documents come after, smallest first.
//   - The office door (port 4000) stays open: the other PCs copy with this one.
//   - The window: while the main PC answers it opens the main PC (as before).
//     When the main PC has not answered for a little while, /local/host names
//     this PC's own server, and the window (AdalKeep.exe, direct.go) opens it:
//     the staff go on working here. The main PC back, the window goes back to
//     it; what was done here reaches it by the copying, nothing to merge.
//   - The robots, backups, the phones' online copy: the PC holding the main
//     role. When the main PC is gone longer than its lease (15 min), ONE PC
//     of the agency takes the role by itself, and hands it back when the main
//     PC returns (sync/roles.js autoStep).
//
// The older way (standing in from the locked copy, then a merge back) stays
// only for a Companion whose full copy is not running.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	fullCopyEnv  = os.Getenv("ADAL_FULL_COPY") // "1" on, "0" off, else what the main PC says
	ownAfter     = time.Duration(envInt("ADAL_OWN_AFTER_SECONDS", 45)) * time.Second
	fullClient   = &http.Client{Timeout: 3 * time.Second}
	fullMu       sync.Mutex
	fullServer   *exec.Cmd
	fullStopping bool
	usingOwn     bool       // the window works on this PC's own server now
	swapMu       sync.Mutex // a newer server put in place, or the server started: one at a time
)

func fullData(root string) string { return filepath.Join(serverBackend(root), "data") }
func ownServerURL() string        { return fmt.Sprintf("http://127.0.0.1:%d", actingPort) }

// fullJoined: this PC's server has its own copy of the agency (it joined).
func fullJoined(root string) bool {
	b, err := os.ReadFile(filepath.Join(fullData(root), "sync-id.json"))
	if err != nil {
		return false
	}
	var id struct {
		JoinedMain string `json:"joined_main"`
	}
	return json.Unmarshal(b, &id) == nil && id.JoinedMain != ""
}

// fullCopyRunning: the full copy runs here (the locked copy and the old standing in are not used).
func fullCopyRunning() bool {
	fullMu.Lock()
	defer fullMu.Unlock()
	return fullServer != nil
}

// fullCopyJoined: for replica.go — the locked copy is not needed any more.
func fullCopyJoined() bool { return standby != nil && fullJoined(standby.root) }

// windowHost: what /local/host tells the window.
func windowHost() string {
	fullMu.Lock()
	own := usingOwn
	fullMu.Unlock()
	if own {
		return ownServerURL()
	}
	// Standing in with its own server dead: the main PC, when it is there.
	if isActingURL(hostServer) && !steadyOff {
		if u := mainForPages(); u != "" && !portOpens(ownServerURL()) {
			return u
		}
	}
	return strings.TrimRight(hostServer, "/")
}

func (s *standbyRunner) fullWanted() bool {
	s.mu.Lock()
	acting := s.st.Acting
	s.mu.Unlock()
	return fullCopyAllowed(s.root) && !acting && hasServer(s.root) && mainNumber() != "" && !signedOut()
}

// fullCopyAllowed: ON for every agency and every PC (the owner, 2026-11-23: "you turn it on for
// every one for ever"). Off only in an emergency: ADAL_FULL_COPY=0 here, or the main PC says it is
// off (/api/companion/info full_copy false: its ADAL_COMPANION_FULL=0 or Adal's tower OFF command);
// that last answer is kept (full-copy.json), so it holds while the main PC is off.
func fullCopyAllowed(root string) bool {
	switch fullCopyEnv {
	case "1":
		return true
	case "0":
		return false
	}
	b, err := os.ReadFile(filepath.Join(root, "full-copy.json"))
	if err != nil {
		return true
	}
	var v struct {
		On *bool `json:"on"`
	}
	if json.Unmarshal(b, &v) != nil || v.On == nil {
		return true
	}
	return *v.On
}

// learnFullCopy: what the main PC says now (only when it answers).
func learnFullCopy(root, mainURL string) {
	if mainURL == "" || fullCopyEnv != "" {
		return
	}
	resp, err := fullClient.Get(strings.TrimRight(mainURL, "/") + "/api/companion/info")
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var info struct {
		Service  string `json:"service"`
		FullCopy *bool  `json:"full_copy"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&info) != nil || info.Service != "adal-keep" || info.FullCopy == nil {
		return // (an older main PC says nothing: on, as everywhere)
	}
	if *info.FullCopy != fullCopyAllowed(root) {
		b, _ := json.Marshal(map[string]bool{"on": *info.FullCopy})
		_ = writeAtomic(filepath.Join(root, "full-copy.json"), b, 0o644)
		log.Printf("🗂 The main PC says this PC's own full copy is %v", map[bool]string{true: "on", false: "off"}[*info.FullCopy])
	}
}

// fullLoop: the server on the copy kept running; the window follows the main PC.
func (s *standbyRunner) fullLoop() {
	var steps windowSteps
	for tick := 0; ; tick++ {
		if tick%6 == 0 { // about every minute
			learnFullCopy(s.root, s.realMainAt([]string{hostServer}))
		}
		if !s.fullWanted() {
			s.stopFull()
			time.Sleep(20 * time.Second)
			continue
		}
		if !fullCopyRunning() {
			if err := s.startFull(); err != nil {
				log.Printf("🗂 own copy: %v", err)
				time.Sleep(time.Minute)
				continue
			}
		}
		// Where the window works.
		st, _ := s.stateOf(append([]string{hostServer}, s.mainCandidates()...))
		if st == mainGone && s.findMain() != "" {
			st = mainUp
		}
		wantOwn := steps.step(time.Now(), st)
		if wantOwn && (!fullJoined(s.root) || !ownAnswers()) {
			wantOwn = false // its own server is not there: the window stays with the main PC
		}
		s.setOwn(wantOwn)
		time.Sleep(10 * time.Second)
	}
}

func (s *standbyRunner) setOwn(own bool) {
	fullMu.Lock()
	changed := usingOwn != own
	usingOwn = own
	fullMu.Unlock()
	if !changed {
		return
	}
	if own {
		log.Printf("🗂 The main PC does not answer: the window works on this PC's own copy")
	} else {
		log.Printf("🗂 The main PC answers again: the window goes back to it (what was done here is copied to it)")
	}
}

func ownAnswers() bool {
	resp, err := fullClient.Get(ownServerURL() + "/api/companion/info")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// startFull: the server on this PC's copy, started again whenever it stops.
func (s *standbyRunner) startFull() error {
	swapMu.Lock()
	defer swapMu.Unlock()
	if dirExists(serverDir(s.root) + ".new") {
		if err := s.swapServer(); err != nil {
			log.Printf("🗂 newer server not put in place: %v", err)
		}
	}
	data := fullData(s.root)
	if err := os.MkdirAll(data, 0o755); err != nil {
		return err
	}
	// Not joined yet: it needs the main PC's address and this program's key (once).
	joinMain, joinKey := "", ""
	if !fullJoined(s.root) {
		joinMain = s.realMainAt(append([]string{hostServer}, s.mainCandidates()...))
		if joinMain == "" {
			return fmt.Errorf("not joined yet, and the main PC does not answer: joining when it does")
		}
		k, err := mainAccessKey(false)
		if err != nil {
			return fmt.Errorf("no key from the main PC yet: %v", err)
		}
		joinKey = k
	}
	if err := s.openOffice(); err != nil {
		log.Printf("🗂 the other PCs cannot reach this PC on port %d: %v", officePort, err)
	}
	name, _ := os.Hostname()
	env := append(os.Environ(),
		fmt.Sprintf("PORT=%d", actingPort),
		"ADAL_LISTEN_HOST=127.0.0.1",
		"ADAL_BEHIND_COMPANION=1",
		fmt.Sprintf("ADAL_ADVERTISE_PORT=%d", officePort),
		"ADAL_COMPANION_INSTALL=1",
		"SQLITE_PATH="+filepath.Join(data, "data.sqlite"),
		"ADAL_AGENCY_NUMBER="+mainNumber(),
		"ADAL_PC_NAME="+name,
		"ADAL_HIDDEN_AGENTS=1",
		"ADAL_BROWSER_EXE="+filepath.Join(s.root, "browser", "AdalBrowser.exe"),
		"ADAL_AUTO_UPDATE=0", // this program keeps server\ at the main PC's version (standby.go bundle loop)
		// It runs only when the full copy is on (fullCopyAllowed): its copying and the main role moving too.
		"ADAL_COMPANION_FULL=1",
		// Its robots (robotsEverywhere.js, while the main PC is off) drive this PC's own robot browser — the one the
		// main PC drives — never a second one: where it is, and how to have it started (robot.go).
		fmt.Sprintf("ADAL_ROBOT_CDP=http://127.0.0.1:%d", robotDebugPort),
		fmt.Sprintf("ADAL_ROBOT_BROWSER_URL=http://127.0.0.1:%d/robot", lanHTTPPort),
		"ADAL_ROBOT_TOKEN="+robotToken,
	)
	if joinMain != "" {
		env = append(env, "ADAL_SYNC_JOIN_MAIN="+joinMain, "ADAL_SYNC_JOIN_KEY="+joinKey)
	}
	fullMu.Lock()
	if fullServer != nil {
		fullMu.Unlock()
		return nil
	}
	fullStopping = false
	cmd := exec.Command(serverNode(s.root), "server.js")
	hideWindow(cmd)
	cmd.Dir = serverBackend(s.root)
	cmd.Env = env
	if logf, err := os.OpenFile(filepath.Join(data, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		cmd.Stdout, cmd.Stderr = logf, logf
	}
	if err := cmd.Start(); err != nil {
		fullMu.Unlock()
		return fmt.Errorf("the server did not start: %v", err)
	}
	fullServer = cmd
	fullMu.Unlock()
	if joinMain != "" {
		log.Printf("🗂 This PC's own copy starts: joining the agency at %s", joinMain)
	} else {
		log.Printf("🗂 This PC's own copy runs (Adal Keep on 127.0.0.1:%d)", actingPort)
	}
	go func() {
		t0 := time.Now()
		err := cmd.Wait()
		if f, ok := cmd.Stdout.(*os.File); ok {
			f.Close()
		}
		fullMu.Lock()
		fullServer = nil
		stopping := fullStopping
		fullMu.Unlock()
		if stopping {
			return
		}
		// (exit 0: it asked for it — joined, a role change, an update; started again at once)
		if time.Since(t0) < 15*time.Second && err != nil {
			time.Sleep(30 * time.Second)
		}
		log.Printf("🗂 own copy's server stopped (%v) — starting it again", err)
	}()
	return nil
}

// stopFull: the server on the copy stopped (a newer server to put in place, the copy switched off).
func (s *standbyRunner) stopFull() {
	fullMu.Lock()
	cmd := fullServer
	fullStopping = true
	usingOwn = false
	fullMu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	cmd.Process.Kill()
	for i := 0; i < 50 && fullCopyRunning(); i++ {
		time.Sleep(100 * time.Millisecond)
	}
}
