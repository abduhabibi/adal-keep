package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Settings the main PC locked (ADAL_ENV_LOCKED=<file>) open with the agency's
// key on a Companion, and with no other key.
func TestSettingsFromTheMainPCOpenHere(t *testing.T) {
	f := os.Getenv("ADAL_ENV_LOCKED")
	if f == "" {
		t.Skip("set ADAL_ENV_LOCKED")
	}
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := unlockPiece(b, "wrong key"); err == nil {
		t.Fatal("opened with a wrong key")
	}
	plain, err := unlockPiece(b, "agency-backup-key")
	if err != nil || !strings.Contains(string(plain), "secret-licence-123") {
		t.Fatalf("not opened: %v", err)
	}
}

// A server's settings go to another Companion only locked, and open there.
func TestSettingsLockedForAnotherCompanion(t *testing.T) {
	withTemp(t)
	keys := loadKeys()
	keys.Password = "agency-backup-key"
	saveKeys(keys)
	root := t.TempDir()
	os.MkdirAll(filepath.Join(serverBackend(root)), 0o755)
	os.WriteFile(filepath.Join(serverBackend(root), ".env"), []byte("ADAL_LICENSE_KEY=secret-licence-123\n"), 0o600)
	dir := lockedSettingsDir(root)
	if dir == "" {
		t.Fatal("nothing locked")
	}
	defer os.RemoveAll(dir)
	lb, _ := os.ReadFile(filepath.Join(dir, "backend", ".env.locked"))
	if strings.Contains(string(lb), "secret-licence") {
		t.Fatal("the settings travel readable")
	}
	other := t.TempDir()
	os.MkdirAll(filepath.Join(other, "backend"), 0o755)
	os.WriteFile(filepath.Join(other, "backend", ".env.locked"), lb, 0o600)
	openSettings(other)
	got, err := os.ReadFile(filepath.Join(other, "backend", ".env"))
	if err != nil || !strings.Contains(string(got), "secret-licence-123") {
		t.Fatalf("not opened on the other Companion: %v", err)
	}
}
