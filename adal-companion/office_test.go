package main

import "testing"

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
