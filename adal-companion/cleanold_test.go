package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOldProgramNames(t *testing.T) {
	for n, want := range map[string]bool{"adal-companion.exe.old": true, "AdalKeep.exe.old-1700": true, "ADAL.EXE.OLD": true, "adal-companion.exe": false, "companion.log.old": false} {
		if isOldProgram(n) != want {
			t.Errorf("%s: want %v", n, want)
		}
	}
	if got := originalPath(`C:\Adal\adal-companion.exe.old-17`); got != `C:\Adal\adal-companion.exe` {
		t.Errorf("originalPath = %s", got)
	}
	if got := originalPath("/x/adal-companion.exe"); got != "/x/adal-companion.exe" {
		t.Errorf("a current program stays: %s", got)
	}
}

func TestCleanOldDeletes(t *testing.T) {
	d := t.TempDir()
	for _, f := range []string{"adal-companion.exe", "adal-companion.exe.old", "AdalKeep.exe.old-5", "companion.log.old"} {
		os.WriteFile(filepath.Join(d, f), []byte("x"), 0o644)
	}
	if n := cleanOldPrograms(d); n != 2 {
		t.Fatalf("deleted %d, want 2", n)
	}
	for _, f := range []string{"adal-companion.exe", "companion.log.old"} {
		if _, err := os.Stat(filepath.Join(d, f)); err != nil {
			t.Errorf("%s must stay", f)
		}
	}
}
