package main

// discovery.go — find the Adal Keep server on the LAN.
//
// The Server PC broadcasts nothing; it only *answers*. An Employee PC sends
// the request below to every interface's broadcast address and the server
// replies with its HTTP port, its LAN IP and the company name, so the tray
// app never needs a hard-coded 192.168.x.x address that DHCP will change.
//
// Protocol — keep in sync with backend `src/services/discovery.js`:
//
//	request  (UDP broadcast :45454)  ADAL_KEEP_DISCOVER_V1
//	response (UDP unicast)           ADAL_KEEP_SERVER_V1|<http port>|<lan ip>|<company>|<ip>,<ip>,...|<mac>,<mac>,...
//
// With the main PC's number known (mainid.go), only the main PC that says the
// number is its own is taken; one with the network card it had is asked first.
//
// The address used is the first that answers on the HTTP port: the reply
// packet's own source address first (it came from there, so it is on this
// network), then each advertised one. On 2026-11-18 a main PC advertised its
// Tailscale IP and the Companions on its Wi-Fi could not reach it.

import (
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	discoveryPort     = 45454
	discoveryRequest  = "ADAL_KEEP_DISCOVER_V1"
	discoveryResponse = "ADAL_KEEP_SERVER_V1"
)

// serverInfo is a parsed answer from the Server PC.
type serverInfo struct {
	URL  string
	IP   string
	Port int
	Name string
	Macs []string
}

// broadcastTargets returns 255.255.255.255 plus the directed broadcast
// address of every live interface. Windows frequently ignores the global
// broadcast on multi-homed machines, which is why the directed ones matter.
func broadcastTargets() []*net.UDPAddr {
	out := []*net.UDPAddr{{IP: net.IPv4bcast, Port: discoveryPort}}

	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			mask := ipnet.Mask
			if ip == nil || len(mask) != 4 {
				continue
			}
			bcast := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				bcast[i] = ip[i] | ^mask[i]
			}
			// Skip the useless 255.255.255.255 duplicate (/0 style masks).
			if bcast.Equal(net.IPv4bcast) {
				continue
			}
			out = append(out, &net.UDPAddr{IP: bcast, Port: discoveryPort})
		}
	}
	return out
}

// discoverServer asks the LAN for an Adal Keep server and returns the first
// valid answer, or nil when nobody replies within the timeout.
func discoverServer(timeout time.Duration) *serverInfo {
	// The network card it had, in this PC's neighbour table: its address now.
	if u := findByMAC(); u != "" {
		log.Printf("🪪 Main PC found by its network card at %s", u)
		return infoFromURL(u)
	}
	if info := askByBroadcast(timeout); info != nil {
		return info
	}
	if os.Getenv("ADAL_NO_DISCOVERY") == "1" {
		return nil
	}
	return scanForServer(4000)
}

