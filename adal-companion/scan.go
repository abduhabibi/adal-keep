package main

// scan.go — the second way to find the main PC.
//
// Many Wi-Fi routers drop broadcasts between wireless PCs, so the UDP
// question in discovery.go never reaches the main PC even on the same
// Wi-Fi. Then every address of this PC's own network (x.x.x.1–254) is asked
// directly for http://<ip>:4000/api/companion/info — a normal web request,
// which those routers let through. About 3 seconds for a whole network.

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// scanTargetsFn: replaced in tests.
var scanTargetsFn = scanTargets

// scanTargets: every other address in the /24 of each live IPv4 interface.
// Larger networks are scanned only around this PC's own /24.
func scanTargets() []string {
	var out []string
	seen := map[string]bool{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || ip[0] == 169 && ip[1] == 254 || ip[0] == 127 {
				continue
			}
			// Tailscale (100.64.0.0/10) is far too big to scan: typed there.
			if ip[0] == 100 && ip[1]&0xC0 == 64 {
				continue
			}
			for h := 1; h < 255; h++ {
				t := net.IPv4(ip[0], ip[1], ip[2], byte(h)).String()
				if byte(h) == ip[3] || seen[t] {
					continue
				}
				seen[t] = true
				out = append(out, t)
			}
		}
	}
	return out
}

// scanForServer asks every neighbour on port 4000; the first Adal Keep wins.
func scanForServer(port int) *serverInfo {
	targets := scanTargetsFn()
	if len(targets) == 0 {
		return nil
	}
	log.Printf("🔍 No answer to the broadcast — asking %d addresses directly...", len(targets))
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	var (
		found *serverInfo
		once  sync.Once
		wg    sync.WaitGroup
	)
	jobs := make(chan string)
	done := make(chan struct{})
	for w := 0; w < 64; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				addr := net.JoinHostPort(ip, itoa(port))
				// A quick TCP knock first: most addresses are empty.
				c, err := net.DialTimeout("tcp", addr, 700*time.Millisecond)
				if err != nil {
					continue
				}
				c.Close()
				resp, err := client.Get("http://" + addr + "/api/companion/info")
				if err != nil {
					continue
				}
				var info struct {
					Service string `json:"service"`
					Name    string `json:"name"`
				}
				_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK || info.Service != "adal-keep" {
					continue
				}
				once.Do(func() {
					name := info.Name
					if name == "" {
						name = "Adal Keep"
					}
					found = &serverInfo{URL: "http://" + addr, IP: ip, Port: port, Name: name}
					close(done)
				})
			}
		}()
	}
feed:
	for _, t := range targets {
		select {
		case jobs <- t:
		case <-done:
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	return found
}
