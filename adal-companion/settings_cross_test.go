package main

import (
	"os"
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
