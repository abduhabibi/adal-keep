//go:build windows

package main

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// stopProgramsAt ends every process (but except) whose program file is one of paths.
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
