//go:build windows

// cleanold.go — programs an update put aside (x.exe.old) are stopped and deleted:
// the old AdalKeep.exe held the single-copy lock and kept a second supervisor,
// adal-companion.exe.old kept running for days (2026-11-23).

package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var oldSuffix = regexp.MustCompile(`(?i)\.old(-\d+)?$`)

func isOldProgram(name string) bool {
	return oldSuffix.MatchString(name) && strings.Contains(strings.ToLower(name), ".exe.old")
}

// cleanOldPrograms ends what still runs from a *.exe.old file in root (never this process) and deletes the files.
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
		if os.Remove(o) == nil {
			n++
			logf("old program %s stopped and deleted", filepath.Base(o))
		}
	}
	return n
}

// keepOldProgramsAway: at start and every 10 minutes.
func keepOldProgramsAway(root string) {
	for {
		cleanOldPrograms(root)
		time.Sleep(10 * time.Minute)
	}
}

func stopProgramsAt(paths []string, except int) {
	want := map[string]bool{}
	for _, p := range paths {
		want[strings.ToLower(p)] = true
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if int(e.ProcessID) == except || e.ProcessID == 0 {
			continue
		}
		h, oerr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE, false, e.ProcessID)
		if oerr != nil {
			continue
		}
		buf := make([]uint16, 1024)
		n := uint32(len(buf))
		if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil && want[strings.ToLower(windows.UTF16ToString(buf[:n]))] {
			windows.TerminateProcess(h, 0)
			windows.WaitForSingleObject(h, 3000)
		}
		windows.CloseHandle(h)
	}
}
