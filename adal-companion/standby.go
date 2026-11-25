// standby.go — every Adal Companion is a full Adal Keep in waiting (asked on
// 2026-11-20: "the only difference between main PC and companion PC is just
// the buttons").
//
//   - The server itself: while the main PC answers, this program keeps the
//     main PC's server (Node and the backend, never its data) in server\
//     (GET /api/companion/server-bundle, again when the main PC's version
//     changes). The agency's data is here already: the locked copy (replica.go).
//   - Standing in: when the main PC has not answered for 5 minutes, and is not
//     alive anywhere else (its heartbeat online), ONE Companion of the office —
//     the strongest with a copy and the server, agreed on the network
//     (UDP 45456) — opens its copy into server\backend\data
//     (scripts/standby-restore.mjs), starts the server on 127.0.0.1:4140, and
//     lets the office in on port 4000 (this program has its firewall rule): each
//     computer comes from a loopback address of its own and says who it is
//     (backend networkGate). The window here, and the other Companions (they
//     find it by its number), work in it: robots, AI chat, backups, updates,
//     the phone, everything — the same Adal Keep.
//   - The main PC back: it reads what was done here since (POST
//     /api/companion/merge-back, with a token only it is given; the newest change
//     wins, nothing is deleted), then this server stops and everyone works on the
//     main PC again.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	standbyAfter   = time.Duration(envInt("ADAL_STANDBY_MINUTES", 5)) * time.Minute
	actingPort     = envInt("ADAL_ACTING_PORT", 4140) // the server standing in, on 127.0.0.1 only
	officePort     = envInt("ADAL_OFFICE_PORT", 4000) // what the office reaches (this program)
	standbyUDPPort = envInt("ADAL_STANDBY_UDP", 45456)
	bundleEvery    = 30 * time.Minute // a 304 when nothing changed: cheap
)

const standbyMagic = "ADAL_STANDBY_V1"

type standbyState struct {
	Acting        bool   `json:"acting,omitempty"`
	Since         string `json:"since,omitempty"` // standing in from (UTC): the merge back reads what changed after it
	Token         string `json:"token,omitempty"` // the main PC reads this PC's work with it
	MainInstance  string `json:"main_instance,omitempty"`
	BundleVersion string `json:"bundle_version,omitempty"`
	BundleAt      string `json:"bundle_at,omitempty"`
}

type standbyPeer struct {
	addr   string // where it is (its copy and server: port 47810, peers.go)
	id     string
	score  int
	acting bool
	ready  bool
	at     time.Time
}

type standbyRunner struct {
	root     string
	mu       sync.Mutex
	st       standbyState
	peers    map[string]standbyPeer
	mainSeen time.Time
	server   *exec.Cmd
	office   net.Listener
	door     *officeDoor
	myID     string
	realMain string // the main PC's address, remembered while it answered
	mainUpAt time.Time
	ownDead  int // looks in a row this PC's own server did not answer (hand back)
	ownNext  time.Time
}

var standby *standbyRunner

// ── Where things are ────────────────────────────────────────────────────────

func serverDir(root string) string  { return filepath.Join(root, "server") }
func serverNode(root string) string { return filepath.Join(serverDir(root), "runtime", "node.exe") }
func serverBackend(root string) string {
	return filepath.Join(serverDir(root), "backend")
}
func hasServer(root string) bool {
	if _, err := os.Stat(serverNode(root)); err != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(serverBackend(root), "server.js"))
	return err == nil
}
func standbyPath(root string) string { return filepath.Join(root, "standby.json") }

func (s *standbyRunner) load() {
	if b, err := os.ReadFile(standbyPath(s.root)); err == nil {
		_ = json.Unmarshal(b, &s.st)
	}
}
func (s *standbyRunner) save() {
	b, _ := json.MarshalIndent(s.st, "", "  ")
	_ = writeAtomic(standbyPath(s.root), b, 0o600)
}

// standbyActing: this PC stands in for the main PC now.
func standbyActing() bool {
	if standby == nil {
		return false
	}
	standby.mu.Lock()
	defer standby.mu.Unlock()
	return standby.st.Acting
}

