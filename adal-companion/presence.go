package main

// presence.go — the office's PCs know each other by an id that never changes,
// not by IP (2026-11-23, the owner: a Companion kept the main PC's old address
// after it moved from .4 to .12; a hotspot and a Tailscale address were tried).
//
//   - This PC's id: companion-id next to the program, 12 hex, made by the
//     Companion itself the first time it starts (an update is enough: no
//     installer, no admin rights), with a copy in companion-id.bak; never made
//     again once it exists.
//   - Every 5 s, on UDP 45454 (the same message as Adal Keep's own,
//     backend services/pcPresence.js):
//     ADAL_KEEP_PC_V1|<agency tag>|<pc id>|<port>|<role>|<name>|<flags>
//     (the tag is a hash of the main PC's number, never the number).
//   - Every message heard: a live map pc id → the address it came from now. Only
//     this agency's PCs (our tag), only addresses of this PC's own network (never
//     Tailscale 100.64/10, link-local, another subnet).
//   - The main PC: known by its id (main-pc.json pc_id, learned from its
//     /api/companion/info once it said our number is its own). When it says it
//     from a new address the Companion goes there at once; when it stops
//     answering, the map is looked at first (discoverServer).
//   - A network card (MAC) is only a hint: Windows' "random hardware addresses"
//     change a Wi-Fi card's MAC — this PC warns when it is on here.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const presenceMagic = "ADAL_KEEP_PC_V1"

var (
	presencePort  = envInt("ADAL_PRESENCE_PORT", discoveryPort)
	presenceEvery = time.Duration(envInt("ADAL_PRESENCE_MS", 5000)) * time.Millisecond
	presenceFresh = time.Duration(envInt("ADAL_PRESENCE_FRESH_MS", 20000)) * time.Millisecond
	presenceIDRe  = regexp.MustCompile(`^[0-9a-zA-Z-]{6,40}$`)
	ownIDRe       = regexp.MustCompile(`^[0-9a-f]{12}$`)

	presenceMu  sync.Mutex
	presenceMap = map[string]presenceEntry{}
	myPCID      string
	// presenceAddrOK: an address a PC of this office can be reached at (replaced in tests).
	presenceAddrOK = func(ip net.IP) bool { return lanUsable(ip) && onOwnNet(ip) }
	// presenceSwitch: the main PC said it from a new address (replaced in tests).
	presenceSwitch = switchToMainAt
)

type presenceEntry struct {
	ID, IP, Role, Name string
	Port               int
	Tags               []string
	RandomMac          bool
	At                 time.Time
}

func (e presenceEntry) url() string { return "http://" + net.JoinHostPort(e.IP, fmt.Sprint(e.Port)) }

// ensurePCID: this PC's permanent id — read, restored from its copy, or made once.
func ensurePCID(root string) string {
	f := filepath.Join(root, "companion-id")
	read := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil {
			return ""
		}
		v := strings.TrimSpace(string(b))
		if !ownIDRe.MatchString(v) {
			return ""
		}
		return v
	}
	if v := read(f); v != "" {
		if read(f+".bak") != v {
			_ = writeAtomic(f+".bak", []byte(v), 0o644)
		}
		return v
	}
	if v := read(f + ".bak"); v != "" {
		if _, err := os.Stat(f); err == nil {
			_ = os.Rename(f, fmt.Sprintf("%s.damaged-%d", f, time.Now().Unix()))
		}
		_ = writeAtomic(f, []byte(v), 0o644)
		log.Printf("🪪 This PC's id restored from its copy: %s", v)
		return v
	}
	if _, err := os.Stat(f); err == nil {
		// Something is there but not an id: kept aside, never overwritten silently.
		_ = os.Rename(f, fmt.Sprintf("%s.damaged-%d", f, time.Now().Unix()))
	}
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	v := hex.EncodeToString(b)
	if writeAtomic(f, []byte(v), 0o644) != nil {
		return ""
	}
	_ = writeAtomic(f+".bak", []byte(v), 0o644)
	log.Printf("🪪 This PC's permanent id: %s", v)
	return v
}