// askByBroadcast: the UDP question to the whole network (see the top).
func askByBroadcast(timeout time.Duration) *serverInfo {
	// Tests (and PCs pinned to one server) can switch the LAN search off.
	if os.Getenv("ADAL_NO_DISCOVERY") == "1" {
		return nil
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		log.Printf("⚠️ Discovery socket unavailable: %v", err)
		return nil
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))

	// SO_BROADCAST is required to send to 255.255.255.255 / x.x.x.255.
	// Go has no portable setter, so each OS gets a two-line helper.
	if rc, err := conn.SyscallConn(); err == nil {
		_ = rc.Control(func(fd uintptr) { _ = setSockoptBroadcast(fd) })
	}

	payload := []byte(discoveryRequest)
	targets := broadcastTargets()

	// Send twice: a cheap switch with a cold MAC table drops the first frame.
	for _, t := range targets {
		_, _ = conn.WriteToUDP(payload, t)
	}
	time.Sleep(400 * time.Millisecond)
	for _, t := range targets {
		_, _ = conn.WriteToUDP(payload, t)
	}

	buf := make([]byte, 1024)
	deadline := time.Now().Add(timeout)
	known := loadIdentity().Macs
	var other *serverInfo // a main PC that is not the one with our card (when nothing better answers)

	for time.Now().Before(deadline) {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return other // deadline or socket error — either way we are done
		}
		text := strings.TrimSpace(string(buf[:n]))
		if !strings.HasPrefix(text, discoveryResponse) {
			continue
		}
		parts := strings.Split(text, "|")
		if len(parts) < 3 {
			continue
		}
		port := 4000
		if p, perr := net.LookupPort("tcp", parts[1]); perr == nil && p > 0 {
			port = p
		}
		name := "Adal Keep"
		if len(parts) > 3 && strings.TrimSpace(parts[3]) != "" {
			name = strings.TrimSpace(parts[3])
		}
		ip := pickReachable(replyCandidates(from.IP, parts), port)
		if ip == "" {
			continue
		}
		info := &serverInfo{
			URL:  "http://" + net.JoinHostPort(ip, itoa(port)),
			IP:   ip,
			Port: port,
			Name: name,
			Macs: macsInReply(parts),
		}
		// Not the main PC with our number: never taken.
		if !acceptServer(info.URL) {
			continue
		}
		// The one with the card we know: at once. Another (a new card?): only if nothing better answers.
		if len(known) == 0 || sameCard(known, info.Macs) || len(info.Macs) == 0 {
			return info
		}
		if other == nil {
			other = info
		}
	}
	return other
}

// infoFromURL: a serverInfo for an address that answered.
func infoFromURL(u string) *serverInfo {
	host, port := hostPort(u)
	return &serverInfo{URL: strings.TrimRight(u, "/"), IP: host, Port: port, Name: "Adal Keep"}
}

func hostPort(u string) (string, int) {
	hp := strings.TrimPrefix(strings.TrimPrefix(strings.TrimRight(u, "/"), "http://"), "https://")
	h, p, err := net.SplitHostPort(hp)
	if err != nil {
		return hp, 4000
	}
	n := 0
	for _, c := range p {
		n = n*10 + int(c-'0')
	}
	return h, n
}

// resolveHostURL picks the server address: an explicit ADAL_HOST_URL wins
// (used by IT for a fixed setup), otherwise the LAN is scanned a few times
// so a machine that boots before the server still finds it.
func resolveHostURL() string {
	if v := strings.TrimSpace(os.Getenv("ADAL_HOST_URL")); v != "" {
		url := strings.TrimRight(v, "/")
		log.Printf("🌐 Server from ADAL_HOST_URL: %s", url)
		return url
	}

	// companion.conf next to the exe lets IT pin a server without env vars.
	if url := pinnedHostURL(); url != "" && refusedServer(url) {
		// The address typed or saved here now belongs to another agency's PC.
		log.Printf("🚫 %s is another main PC (not ours) — searching for ours instead", url)
	} else if url != "" && answersAt(url) {
		log.Printf("🌐 Server from companion.conf: %s", url)
		os.Setenv("ADAL_HOST_URL", url)
		return url
	} else if url != "" {
		// Saved, but nobody answers there now (the router gave the main PC a new address):
		// looked for by its network card and on the network first — never stuck on an old address.
		log.Printf("🌐 %s (companion.conf) does not answer — looking for the main PC", url)
		if info := discoverServer(2500 * time.Millisecond); info != nil && info.URL != url {
			log.Printf("✅ Found it at %s", info.URL)
			os.Setenv("ADAL_HOST_URL", info.URL)
			if !strings.HasPrefix(readConfHeader(), autoConfHeader) {
				forgetTypedHostURL()
			}
			rememberHostURL(info.URL)
			return info.URL
		}
		os.Setenv("ADAL_HOST_URL", url)
		return url
	}
	// Logged out of its main PC: no search until another one is chosen.
	if signedOut() {
		log.Printf("👋 Logged out of the main PC — waiting for another one to be chosen in Adal Keep's window")
		return ""
	}

	for attempt := 1; attempt <= 3; attempt++ {
		log.Printf("🔍 Searching the LAN for the Adal Keep server (%d/3)...", attempt)
		if info := discoverServer(2500 * time.Millisecond); info != nil {
			log.Printf("✅ Found \"%s\" at %s", info.Name, info.URL)
			// Remember it so a re-discover is only needed on failure.
			os.Setenv("ADAL_HOST_URL", info.URL)
			rememberHostURL(info.URL)
			return info.URL
		}
		if attempt < 3 {
			time.Sleep(3 * time.Second)
		}
	}

	log.Printf("⚠️ No Adal Keep server answered — falling back to http://127.0.0.1:4000")
	log.Printf("   (Create companion.conf next to the exe with")
	log.Printf("    ADAL_HOST_URL=http://<server-ip>:4000 to skip discovery.)")
	return "http://127.0.0.1:4000"
}