func companionOwnID(root string) string {
	if b, err := os.ReadFile(filepath.Join(root, "companion-id")); err == nil {
		if v := strings.TrimSpace(string(b)); v != "" {
			return v
		}
	}
	h, _ := os.Hostname()
	return "host-" + h
}

func mainNumber() string {
	if n := loadIdentity().Number; n != "" {
		return n
	}
	return confNumber()
}

func numberTag(n string) string {
	h := sha1.Sum([]byte("adal-standby|" + n))
	return hex.EncodeToString(h[:8])
}

// ready: this PC could stand in (the server, a copy of the agency, its key).
func (s *standbyRunner) ready() bool {
	return hasServer(s.root) && loadState().Made != "" && loadKeys().Password != "" && mainNumber() != ""
}

func myScore() int { return runtime.NumCPU() }

// ── Start ───────────────────────────────────────────────────────────────────

func startStandby(root string) {
	if os.Getenv("ADAL_STANDBY") == "0" {
		return
	}
	s := &standbyRunner{root: root, peers: map[string]standbyPeer{}, mainSeen: time.Now(), myID: companionOwnID(root)}
	s.load()
	standby = s
	go s.listen()
	go s.announce()
	go s.bundleLoop()
	go s.watch()
	go s.fullLoop()  // its own full copy, run all the time (full.go)
	if s.st.Acting { // it stood in when this program stopped (a restart): it goes on
		log.Printf("🏢 Standing in for the main PC again (since %s)", s.st.Since)
		go s.run()
	}
}

// ── The server, kept from the main PC ───────────────────────────────────────

// kickBundle: a new version came — the server in waiting is looked at now.
var bundleKick = make(chan struct{}, 1)

func kickBundle() {
	select {
	case bundleKick <- struct{}{}:
	default:
	}
}

func (s *standbyRunner) bundleLoop() {
	time.Sleep(2 * time.Minute)
	for {
		learnNumberOnline(s.root)
		// Only for this PC's own full copy (switched on per agency, full.go); never from another
		// Companion (2026-11-23: no update pieces between the office's PCs).
		if !standbyActing() && fullCopyAllowed(s.root) {
			var err error
			if hostServer != "" && pingServer() {
				err = s.fetchBundle()
			}
			if err != nil {
				log.Printf("🏢 server copy: %v", err)
			}
		}
		wait := bundleEvery
		if !hasServer(s.root) {
			wait = 15 * time.Minute // none yet: soon again
		}
		select {
		case <-bundleKick:
			time.Sleep(90 * time.Second) // the main PC installs it too, then has the same version
		case <-time.After(wait):
		}
	}
}

var bundleClient = &http.Client{Timeout: 30 * time.Minute}

func (s *standbyRunner) fetchBundle() error {
	key, err := mainAccessKey(false)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodGet, strings.TrimRight(hostServer, "/")+"/api/companion/server-bundle", nil)
	req.Header.Set("x-adal-pc", key)
	s.mu.Lock()
	have := s.st.BundleVersion
	s.mu.Unlock()
	if have != "" && hasServer(s.root) {
		req.Header.Set("If-None-Match", `"`+have+`"`)
	}
	resp, err := bundleClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotModified:
		return nil
	case http.StatusNotFound:
		return nil // a main PC run by a developer (no runtime there)
	case http.StatusOK:
	default:
		return fmt.Errorf("the main PC answered %d", resp.StatusCode)
	}
	return s.installBundle(resp.Body, resp.Header.Get("X-Adal-Version"))
}

