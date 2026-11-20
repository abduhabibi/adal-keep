package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The restart line really starts a program once the wait is over (a small
// harmless one: it writes a file), with nothing shown.
func TestRestartLineStartsTheProgram(t *testing.T) {
	dir := t.TempDir()
	mark := filepath.Join(dir, "started.txt")
	bat := filepath.Join(dir, "new companion.bat")
	os.WriteFile(bat, []byte("@echo started> \""+mark+"\"\r\n"), 0o644)
	cmd := cmdLine(strings.Replace(restartLine(bat), "-n 4", "-n 2", 1))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 150; i++ {
		if _, err := os.Stat(mark); err == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("the program was not started")
}