func presenceMessage(tag, id string, port int, role, name string, randMac bool) string {
	flags := ""
	if randMac {
		flags = "randmac"
	}
	name = strings.NewReplacer("|", " ", "\n", " ").Replace(name)
	if len(name) > 60 {
		name = name[:60]
	}
	return strings.Join([]string{presenceMagic, tag, id, fmt.Sprint(port), role, name, flags}, "|")
}

func parsePresence(text string) (presenceEntry, bool) {
	p := strings.Split(strings.TrimSpace(text), "|")
	if len(p) < 5 || p[0] != presenceMagic || !presenceIDRe.MatchString(p[2]) {
		return presenceEntry{}, false
	}
	port, err := strconv.Atoi(p[3])
	if err != nil {
		port = 0
	}
	if port < 1 || port > 65535 {
		return presenceEntry{}, false
	}
	e := presenceEntry{ID: p[2], Port: port, Role: p[4]}
	for _, t := range strings.Split(p[1], ",") {
		if t != "" {
			e.Tags = append(e.Tags, t)
		}
	}
	if len(p) > 5 {
		e.Name = p[5]
	}
	e.RandomMac = len(p) > 6 && p[6] == "randmac"
	return e, true
}

// presenceHeard: one message from fromIP. Kept only for this agency's PCs on this network.
func presenceHeard(text, fromIP string) (presenceEntry, bool) {
	e, ok := parsePresence(text)
	if !ok {
		return e, false
	}
	ip := net.ParseIP(strings.TrimPrefix(fromIP, "::ffff:"))
	tag := ownAgencyTag()
	ours := false
	for _, t := range e.Tags {
		ours = ours || (tag != "" && t == tag)
	}
	if !ours || e.ID == myPCID || ip == nil || !presenceAddrOK(ip) {
		return e, false
	}
	e.IP, e.At = ip.String(), time.Now()
	presenceMu.Lock()
	before, had := presenceMap[e.ID]
	presenceMap[e.ID] = e
	presenceMu.Unlock()
	if had && before.IP != e.IP {
		log.Printf("📍 %s (%s) moved from %s to %s", nameOr(e), e.ID, before.IP, e.IP)
	}
	mainID := loadIdentity().PCID
	switch {
	case mainID != "" && e.ID == mainID:
		if u := e.url(); u != strings.TrimRight(hostServer, "/") {
			oneAtATime(func() { presenceSwitch(u) })
		}
	case mainID == "" && e.Role == "main":
		// The main PC of our tag, its id not known yet: asked whether it is ours (its number).
		u := e.url()
		oneAtATime(func() {
			if acceptServer(u) {
				learnMainID(e.ID)
			}
		})
	}
	return e, true
}

var presenceBusy sync.Mutex

// oneAtATime: a look at the main PC off the listener, never two at once (a message comes every 5 s).
func oneAtATime(fn func()) {
	if !presenceBusy.TryLock() {
		return
	}
	go func() { defer presenceBusy.Unlock(); fn() }()
}

func nameOr(e presenceEntry) string {
	if e.Name != "" {
		return e.Name
	}
	return "a PC"
}

// presenceOf: where that PC is now (heard lately), or false.
func presenceOf(id string) (presenceEntry, bool) {
	presenceMu.Lock()
	defer presenceMu.Unlock()
	e, ok := presenceMap[id]
	return e, ok && id != "" && time.Since(e.At) <= presenceFresh
}

// presenceFailed: that address did not answer — not used until the PC says it again.
func presenceFailed(id string) {
	presenceMu.Lock()
	defer presenceMu.Unlock()
	if e, ok := presenceMap[id]; ok {
		e.At = time.Time{}
		presenceMap[id] = e
	}
}

// mainFromPresence: the main PC's address now, by its id ("" when not heard lately).
func mainFromPresence() string {
	if e, ok := presenceOf(loadIdentity().PCID); ok {
		return e.url()
	}
	return ""
}