// installBundle: a server (as tar.gz) unpacked beside the one here and put in
// place (when this PC does not stand in now), this PC's data folder kept.
func (s *standbyRunner) installBundle(body io.Reader, ver string) error {
	part := filepath.Join(s.root, "server-bundle.tgz.part")
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, body)
	f.Close()
	if err != nil {
		os.Remove(part)
		return err
	}
	newDir := serverDir(s.root) + ".new"
	os.RemoveAll(newDir)
	if err := os.MkdirAll(newDir, 0o755); err != nil {
		return err
	}
	cmd := exec.Command(windowsTar(), "-xzf", part, "-C", newDir)
	hideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		os.RemoveAll(newDir)
		os.Remove(part)
		return fmt.Errorf("unpacking the server: %v %s", err, strings.TrimSpace(string(out)))
	}
	os.Remove(part)
	openSettings(newDir)
	log.Printf("🏢 The main PC's server is kept here (%d MB, version %.7s)", n>>20, ver)
	s.mu.Lock()
	s.st.BundleVersion, s.st.BundleAt = ver, time.Now().UTC().Format(time.RFC3339)
	s.save()
	acting := s.st.Acting
	s.mu.Unlock()
	if !acting {
		// Its own copy's server runs from that folder: stopped for the swap, started again by fullLoop.
		swapMu.Lock()
		defer swapMu.Unlock()
		s.stopFull()
		return s.swapServer()
	}
	return nil
}

// swapServer: the new server in place; this PC's own data folder kept.
func (s *standbyRunner) swapServer() error {
	cur, nw, old := serverDir(s.root), serverDir(s.root)+".new", serverDir(s.root)+".old"
	if _, err := os.Stat(nw); err != nil {
		return nil
	}
	// (uploads: what people uploaded on this PC's own copy, full.go — kept like the data)
	for _, keep := range []string{"data", "uploads"} {
		if d := filepath.Join(cur, "backend", keep); dirExists(d) {
			os.RemoveAll(filepath.Join(nw, "backend", keep))
			if err := os.Rename(d, filepath.Join(nw, "backend", keep)); err != nil {
				return err
			}
		}
	}
	os.RemoveAll(old)
	if dirExists(cur) {
		if err := os.Rename(cur, old); err != nil {
			return err
		}
	}
	if err := os.Rename(nw, cur); err != nil {
		os.Rename(old, cur)
		return err
	}
	os.RemoveAll(old)
	return nil
}

func dirExists(p string) bool { fi, err := os.Stat(p); return err == nil && fi.IsDir() }

// ── Which Companion stands in (the office agrees on the network) ───────────

func (s *standbyRunner) message() string {
	acting, ready := "0", "0"
	if standbyActing() {
		acting = "1"
	}
	if s.ready() {
		ready = "1"
	}
	return strings.Join([]string{standbyMagic, numberTag(mainNumber()), s.myID, strconv.Itoa(myScore()), acting, ready}, "|")
}

func (s *standbyRunner) announce() {
	for {
		if mainNumber() != "" {
			if c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0}); err == nil {
				setBroadcast(c)
				msg := []byte(s.message())
				for _, a := range broadcastTargets() {
					c.WriteToUDP(msg, &net.UDPAddr{IP: a.IP, Port: standbyUDPPort})
				}
				c.Close()
			}
		}
		time.Sleep(10 * time.Second)
	}
}

func (s *standbyRunner) listen() {
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: standbyUDPPort})
	if err != nil {
		log.Printf("🏢 standby: %v", err)
		return
	}
	buf := make([]byte, 512)
	for {
		n, from, err := c.ReadFromUDP(buf)
		if err != nil {
			return
		}
		s.heard(string(buf[:n]), time.Now(), peerIP(from))
	}
}

// heard: another Companion of this agency (the same main PC's number) says how it is.
func (s *standbyRunner) heard(msg string, now time.Time, addr ...string) {
	p := strings.Split(strings.TrimSpace(msg), "|")
	if len(p) != 6 || p[0] != standbyMagic || p[1] != numberTag(mainNumber()) || p[2] == s.myID {
		return
	}
	score, _ := strconv.Atoi(p[3])
	s.mu.Lock()
	a := ""
	if len(addr) > 0 {
		a = addr[0]
	}
	s.peers[p[2]] = standbyPeer{addr: a, id: p[2], score: score, acting: p[4] == "1", ready: p[5] == "1", at: now}
	s.mu.Unlock()
}

// othersActing: another Companion stands in already.
func (s *standbyRunner) othersActing(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.peers {
		if p.acting && now.Sub(p.at) < 40*time.Second {
			return true
		}
	}
	return false
}

