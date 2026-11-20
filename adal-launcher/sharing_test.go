//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSharingRulesOnlyTheOfficeNetwork(t *testing.T) {
	c := sharingCommands()
	for _, want := range []string{"localport=45455,45456", "localport=47810", "remoteip=localsubnet"} {
		if !strings.Contains(c, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Count(c, "remoteip=localsubnet") != 2 {
		t.Fatal("a rule open beyond the office network")
	}
}

func TestSharingAskedOnceAWeek(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	if askedLately(root, now) {
		t.Fatal("never asked yet")
	}
	os.WriteFile(filepath.Join(root, "sharing-asked.json"), []byte(`{"at":"`+now.Add(-2*24*time.Hour).UTC().Format(time.RFC3339)+`"}`), 0o644)
	if !askedLately(root, now) {
		t.Fatal("asked again two days later")
	}
	if askedLately(root, now.Add(6*24*time.Hour)) {
		t.Fatal("never asked again after a week")
	}
}
