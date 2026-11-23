package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func withOwnNet(t *testing.T, cidr string) {
	_, n, _ := net.ParseCIDR(cidr)
	old := ownNets
	ownNets = func() []*net.IPNet { return []*net.IPNet{n} }
	t.Cleanup(func() { ownNets = old })
}

// Tailscale, link-local and loopback are never used; this PC's own network comes first.
func TestLanOrderNeverTailscaleOwnNetFirst(t *testing.T) {
	withOwnNet(t, "192.168.1.3/24")
	got := lanOrder([]string{"100.89.50.99", "10.86.25.95", "169.254.3.4", "127.0.0.1", "192.168.1.12", "192.168.1.12"})
	if strings.Join(got, ",") != "192.168.1.12,10.86.25.95" {
		t.Fatalf("got %v", got)
	}
	// A discovery reply from Main that also lists its Tailscale and hotspot addresses.
	parts := []string{"ADAL_KEEP_SERVER_V1", "4000", "100.89.50.99", "Main", "10.86.25.95,192.168.1.12,100.89.50.99"}
	if c := replyCandidates(net.ParseIP("192.168.1.12"), parts); strings.Join(c, ",") != "192.168.1.12,10.86.25.95" {
		t.Fatalf("candidates %v", c)
	}
}

// Nothing answered: an address off this PC's network is not taken as the main PC's.
func TestPickReachableNoDeadOffNetAddress(t *testing.T) {
	withOwnNet(t, "192.168.1.3/24")
	if got := pickReachable([]string{"10.86.25.95"}, 1); got != "" {
		t.Fatalf("took %q", got)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }))
	defer srv.Close()
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	p := 0
	for _, c := range port {
		p = p*10 + int(c-'0')
	}
	if got := pickReachable([]string{host}, p); got != host {
		t.Fatalf("answering one: %q", got)
	}
}

func TestFirewallState(t *testing.T) {
	exe := `C:\AdalKeepCompanion\adal-companion.exe`
	rules := "Rule Name:                            Adal Keep Companion\r\n----------------------------------------------------------------------\r\nEnabled:                              Yes\r\nDirection:                            In\r\nProfiles:                             Domain,Private,Public\r\nLocalPort:                            Any\r\nProgram:                              C:\\AdalKeepCompanion\\adal-companion.exe\r\nAction:                               Allow\r\n\r\n"
	if a, b := firewallState(rules, exe); !a || b {
		t.Fatalf("allow=%v block=%v", a, b)
	}
	blocked := rules + strings.Replace(strings.Replace(rules, "Allow", "Block", 1), "Adal Keep Companion", "adal-companion.exe", 1)
	if _, b := firewallState(blocked, exe); !b {
		t.Fatal("block rule not seen")
	}
	if a, _ := firewallState("Rule Name: Other\r\nEnabled: Yes\r\nLocalPort: 80\r\nAction: Allow\r\n", exe); a {
		t.Fatal("another rule counted")
	}
}
