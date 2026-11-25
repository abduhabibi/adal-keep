package main

import (
	"testing"
	"time"
)

func TestParseWifi(t *testing.T) {
	if n := parseWifi("windows", "    Name : Wi-Fi\n    Signal                 : 83%\n"); n != 83 {
		t.Fatalf("netsh: %d", n)
	}
	if n := parseWifi("windows", "no wireless"); n != -1 {
		t.Fatalf("cable: %d", n)
	}
	if n := parseWifi("linux", "Inter-| sta\n face | tus\n wlan0: 0000   35.  -60.  -256   0\n"); n != 50 {
		t.Fatalf("proc: %d", n)
	}
}

func TestReachPeers(t *testing.T) {
	peers := []officePeer{{"A", "10.0.0.1", 1}, {"B", "10.0.0.2", 1}, {"C", "10.0.0.3", 1}}
	ok, down := reachPeers(peers, func(addr string) bool { return addr != "10.0.0.2:1" })
	if ok != 2 || len(down) != 1 || down[0] != "B" {
		t.Fatalf("%d %v", ok, down)
	}
}

func TestWifiAskedEveryFiveMinutes(t *testing.T) {
	wifiAt = time.Time{}
	n, now := 0, time.Now()
	ask := func() int { n++; return 70 + n }
	for i := 0; i < 15; i++ { // 20 s apart: 5 minutes
		wifiSeen(now.Add(time.Duration(i)*20*time.Second), ask)
	}
	if n != 1 {
		t.Fatalf("asked %d times in 5 minutes", n)
	}
	if v := wifiSeen(now.Add(5*time.Minute), ask); v != 72 {
		t.Fatalf("not asked again: %d", v)
	}
}
