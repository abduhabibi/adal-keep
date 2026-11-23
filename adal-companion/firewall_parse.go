package main

import (
	"path/filepath"
	"strings"
)

// firewallState: from netsh's rule list, an enabled allow rule for this program (or port
// 47810), and an enabled block rule for this program.
func firewallState(text, exe string) (allow, block bool) {
	me := strings.ToLower(filepath.Clean(exe))
	for _, blockText := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		f := map[string]string{}
		for _, line := range strings.Split(blockText, "\n") {
			if k, v, ok := strings.Cut(line, ":"); ok {
				f[strings.ToLower(strings.TrimSpace(k))] = strings.ToLower(strings.TrimSpace(v))
			}
		}
		if f["enabled"] != "yes" {
			continue
		}
		mine := f["program"] == me
		port := strings.Contains(","+strings.ReplaceAll(f["localport"], " ", "")+",", ",47810,")
		if !mine && !port {
			continue
		}
		switch f["action"] {
		case "block":
			if mine {
				block = true
			}
		case "allow":
			allow = true
		}
	}
	return
}
