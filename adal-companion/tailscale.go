package main

// tailscale.go — the main PC over Tailscale when the office network has no
// answer (asked on 2026-11-20). The office network stays first (it is the
// fastest); only when the broadcast, the network card and the scan found
// nothing, this PC's own Tailscale lists the agency's other PCs and each is
// asked on :4000 — the one that says our PC number is its own is taken (the
// same check as on the office network, so another agency's PC never is).
// A Companion that went home, or a main PC on another Wi-Fi, keeps working.

import (
	"encoding/json"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// tailscaleCLI: the tailscale program, or "" when Tailscale is not installed.
func tailscaleCLI() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	if runtime.GOOS == "windows" {
		for _, dir := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if dir == "" {
				continue
			}
			p := filepath.Join(dir, "Tailscale", "tailscale.exe")
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

// tailscalePeers: the IPv4 Tailscale addresses of the other PCs that are online.
func tailscalePeers() []string {
	cli := tailscaleCLI()
	if cli == "" {
		return nil
	}
	cmd := exec.Command(cli, "status", "--json")
	hideWindow(cmd)
	done := make(chan []byte, 1)
	go func() { out, _ := cmd.Output(); done <- out }()
	var out []byte
	select {
	case out = <-done:
	case <-time.After(8 * time.Second):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return nil
	}
	return peersFromStatus(out)
}

// peersFromStatus: the online peers' IPv4 addresses from `tailscale status --json`.
func peersFromStatus(out []byte) []string {
	var st struct {
		Peer map[string]struct {
			TailscaleIPs []string
			Online       bool
		}
	}
	if json.Unmarshal(out, &st) != nil {
		return nil
	}
	var ips []string
	for _, p := range st.Peer {
		if !p.Online {
			continue
		}
		for _, ip := range p.TailscaleIPs {
			if strings.Count(ip, ".") == 3 {
				ips = append(ips, ip)
				break
			}
		}
	}
	return ips
}

// onTailscale: u is a Tailscale address (100.64.0.0/10).
func onTailscale(u string) bool {
	h, _ := hostPort(u)
	ip := net.ParseIP(h).To4()
	return ip != nil && ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127
}

// findOnTailscale: our main PC's Tailscale address ("http://100.x.y.z:4000"), or "".
func findOnTailscale(port int) string {
	ips := tailscalePeers()
	if len(ips) == 0 {
		return ""
	}
	found := make(chan string, len(ips))
	var wg sync.WaitGroup
	for _, ip := range ips {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			u := "http://" + ip + ":" + itoa(port)
			if answersAt(u) && acceptServer(u) {
				found <- u
			}
		}(ip)
	}
	go func() { wg.Wait(); close(found) }()
	if u, ok := <-found; ok {
		log.Printf("🛰️ Main PC found over Tailscale at %s (no answer on the office network)", u)
		return u
	}
	return ""
}