// pinnedHostURL reads companion.conf next to the executable. The format is one
// "ADAL_HOST_URL=http://ip:port" line; '#' starts a comment.
func pinnedHostURL() string {
	path, err := companionConfPath()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(key) == "ADAL_HOST_URL" {
			return strings.TrimRight(strings.TrimSpace(value), "/")
		}
	}
	return ""
}

const autoConfHeader = "# Written by the Adal Keep Companion."

// rememberHostURL writes the discovered server into companion.conf so the next
// boot skips discovery (and AdalKeep.exe knows where to open). A file the
// Companion wrote itself is updated when the main PC moves (new address from
// the router); a file someone wrote by hand is never overwritten.
func rememberHostURL(url string) {
	if isActingURL(url) { // this PC standing in for the main PC: never saved as the main PC
		return
	}
	path, err := companionConfPath()
	if err != nil || signedOut() {
		return
	}
	if old, err := os.ReadFile(path); err == nil {
		if !strings.HasPrefix(string(old), autoConfHeader) || pinnedHostURL() == url {
			return
		}
	}
	body := autoConfHeader + " Edit ADAL_HOST_URL or delete\n" +
		"# this file to let the Companion search the LAN again.\n" +
		"ADAL_HOST_URL=" + url + "\n"
	// The main PC's number (its identity) stays with it.
	if n := confNumber(); n != "" {
		body += "ADAL_PC_NUMBER=" + n + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		log.Printf("   (could not save %s: %v)", path, err)
	}
}

// signedOut: Adal Keep's window logged this PC out of its main PC
// ("Connect to another PC", adal-launcher/leave.go) and no other main PC is
// chosen yet. Nothing is sent and the old main PC is not looked for.
func signedOut() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(filepath.Dir(exe), "companion.signed-out"))
	return err == nil
}

func companionConfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(exe), "companion.conf"), nil
}

// readConfHeader: the first line of companion.conf ("" when there is none).
func readConfHeader() string {
	path, err := companionConfPath()
	if err != nil {
		return ""
	}
	b, _ := os.ReadFile(path)
	return strings.SplitN(string(b), "\n", 2)[0]
}

// replyCandidates: the reply's source address, then every advertised address
// (field 3, then the list in field 5), each once; never 0.0.0.0 or loopback.
func replyCandidates(from net.IP, parts []string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		ip := net.ParseIP(strings.TrimSpace(s)).To4()
		if ip == nil || !lanUsable(ip) || seen[ip.String()] {
			return
		}
		seen[ip.String()] = true
		out = append(out, ip.String())
	}

	if from != nil {
		add(from.String())
	}
	if len(parts) > 2 {
		add(parts[2])
	}
	if len(parts) > 4 {
		for _, s := range strings.Split(parts[4], ",") {
			add(s)
		}
	}
	// The packet's own sender first when it is on this PC's network, then the others on it.
	return lanOrder(out)
}

