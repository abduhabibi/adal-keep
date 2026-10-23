package main

import "testing"

func TestScanFindsServer(t *testing.T) {
	scanTargetsFn = func() []string { return []string{"127.0.0.2", "127.0.0.1", "127.0.0.3"} }
	defer func() { scanTargetsFn = scanTargets }()
	info := scanForServer(4000)
	if info == nil || info.Name == "" {
		t.Fatalf("not found: %+v", info)
	}
	t.Logf("found %+v; real targets here: %d", info, len(scanTargets()))
}
