//go:build !windows

package main

import "os"

// neighbourTable: Linux's ARP table (elsewhere: empty, discovery still works).
func neighbourTable() map[string]string {
	b, err := os.ReadFile("/proc/net/arp")
	if err != nil {
		return map[string]string{}
	}
	return parseProcArp(string(b))
}