// myTurn: the strongest ready Companion heard lately (the same strength: the
// smallest id) — this one.
func (s *standbyRunner) myTurn(now time.Time) bool {
	type cand struct {
		id    string
		score int
	}
	list := []cand{{s.myID, myScore()}}
	s.mu.Lock()
	for _, p := range s.peers {
		if p.ready && now.Sub(p.at) < 40*time.Second {
			list = append(list, cand{p.id, p.score})
		}
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		if list[i].score != list[j].score {
			return list[i].score > list[j].score
		}
		return list[i].id < list[j].id
	})
	return list[0].id == s.myID
}

// ── Is the main PC there? ───────────────────────────────────────────────────

type healthReply struct {
	Status   string `json:"status"`
	Role     string `json:"role"`
	Instance string `json:"instance"`
	Acting   bool   `json:"acting"`
}

func healthOf(u string, wait time.Duration) *healthReply {
	c := probeClient
	if steadyOff {
		c = &http.Client{Timeout: wait}
	}
	resp, err := c.Get(strings.TrimRight(u, "/") + "/api/health")
	if err != nil {
		markBusy(u, true)
		return nil
	}
	defer resp.Body.Close()
	var h healthReply
	if json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&h) != nil || h.Status != "ok" {
		markBusy(u, true) // (a 502, a cut answer: something is there, not well)
		return nil
	}
	markBusy(u, false)
	return &h
}

func isLoopbackURL(u string) bool {
	p, err := url.Parse(u)
	if err != nil {
		return false
	}
	ip := net.ParseIP(p.Hostname())
	return p.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
}

// realMainAt: the first of these addresses that is the main PC itself (not a
// Companion standing in, not this PC): it answers, and says our number is its own.
func (s *standbyRunner) realMainAt(cands []string) string {
	num := mainNumber()
	for _, u := range cands {
		u = strings.TrimRight(u, "/")
		if u == "" || isLoopbackURL(u) || s.ownAddress(u) {
			continue
		}
		h := healthOf(u, 2*time.Second)
		if h == nil || h.Acting || h.Role == "follower" {
			continue
		}
		if num != "" && !numberKnown(u, num) {
			continue
		}
		s.mu.Lock()
		if h.Instance != "" {
			s.st.MainInstance = h.Instance
		}
		s.realMain, s.mainUpAt = u, time.Now()
		s.mu.Unlock()
		sweepFound()
		return u
	}
	return ""
}

// ownAddress: u is this PC (its port 4000 is this program when it stands in).
func (s *standbyRunner) ownAddress(u string) bool {
	p, err := url.Parse(u)
	if err != nil {
		return false
	}
	ip := net.ParseIP(p.Hostname())
	if ip == nil {
		return false
	}
	for _, a := range localIPs() {
		if a.Equal(ip) {
			return true
		}
	}
	return false
}

func localIPs() []net.IP {
	var out []net.IP
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			out = append(out, n.IP)
		}
	}
	return out
}

func (s *standbyRunner) mainCandidates() []string {
	s.mu.Lock()
	cands := []string{s.realMain}
	s.mu.Unlock()
	return uniqueURLs(append(cands, hostServer, loadIdentity().URL, pinnedHostURL()))
}

// findMain: the main PC at an address known here; only when it is at none of them, searched.
func (s *standbyRunner) findMain() string {
	cands := s.mainCandidates()
	st, u := s.stateOf(cands)
	if st != mainGone {
		return u // it answers — or it is there, only busy: nothing is searched
	}
	if info := discoverServer(1500 * time.Millisecond); info != nil {
		return s.realMainAt([]string{info.URL})
	}
	return ""
}

