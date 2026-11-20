package main

import (
	"net"
	"testing"
	"time"
)

func TestScanFindsServer(t *testing.T) {
	// Needs an Adal Keep answering on this PC (port 4000): not on a Companion-only PC.
	if c, err := net.DialTimeout("tcp", "127.0.0.1:4000", 300*time.Millisecond); err != nil {
		t.Skip("no Adal Keep on 127.0.0.1:4000 here")
	} else {
		c.Close()
	}
	scanTargetsFn = func() []string { return []string{"127.0.0.2", "127.0.0.1", "127.0.0.3"} }
	defer func() { scanTargetsFn = scanTargets }()
	info := scanForServer(4000)
	if info == nil || info.Name == "" {
		t.Fatalf("not found: %+v", info)
	}
	t.Logf("found %+v; real targets here: %d", info, len(scanTargets()))
}