// learnMainID: the main PC's permanent id, kept in main-pc.json.
func learnMainID(id string) {
	if !presenceIDRe.MatchString(id) {
		return
	}
	mid := loadIdentity()
	if mid.PCID == id {
		return
	}
	if mid.PCID == "" {
		log.Printf("🪪 Main PC's permanent id remembered: %s", id)
	} else {
		log.Printf("🪪 Main PC's id is now %s (was %s)", id, mid.PCID)
	}
	mid.PCID = id
	saveIdentity(mid)
}

// switchToMainAt: the main PC says it is at u now — used at once (it answers as ours).
func switchToMainAt(u string) {
	if standbyActing() || signedOut() || isActingURL(u) {
		return
	}
	if pinned := pinnedHostURL(); pinned != "" && !strings.HasPrefix(readConfHeader(), autoConfHeader) && answersAt(pinned) {
		return // an address typed on this PC that answers: kept
	}
	if cur := strings.TrimRight(hostServer, "/"); cur != "" && cur != u && answersAt(cur) && confirmedOurs(cur) {
		return // still answers where it was (a second network card): left as it is
	}
	if !answersAt(u) || !acceptServer(u) {
		return
	}
	log.Printf("👉 Main PC is at %s now (found by its id, not its old address)", u)
	hostServer = u
	os.Setenv("ADAL_HOST_URL", u)
	rememberHostURL(u)
	pingServer()
}

// randomMACs: this PC's office-network cards whose hardware address is random
// (locally administered: Windows "Random hardware addresses" is on).
func randomMACs(ifs []net.Interface, addrsOf func(net.Interface) []net.Addr) []string {
	var out []string
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || len(ifc.HardwareAddr) != 6 || ifc.HardwareAddr[0]&2 == 0 {
			continue
		}
		for _, a := range addrsOf(ifc) {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && lanUsable(n.IP) {
				out = append(out, ifc.Name+" "+ifc.HardwareAddr.String())
				break
			}
		}
	}
	return out
}

func randomMACsHere() []string {
	ifs, _ := net.Interfaces()
	return randomMACs(ifs, func(i net.Interface) []net.Addr { a, _ := i.Addrs(); return a })
}

func presenceTargets() []*net.UDPAddr {
	var out []*net.UDPAddr
	for _, t := range broadcastTargets() {
		out = append(out, &net.UDPAddr{IP: t.IP, Port: presencePort})
	}
	for _, s := range strings.Split(os.Getenv("ADAL_PRESENCE_TO"), ",") {
		if a, err := net.ResolveUDPAddr("udp4", strings.TrimSpace(s)); err == nil && strings.TrimSpace(s) != "" {
			out = append(out, a)
		}
	}
	return out
}

// startPresence: this PC's id made (once), said every 5 s, and the others heard.
func startPresence(root string) {
	myPCID = ensurePCID(root)
	if myPCID == "" || os.Getenv("ADAL_PRESENCE") == "0" {
		return
	}
	rnd := randomMACsHere()
	if len(rnd) > 0 {
		log.Printf("⚠️ %s: random hardware addresses are ON here — this PC's network card may change (the other PCs find it by its id, not its card)", strings.Join(rnd, ", "))
	}
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		return c.Control(func(fd uintptr) { _ = setSockoptReuse(fd); _ = setSockoptBroadcast(fd) })
	}}
	pc, err := lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf(":%d", presencePort))
	if err != nil {
		log.Printf("⚠️ This PC cannot hear the office's PCs on UDP %d: %v", presencePort, err)
		return
	}
	conn := pc.(*net.UDPConn)
	go func() {
		buf := make([]byte, 1024)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				time.Sleep(time.Second)
				continue
			}
			if strings.HasPrefix(string(buf[:n]), presenceMagic) {
				presenceHeard(string(buf[:n]), from.IP.String())
			}
		}
	}()
	go func() {
		for {
			if tag := ownAgencyTag(); tag != "" {
				msg := []byte(presenceMessage(tag, myPCID, lanHTTPPort, "companion", clientName, len(rnd) > 0))
				for _, t := range presenceTargets() {
					_, _ = conn.WriteToUDP(msg, t)
				}
			}
			time.Sleep(presenceEvery)
		}
	}()
}