// mainAliveOnline: the main PC's heartbeat (online) is fresh and is not a
// Companion standing in — the main PC is on somewhere (another network): this
// office must not start a second main PC.
func (s *standbyRunner) mainAliveOnline() bool {
	c := readCloud(s.root)
	if c == nil {
		return false // no online account here: nothing tells us otherwise
	}
	h := &http.Client{Timeout: 8 * time.Second}
	tok, err := c.token(h)
	if err != nil {
		return false
	}
	req, _ := http.NewRequest(http.MethodGet, c.URL+"/rest/v1/keep_meta?key=eq./_pc&select=data", nil)
	req.Header.Set("apikey", c.Anon)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := h.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var rows []struct {
		Data struct {
			At     string `json:"at"`
			Acting bool   `json:"acting"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&rows) != nil || len(rows) == 0 {
		return false
	}
	at, err := time.Parse(time.RFC3339, rows[0].Data.At)
	return err == nil && time.Since(at) < 90*time.Second && !rows[0].Data.Acting
}

// ── The watch ───────────────────────────────────────────────────────────────

func (s *standbyRunner) watch() {
	for {
		time.Sleep(20 * time.Second)
		now := time.Now()
		openSettings(serverDir(s.root)) // settings that came locked before the key: opened once the key is here
		if standbyActing() {
			if u := s.findMain(); u != "" && s.ownReadyToHandBack(now) {
				log.Printf("🏢 The main PC is back at %s: handing over what was done here", u)
				if err := s.handBack(u); err != nil {
					log.Printf("🏢 hand back: %v (trying again in a minute)", err)
					s.mu.Lock()
					if s.door != nil {
						s.door.onlyFrom(nil) // the office works here again meanwhile
					}
					s.mu.Unlock()
					time.Sleep(time.Minute)
				}
			}
			continue
		}
		if signedOut() || fullCopyRunning() { // (its own full copy: nothing to stand in for, full.go)
			continue
		}
		if u := s.realMainAt([]string{hostServer}); u != "" {
			s.mainSeen = now
			s.mu.Lock()
			s.save()
			s.mu.Unlock()
			continue
		}
		if s.othersActing(now) || now.Sub(s.mainSeen) < standbyAfter {
			continue
		}
		// (There but too busy to answer is not "away": this office has one main PC.)
		st, _ := s.stateOf(s.mainCandidates())
		if st == mainUp || (st == mainGone && s.findMain() != "") {
			s.mainSeen = now
			continue
		}
		if st == mainSlow && now.Sub(s.mainSeen) < standbyAfter+slowAfter {
			continue
		}
		learnNumberOnline(s.root)
		if !s.ready() || !s.myTurn(now) || s.mainAliveOnline() {
			continue
		}
		s.standIn()
	}
}

func randomToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// standIn: this PC opens its copy and becomes the office's Adal Keep.
func (s *standbyRunner) standIn() {
	log.Printf("🏢 The main PC has not answered for %s: this PC stands in for it", standbyAfter)
	s.mu.Lock()
	if dirExists(serverDir(s.root) + ".new") {
		s.mu.Unlock()
		if err := s.swapServer(); err != nil {
			log.Printf("🏢 newer server not put in place: %v", err)
		}
		s.mu.Lock()
	}
	s.mu.Unlock()
	if err := s.openCopy(); err != nil {
		log.Printf("🏢 the copy could not be opened: %v — this PC does not stand in", err)
		return
	}
	s.mu.Lock()
	s.st.Acting = true
	s.st.Since = time.Now().UTC().Format(time.RFC3339)
	s.st.Token = randomToken()
	s.save()
	s.mu.Unlock()
	go s.run()
}

// openCopy: the locked copy here, opened into the server's data folder.
func (s *standbyRunner) openCopy() error {
	data := filepath.Join(serverBackend(s.root), "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		return err
	}
	// This server says the main PC's number is its own (the Companions find it by
	// it) and follows nobody; its own id stays from one time to the next.
	mp := filepath.Join(data, "main-pc.json")
	cur := map[string]any{}
	if b, err := os.ReadFile(mp); err == nil {
		_ = json.Unmarshal(b, &cur)
	}
	cur["main_url"] = ""
	cur["pc_number"] = mainNumber()
	b, _ := json.MarshalIndent(cur, "", "  ")
	if err := os.WriteFile(mp, b, 0o644); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()
	cmd := exec.CommandContext(ctx, serverNode(s.root), filepath.Join("scripts", "standby-restore.mjs"))
	hideWindow(cmd)
	cmd.Dir = serverBackend(s.root)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ADAL_RESTORE_FROM=http://127.0.0.1:%d", lanHTTPPort),
		"ADAL_RESTORE_NUMBER="+mainNumber(),
		"ADAL_RESTORE_PASSWORD="+loadKeys().Password,
	)
	out, err := cmd.Output()
	var r struct {
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
		Files    int    `json:"files"`
		Database bool   `json:"database"`
		Made     string `json:"made"`
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	_ = json.Unmarshal([]byte(lines[len(lines)-1]), &r)
	if err != nil || !r.OK {
		if r.Error != "" {
			return errors.New(r.Error)
		}
		return fmt.Errorf("restore: %v", err)
	}
	log.Printf("🏢 Copy opened: the database (made %s) and %d document(s)", r.Made, r.Files)
	return nil
}

// run: the server standing in, kept running; the office let in on port 4000.
func (s *standbyRunner) run() {
	if err := s.openOffice(); err != nil {
		log.Printf("🏢 the office cannot reach this PC on port %d: %v", officePort, err)
	}
	hostServer = fmt.Sprintf("http://127.0.0.1:%d", actingPort)
	os.Setenv("ADAL_HOST_URL", hostServer)
	quick := 0 // starts in a row that ended within 15 s
	for standbyActing() {
		backend := serverBackend(s.root)
		logf, _ := os.OpenFile(filepath.Join(backend, "data", "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		cmd := exec.Command(serverNode(s.root), "server.js")
		hideWindow(cmd)
		cmd.Dir = backend
		s.mu.Lock()
		since, token := s.st.Since, s.st.Token
		s.mu.Unlock()
		cmd.Env = append(os.Environ(),
			fmt.Sprintf("PORT=%d", actingPort),
			"ADAL_LISTEN_HOST=127.0.0.1",
			"ADAL_BEHIND_COMPANION=1",
			fmt.Sprintf("ADAL_ADVERTISE_PORT=%d", officePort),
			"ADAL_ACTING_MAIN=1",
			"ADAL_ACTING_SINCE="+since,
			"ADAL_MERGE_TOKEN="+token,
			"ADAL_HIDDEN_AGENTS=1",
			"ADAL_BROWSER_EXE="+filepath.Join(s.root, "browser", "AdalBrowser.exe"),
		)
		// It ends at once again and again: its pages and data only (no robots, copying, updates …), so
		// what was done here can still be read by the main PC (hand back).
		if quick >= 3 && !steadyOff {
			log.Printf("🏢 the server ended at once %d times: started with its data only. Its last words: %s", quick, lastLines(filepath.Join(backend, "data", "server.log"), 600))
			cmd.Env = append(cmd.Env, "ADAL_ISOLATED=1", "ADAL_SYNC=0")
		}
		if logf != nil {
			cmd.Stdout, cmd.Stderr = logf, logf
		}
		t0 := time.Now()
		if err := cmd.Start(); err != nil {
			log.Printf("🏢 the server did not start: %v", err)
			time.Sleep(30 * time.Second)
			continue
		}
		s.mu.Lock()
		s.server = cmd
		s.mu.Unlock()
		log.Printf("🏢 Adal Keep runs on this PC now (standing in for the main PC)")
		err := cmd.Wait()
		if logf != nil {
			logf.Close()
		}
		s.mu.Lock()
		s.server = nil
		s.mu.Unlock()
		if !standbyActing() {
			break
		}
		log.Printf("🏢 the server stopped (%v) — starting it again", err)
		if time.Since(t0) < 15*time.Second {
			quick++
			time.Sleep(restartPause(quick))
		} else {
			quick = 0
			time.Sleep(3 * time.Second)
		}
	}
}

// restartPause: 30 s, 1, 2, then 5 minutes between starts of a server that ends at once.
func restartPause(n int) time.Duration {
	if steadyOff {
		return 30 * time.Second
	}
	return []time.Duration{30 * time.Second, 30 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}[min(max(n, 0), 5)]
}

// lastLines: the end of a log, on one line.
func lastLines(p string, n int) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return "(no log)"
	}
	if len(b) > n {
		b = b[len(b)-n:]
	}
	return strings.Join(strings.Fields(string(b)), " ")
}

// ownReadyToHandBack: this PC's own server answers, so the main PC can read what was done here.
// It does not: the main PC is not asked to read it (it failed every 90 s, for ever); run() starts
// it again, and this looks again after 1, 2, 4 … 15 minutes. Nothing here is dropped meanwhile.
func (s *standbyRunner) ownReadyToHandBack(now time.Time) bool {
	if steadyOff || ownAnswers() {
		s.ownDead = 0
		return true
	}
	if now.Before(s.ownNext) {
		return false
	}
	s.ownDead++
	p := time.Minute << min(s.ownDead-1, 4)
	if p > 15*time.Minute {
		p = 15 * time.Minute
	}
	s.ownNext = now.Add(p)
	log.Printf("🏢 The main PC is back, but this PC's own server does not answer: what was done here waits in %s (looked at again in %s)", filepath.Join(serverBackend(s.root), "data"), p)
	return false
}

// officeAddr: the loopback address a computer of the office comes from (127.<b>.<c>.<d>
// for a.b.c.d): never 127.0.0.1, so the server never takes it for this PC itself.
func officeAddr(ip net.IP) net.IP {
	v4 := ip.To4()
	if v4 == nil {
		return net.IPv4(127, 250, 0, 6)
	}
	out := net.IPv4(127, v4[1], v4[2], v4[3])
	if v4[1] == 0 && v4[2] == 0 && v4[3] <= 1 || v4[1] == 255 && v4[2] == 255 && v4[3] == 255 {
		return net.IPv4(127, 254, 254, 254)
	}
	if out.Equal(net.IPv4(127, 0, 0, 1)) {
		return net.IPv4(127, 254, 254, 254)
	}
	return out
}

type officeDoor struct {
	mu         sync.Mutex
	transports map[string]*http.Transport
	target     *url.URL
	only       net.IP // handing back: only the main PC comes in (nothing new is lost)
}

func (d *officeDoor) onlyFrom(ip net.IP) {
	d.mu.Lock()
	d.only = ip
	d.mu.Unlock()
}

func (d *officeDoor) transportFor(client net.IP) *http.Transport {
	key := client.String()
	d.mu.Lock()
	defer d.mu.Unlock()
	if t := d.transports[key]; t != nil {
		return t
	}
	local := &net.TCPAddr{IP: officeAddr(client)}
	dialer := &net.Dialer{Timeout: 5 * time.Second, LocalAddr: local}
	t := &http.Transport{
		Proxy:               nil,
		DialContext:         dialer.DialContext,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
	}
	d.transports[key] = t
	return t
}

func (d *officeDoor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	if err != nil || ip == nil {
		http.Error(w, "no", http.StatusBadRequest)
		return
	}
	d.mu.Lock()
	only := d.only
	d.mu.Unlock()
	if only != nil && !only.Equal(ip) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error":"Adal Keep is going back to the main PC — one moment"}`))
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(d.target)
			pr.Out.Host = pr.In.Host // the address the computer used (the server checks it)
			pr.Out.Header.Set("x-adal-real-ip", ip.String())
			pr.SetXForwarded()
		},
		Transport:     d.transportFor(ip),
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			ownDown(w, r, mainForPages())
		},
	}
	rp.ServeHTTP(w, r)
}

