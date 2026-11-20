package main

import (
	"os"
	"testing"
)

func TestPeersFromStatus(t *testing.T) {
	out := []byte(`{"Peer":{"a":{"TailscaleIPs":["100.89.50.99","fd7a::1"],"Online":true},"b":{"TailscaleIPs":["100.70.1.2"],"Online":false}}}`)
	got := peersFromStatus(out)
	if len(got) != 1 || got[0] != "100.89.50.99" {
		t.Fatalf("online IPv4 peers: got %v", got)
	}
	if peersFromStatus([]byte("not json")) != nil {
		t.Fatal("bad status must give nothing")
	}
}

func TestOnTailscale(t *testing.T) {
	for u, want := range map[string]bool{
		"http://100.89.50.99:4000": true, "http://100.64.0.1:4000": true, "http://100.128.0.1:4000": false,
		"http://192.168.1.6:4000": false, "http://desktop:4000": false,
	} {
		if onTailscale(u) != want {
			t.Errorf("%s: want %v", u, want)
		}
	}
}

// ADAL_LIVE_TS=1 ADAL_PC_NUMBER=<n>: finds the real main PC over this PC's Tailscale (asks only check-number).
func TestLiveFindOnTailscale(t *testing.T) {
	if os.Getenv("ADAL_LIVE_TS") != "1" {
		t.Skip("live only")
	}
	u := findOnTailscale(4000)
	if u == "" {
		t.Fatal("main PC not found over Tailscale")
	}
	t.Logf("found %s", u)
}
