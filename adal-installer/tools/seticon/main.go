//go:build windows

// seticon writes an .ico into a Windows program as its icon:
//
//	seticon.exe program.exe logo.ico
//
// Used by build-installer.sh (under Wine) so AdalKeep.exe and
// adal-companion.exe show the Adal Keep logo.
package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	pBegin   = kernel32.NewProc("BeginUpdateResourceW")
	pUpdate  = kernel32.NewProc("UpdateResourceW")
	pEnd     = kernel32.NewProc("EndUpdateResourceW")
)

const (
	rtIcon      = 3
	rtGroupIcon = 14
	langNeutral = 0
)

func main() {
	if len(os.Args) != 3 {
		fmt.Println("usage: seticon program.exe logo.ico")
		os.Exit(2)
	}
	ico, err := os.ReadFile(os.Args[2])
	if err != nil || len(ico) < 6 || binary.LittleEndian.Uint16(ico[2:]) != 1 {
		fail("not an .ico file: %v", err)
	}
	n := int(binary.LittleEndian.Uint16(ico[4:]))
	exe, _ := syscall.UTF16PtrFromString(os.Args[1])
	h, _, e := pBegin.Call(uintptr(unsafe.Pointer(exe)), 0)
	if h == 0 {
		fail("cannot open %s: %v", os.Args[1], e)
	}
	// The group: the .ico header with each entry's file offset replaced by its resource id.
	group := make([]byte, 6, 6+14*n)
	copy(group, ico[:6])
	for i := 0; i < n; i++ {
		e := ico[6+16*i : 6+16*(i+1)]
		size := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		img := ico[off : off+size]
		id := uintptr(i + 1)
		if r, _, err := pUpdate.Call(h, rtIcon, id, langNeutral, uintptr(unsafe.Pointer(&img[0])), uintptr(size)); r == 0 {
			fail("icon %d: %v", i+1, err)
		}
		group = append(group, e[:12]...)
		group = binary.LittleEndian.AppendUint16(group, uint16(i+1))
	}
	if r, _, err := pUpdate.Call(h, rtGroupIcon, 1, langNeutral, uintptr(unsafe.Pointer(&group[0])), uintptr(len(group))); r == 0 {
		fail("icon group: %v", err)
	}
	if r, _, err := pEnd.Call(h, 0); r == 0 {
		fail("save: %v", err)
	}
	fmt.Printf("icon set: %s (%d sizes)\n", os.Args[1], n)
}

func fail(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "seticon: "+f+"\n", a...)
	os.Exit(1)
}