// mainForPages: the main PC's address when it answered within the last 2 minutes.
func mainForPages() string {
	if standby == nil {
		return ""
	}
	standby.mu.Lock()
	defer standby.mu.Unlock()
	if time.Since(standby.mainUpAt) < 2*time.Minute {
		return standby.realMain
	}
	return ""
}

// ownDown: this PC's own server does not answer. A page goes to the main PC when it is there;
// a call is told to try again (503 with a time, never a bare 502).
func ownDown(w http.ResponseWriter, r *http.Request, main string) {
	if main != "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) && !strings.HasPrefix(r.URL.Path, "/api/") && strings.Contains(r.Header.Get("Accept"), "text/html") {
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, main+r.URL.RequestURI(), http.StatusTemporaryRedirect)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "5")
	w.WriteHeader(http.StatusServiceUnavailable)
	w.Write([]byte(`{"error":"Adal Keep is starting on this PC — try again in a moment"}`))
}

func (s *standbyRunner) openOffice() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.office != nil {
		return nil
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", officePort))
	if err != nil {
		return err
	}
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", actingPort))
	s.office = ln
	s.door = &officeDoor{transports: map[string]*http.Transport{}, target: target}
	go http.Serve(ln, s.door)
	return nil
}

func (s *standbyRunner) closeOffice() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.office != nil {
		s.office.Close()
		s.office = nil
		s.door = nil
	}
}

