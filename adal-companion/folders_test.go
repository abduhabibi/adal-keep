package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMissedFiles(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.pdf")
	os.WriteFile(old, []byte("x"), 0o644)
	long := time.Now().Add(-time.Hour)
	os.Chtimes(old, long, long)
	fresh := filepath.Join(dir, "fresh.pdf")
	sent := filepath.Join(dir, "sent.pdf")
	os.WriteFile(fresh, []byte("x"), 0o644)
	os.WriteFile(sent, []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "part.crdownload"), []byte("x"), 0o644)

	since := time.Now().Add(-time.Minute)
	got := missedFiles([]string{dir}, since, map[string]time.Time{sent: time.Now()})
	// arrivedAt may date old.pdf by its change time on some systems; the
	// handled file and the unfinished download must never come back.
	foundFresh := false
	for _, p := range got {
		if p == sent || filepath.Ext(p) == ".crdownload" {
			t.Fatalf("should be skipped: %s", p)
		}
		if p == fresh {
			foundFresh = true
		}
	}
	if !foundFresh {
		t.Fatalf("fresh file not found: %v", got)
	}
}

func TestCandidateFoldersHasDownloadsOnce(t *testing.T) {
	seen := map[string]int{}
	for _, d := range candidateFolders() {
		seen[d]++
		if seen[d] > 1 {
			t.Fatalf("listed twice: %s", d)
		}
	}
	home, _ := os.UserHomeDir()
	if seen[filepath.Join(home, "Downloads")] != 1 {
		t.Fatalf("Downloads missing: %v", seen)
	}
}
