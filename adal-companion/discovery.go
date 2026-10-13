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
//	response (UDP unicast)           ADAL_KEEP_SERVER_V1|<http port>|<lan ip>|<company>

import (
	"log"
	"net"
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

	for time.Now().Before(deadline) {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return nil // deadline or socket error — either way we are done
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
		ip := strings.TrimSpace(parts[2])
		if ip == "" {
			ip = from.IP.String()
		}
		name := "Adal Keep"
		if len(parts) > 3 && strings.TrimSpace(parts[3]) != "" {
			name = strings.TrimSpace(parts[3])
		}
		return &serverInfo{
			URL:  "http://" + net.JoinHostPort(ip, itoa(port)),
			IP:   ip,
			Port: port,
			Name: name,
		}
	}
	return nil
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
	if url := pinnedHostURL(); url != "" {
		log.Printf("🌐 Server from companion.conf: %s", url)
		os.Setenv("ADAL_HOST_URL", url)
		return url
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

// rememberHostURL writes the discovered server into companion.conf so the next
// boot skips discovery. An existing file (an IT pin) is never overwritten, and
// a read-only install folder simply keeps re-discovering.
func rememberHostURL(url string) {
	path, err := companionConfPath()
	if err != nil {
		return
	}
	if _, err := os.Stat(path); err == nil {
		return
	}
	body := "# Written by the Adal Keep Companion. Edit ADAL_HOST_URL or delete\n" +
		"# this file to let the Companion search the LAN again.\n" +
		"ADAL_HOST_URL=" + url + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		log.Printf("   (could not save %s: %v)", path, err)
	}
}

func companionConfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(exe), "companion.conf"), nil
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