// pickReachable: the first candidate where Adal Keep answers on port; when
// none answers (the server is still starting), the first candidate.
func pickReachable(cands []string, port int) string {
	if len(cands) == 0 {
		return ""
	}
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	for _, ip := range cands {
		resp, err := c.Get("http://" + net.JoinHostPort(ip, itoa(port)) + "/api/companion/info")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return ip
			}
		}
	}
	// Nothing answered: the first one only when it is on this PC's own network.
	if onOwnNet(net.ParseIP(cands[0])) {
		return cands[0]
	}
	return ""
}

// itoa avoids pulling strconv in for a single call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// keepFindingServer: while the main PC does not answer (turned off, moved to
// a new address), look for it again every 15 seconds and remember where it is.
// Another main PC chosen in Adal Keep's window (companion.conf), or a log out
// of this one, is taken within 5 seconds.
func keepFindingServer() {
	for tick := 1; ; tick++ {
		time.Sleep(5 * time.Second)
		if standbyActing() { // this PC is the office's Adal Keep now (standby.go)
			continue
		}
		pinned := pinnedHostURL()
		if signedOut() && pinned == "" {
			if hostServer != "" {
				log.Printf("👋 Logged out of the main PC %s — nothing is sent until another one is chosen", hostServer)
				hostServer = ""
				os.Setenv("ADAL_HOST_URL", "")
			}
			continue
		}
		if pinned != "" && pinned != strings.TrimRight(hostServer, "/") && (hostServer == "" || !strings.HasPrefix(readConfHeader(), autoConfHeader)) {
			// An address saved here that does not answer is never taken (2026-11-23: a
			// Companion kept the main PC's old address 192.168.1.4 after it moved to .12).
			if !answersAt(pinned) {
				goto search
			}
			if refusedServer(pinned) {
				continue // another agency's PC at that address: never taken
			}
			log.Printf("👉 Main PC chosen: %s", pinned)
			hostServer = pinned
			os.Setenv("ADAL_HOST_URL", pinned)
			pingServer()
			continue
		}
	search:
		// Not answering: looked for again every 15 s (its network card first, then the broadcast).
		if tick%3 != 0 || pingServer() {
			continue
		}
		// An address typed on this PC (the "cannot find the main PC" page).
		if pinned := pinnedHostURL(); pinned != "" && pinned != strings.TrimRight(hostServer, "/") && !refusedServer(pinned) && answersAt(pinned) {
			log.Printf("👉 Using the saved address %s", pinned)
			hostServer = pinned
			os.Setenv("ADAL_HOST_URL", pinned)
			if pingServer() {
				continue
			}
		}
		if info := discoverServer(2500 * time.Millisecond); info != nil {
			log.Printf("👉 Server found at %s", info.URL)
			hostServer = info.URL
			os.Setenv("ADAL_HOST_URL", info.URL)
			// A typed address that stopped answering is replaced too (with the number kept).
			if p := pinnedHostURL(); p != "" && p != info.URL && !strings.HasPrefix(readConfHeader(), autoConfHeader) && !answersAt(p) {
				forgetTypedHostURL()
			}
			rememberHostURL(info.URL)
		}
	}
}

// answersAt: an Adal Keep server answers at u now.
func answersAt(u string) bool {
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Get(strings.TrimRight(u, "/") + "/api/companion/info")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// forgetTypedHostURL: a typed companion.conf becomes one the Companion may
// update (its number stays), so the address found now is written in its place.
func forgetTypedHostURL() {
	path, err := companionConfPath()
	if err != nil {
		return
	}
	body := autoConfHeader + " Edit ADAL_HOST_URL or delete\n# this file to let the Companion search the LAN again.\n"
	if n := confNumber(); n != "" {
		body += "ADAL_PC_NUMBER=" + n + "\n"
	}
	os.WriteFile(path, []byte(body), 0o644)
}
