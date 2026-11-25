package main

// office.go — what the office health page shows about this PC (asked on
// 2026-11-22): its version, its Wi-Fi signal and whether it reaches the other
// PCs of the office. Said with every robot announcement (robot.go); the main PC
// answers with the other Companions' addresses, this PC tries each one and
// says how many answered next time. The main PC adds who is signed in here
// (the page says it) and how old this PC's copy is (replica.go reports it).

import (
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type officePeer struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

var (
	officeMu    sync.Mutex
	officePeers []officePeer
)

// rememberPeers: the main PC's answer to the announcement.
func rememberPeers(p []officePeer) {
	officeMu.Lock()
	officePeers = p
	officeMu.Unlock()
}

var winSignal = regexp.MustCompile(`(?mi)^\s*Signal\s*:\s*(\d+)\s*%`)

// parseWifi: 0–100 from `netsh wlan show interfaces` (Windows) or
// /proc/net/wireless (Linux); -1 on a cable.
func parseWifi(goos, text string) int {
	if goos == "windows" {
		if m := winSignal.FindStringSubmatch(text); m != nil {
			n, _ := strconv.Atoi(m[1])
			return n
		}
		return -1
	}
	for _, l := range strings.Split(text, "\n") {
		f := strings.Fields(l)
		if len(f) >= 3 && strings.HasSuffix(f[0], ":") {
			q, err := strconv.ParseFloat(strings.TrimSuffix(f[2], "."), 64)
			if err != nil {
				return -1
			}
			n := int(q*100/70 + 0.5)
			if n > 100 {
				n = 100
			}
			return n
		}
	}
	return -1
}

// wifiSeen: asked every 5 minutes, not with every announcement (netsh is a program started each
// time). Off: ADAL_WIFI_EVERY=0.
var (
	wifiMu  sync.Mutex
	wifiAt  time.Time
	wifiVal int
)

func wifiSeen(now time.Time, ask func() int) int {
	wifiMu.Lock()
	defer wifiMu.Unlock()
	if os.Getenv("ADAL_WIFI_EVERY") == "0" || wifiAt.IsZero() || now.Sub(wifiAt) >= 5*time.Minute {
		wifiVal, wifiAt = ask(), now
	}
	return wifiVal
}

func wifiNow() int {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("netsh", "wlan", "show", "interfaces")
		hideWindow(cmd)
		out, err := cmd.Output()
		if err != nil {
			return -1
		}
		return parseWifi("windows", string(out))
	case "linux":
		out, err := exec.Command("cat", "/proc/net/wireless").Output()
		if err != nil {
			return -1
		}
		return parseWifi("linux", string(out))
	}
	return -1
}

// reachPeers: tries each Companion the main PC named; the ones that did not answer by name.
func reachPeers(peers []officePeer, dial func(addr string) bool) (ok int, down []string) {
	for _, p := range peers {
		if dial(net.JoinHostPort(p.IP, strconv.Itoa(p.Port))) {
			ok++
		} else {
			down = append(down, p.Name)
		}
	}
	return
}

func dialQuick(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 1500*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// officeNow: the fields added to the robot announcement.
// updatingNow: an update is being installed here (selfupdate.go install).
var updatingNow atomic.Bool

func officeNow() map[string]any {
	out := map[string]any{}
	if v := ownVersion(); v != "" {
		out["version"] = v
	}
	// Installing an update (and restarting for it): no robot run comes here meanwhile.
	if updatingNow.Load() {
		out["updating"] = true
	}
	if w := wifiSeen(time.Now(), wifiNow); w >= 0 {
		out["wifi"] = w
	}
	officeMu.Lock()
	peers := append([]officePeer(nil), officePeers...)
	officeMu.Unlock()
	if len(peers) > 0 {
		ok, down := reachPeers(peers, dialQuick)
		out["peers_total"], out["peers_ok"], out["peers_down"] = len(peers), ok, down
	}
	return out
}

// ownVersion: the short name of the release this Companion runs.
func ownVersion() string {
	u := newUpdater(exeRoot())
	if m := u.baseline(); m != nil {
		if m.Short != "" {
			return m.Short
		}
		if len(m.SHA) >= 7 {
			return m.SHA[:7]
		}
	}
	return ""
}