// ── Back to the main PC ─────────────────────────────────────────────────────

// handBack: the main PC reads what was done here since this PC stood in, then
// this server stops and everyone works on the main PC again.
func (s *standbyRunner) handBack(mainURL string) error {
	s.mu.Lock()
	since, token := s.st.Since, s.st.Token
	s.mu.Unlock()
	// From now on only the main PC comes in: nothing saved here after it read is lost.
	if p, err := url.Parse(mainURL); err == nil {
		if ips, err := net.LookupIP(p.Hostname()); err == nil && len(ips) > 0 {
			s.mu.Lock()
			if s.door != nil {
				s.door.onlyFrom(ips[0])
			}
			s.mu.Unlock()
		}
	}
	hostServer = mainURL
	os.Setenv("ADAL_HOST_URL", mainURL)
	key, err := mainAccessKey(false)
	if err != nil {
		return err
	}
	body := map[string]any{"token": token, "since": since, "port": officePort}
	code, err := mainJSON(http.MethodPost, "/api/companion/merge-back", body, key, nil)
	if code == http.StatusUnauthorized || code == http.StatusForbidden {
		if key, err = mainAccessKey(true); err == nil {
			code, err = mainJSON(http.MethodPost, "/api/companion/merge-back", body, key, nil)
		}
	}
	if err != nil && code != http.StatusConflict { // 409: a merge runs already (perhaps ours): wait for it
		return err
	}
	deadline := time.Now().Add(3 * time.Hour)
	for time.Now().Before(deadline) {
		time.Sleep(5 * time.Second)
		var job struct {
			Running bool   `json:"running"`
			Error   string `json:"error"`
			Source  string `json:"source"`
			Since   string `json:"since"`
			Total   int    `json:"total"`
			Done    int    `json:"done"`
			Added   int    `json:"added"`
			Newer   int    `json:"newer"`
			Docs    int    `json:"docs_added"`
		}
		if _, err := mainJSON(http.MethodGet, "/api/companion/merge-back", nil, key, &job); err != nil {
			continue
		}
		if job.Running {
			continue
		}
		if job.Since != since {
			return errors.New("the main PC ran another merge — trying again")
		}
		if job.Error != "" {
			return errors.New(job.Error)
		}
		log.Printf("🏢 Handed back to the main PC: %d profile(s) read, %d new, %d changed, %d document(s)", job.Total, job.Added, job.Newer, job.Docs)
		s.stepDown()
		return nil
	}
	return errors.New("the merge took too long")
}

func (s *standbyRunner) stepDown() {
	s.mu.Lock()
	s.st.Acting = false
	s.st.Token = ""
	s.save()
	cmd := s.server
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
	s.closeOffice()
	s.mainSeen = time.Now()
	if err := s.swapServer(); err != nil {
		log.Printf("🏢 newer server not put in place: %v", err)
	}
	log.Printf("🏢 This PC no longer stands in: everyone works on the main PC again")
}

// standbyStatus: what this PC is doing, for its window (/local/standby).
func standbyStatus() map[string]any {
	out := map[string]any{"ready": false, "acting": false}
	if standby == nil {
		return out
	}
	s := standby
	s.mu.Lock()
	defer s.mu.Unlock()
	out["acting"] = s.st.Acting
	out["since"] = s.st.Since
	out["server_version"] = s.st.BundleVersion
	out["server_at"] = s.st.BundleAt
	out["main_seen"] = s.mainSeen.UTC().Format(time.RFC3339)
	fullMu.Lock()
	out["full_copy"], out["using_own"] = fullServer != nil, usingOwn
	fullMu.Unlock()
	out["full_joined"] = fullJoined(s.root)
	return out
}
