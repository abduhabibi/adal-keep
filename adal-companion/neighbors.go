package main

// neighbors.go — this PC's neighbour table (ARP): which network card has which
// address on the office network right now. Windows reads it from the system
// (neighbors_windows.go, no program is started); Linux from /proc/net/arp.

import "strings"

// parseProcArp reads Linux's /proc/net/arp:
//
//	IP address       HW type     Flags       HW address            Mask     Device
//	192.168.1.5      0x1         0x2         aa:bb:cc:dd:ee:ff     *        wlan0
func parseProcArp(text string) map[string]string {
	out := map[string]string{}
	for i, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 4 {
			continue
		}
		if f[2] == "0x0" { // incomplete
			continue
		}
		if m := normMAC(f[3]); m != "" {
			out[f[0]] = m
		}
	}
	return out
}

// parseArpA reads the text of "arp -a" (Windows and others), for tests and
// as a fallback:
//
//	192.168.1.5           aa-bb-cc-dd-ee-ff     dynamic
//	? (192.168.1.5) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
func parseArpA(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(strings.ReplaceAll(strings.ReplaceAll(line, "(", " "), ")", " "))
		ip, mac := "", ""
		for _, w := range f {
			if ip == "" && strings.Count(w, ".") == 3 && strings.Trim(w, "0123456789.") == "" {
				ip = w
			} else if mac == "" {
				mac = normMAC(w)
			}
		}
		if ip != "" && mac != "" {
			out[ip] = mac
		}
	}
	return out
}
