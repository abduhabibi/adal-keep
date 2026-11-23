package main

// Programs an update put aside (x.exe.old, x.exe.old-<n>) must not keep running
// or pile up: after the swap they are stopped and deleted (2026-11-23, the owner
// saw adal-companion.exe.old and AdalKeep.exe.old using resources for days).
// Windows reports a renamed running program under its new name, so a restart
// that used os.Executable() started the .old file again — originalPath fixes that.

import (
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var oldSuffix = regexp.MustCompile(`(?i)\.old(-\d+)?$`)

// isOldProgram: "adal-companion.exe.old" or "AdalKeep.exe.old-17000".
func isOldProgram(name string) bool {
	return oldSuffix.MatchString(name) && strings.Contains(strings.ToLower(name), ".exe.old")
}

// originalPath: the path a program runs from once an update put it aside.
func originalPath(p string) string {
	if isOldProgram(filepath.Base(p)) {
		return oldSuffix.ReplaceAllString(p, "")
	}
	return p
}

// cleanOldPrograms stops whatever still runs from a *.exe.old file in root
// (never this process) and deletes the files; one that cannot go yet stays for
// the next sweep. Returns how many were deleted.
func cleanOldPrograms(root string) int {
	var olds []string
	for _, pat := range []string{"*.exe.old", "*.exe.old-*"} {
		m, _ := filepath.Glob(filepath.Join(root, pat))
		olds = append(olds, m...)
	}
	if len(olds) == 0 {
		return 0
	}
	stopProgramsAt(olds, os.Getpid())
	n := 0
	for _, o := range olds {
		if err := os.Remove(o); err == nil {
			n++
			log.Printf("🧹 old program %s stopped and deleted", filepath.Base(o))
		}
	}
	return n
}

// keepOldProgramsAway: at start and every 10 minutes (never during go test).
func keepOldProgramsAway() {
	b := strings.ToLower(filepath.Base(os.Args[0]))
	if strings.HasSuffix(b, ".test.exe") || strings.HasSuffix(b, ".test") {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	root := filepath.Dir(exe)
	for {
		cleanOldPrograms(root)
		time.Sleep(10 * time.Minute)
	}
}
