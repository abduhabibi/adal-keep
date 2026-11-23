package main

// lanaddr.go — which addresses another PC of the office can use (2026-11-23: a
// Companion timed out copying from Main's Tailscale address 100.89.x, and kept
// an old hotspot address 10.86.x). Never Tailscale / carrier NAT (100.64.0.0/10),
// link-local (169.254), loopback or unspecified; the ones on this PC's own
// network (the same subnet as one of its cards) first.

import (
	"net"
	"sort"
)

var cgnatNet = &net.IPNet{IP: net.IPv4(100, 64, 0, 0).To4(), Mask: net.CIDRMask(10, 32)}

// lanUsable: an address of another PC that the office network can reach.
func lanUsable(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil || v4.IsUnspecified() || v4.IsLoopback() || v4.IsLinkLocalUnicast() || v4.IsMulticast() {
		return false
	}
	return !cgnatNet.Contains(v4)
}

// neverLAN: Tailscale / carrier NAT or link-local — no PC of the office is reached there.
func neverLAN(ip net.IP) bool {
	v4 := ip.To4()
	return v4 == nil || v4.IsLinkLocalUnicast() || cgnatNet.Contains(v4)
}

// ownNets: this PC's own office networks (Tailscale and link-local left out). Replaced in tests.
var ownNets = func() []*net.IPNet {
	var out []*net.IPNet
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && lanUsable(n.IP) {
			out = append(out, n)
		}
	}
	return out
}

func onOwnNet(ip net.IP) bool {
	for _, n := range ownNets() {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// lanOrder: the usable ones of these addresses, those on this PC's network first (order kept otherwise).
func lanOrder(ips []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip == nil || !lanUsable(ip) || seen[ip.String()] {
			continue
		}
		seen[ip.String()] = true
		out = append(out, ip.String())
	}
	sort.SliceStable(out, func(i, j int) bool { return onOwnNet(net.ParseIP(out[i])) && !onOwnNet(net.ParseIP(out[j])) })
	return out
}
