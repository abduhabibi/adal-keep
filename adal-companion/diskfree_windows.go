package main

import (
	"syscall"
	"unsafe"
)

var getDiskFree = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")

// diskFree: bytes free for this user where dir is (0: not known).
func diskFree(dir string) int64 {
	p, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return 0
	}
	var free uint64
	if r, _, _ := getDiskFree.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&free)), 0, 0); r == 0 {
		return 0
	}
	return int64(free)
}
