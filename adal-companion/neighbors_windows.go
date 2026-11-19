//go:build windows

package main

import (
	"encoding/binary"
	"net"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetIpNetTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetIpNetTable")

// neighbourTable: Windows' ARP table (GetIpNetTable), read without starting
// any program (no window ever shows).
//
//	MIB_IPNETTABLE { DWORD dwNumEntries; MIB_IPNETROW table[] }
//	MIB_IPNETROW   { DWORD dwIndex; DWORD dwPhysAddrLen; BYTE bPhysAddr[8]; DWORD dwAddr; DWORD dwType }
func neighbourTable() map[string]string {
	out := map[string]string{}
	if procGetIpNetTable.Find() != nil {
		return out
	}
	size := uint32(16 * 1024)
	for try := 0; try < 3; try++ {
		buf := make([]byte, size)
		r, _, _ := procGetIpNetTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0)
		if r == uintptr(windows.ERROR_INSUFFICIENT_BUFFER) {
			continue
		}
		if r != 0 || len(buf) < 4 {
			return out
		}
		n := int(binary.LittleEndian.Uint32(buf[0:4]))
		const row = 24
		for i := 0; i < n && 4+(i+1)*row <= len(buf); i++ {
			b := buf[4+i*row : 4+(i+1)*row]
			l := int(binary.LittleEndian.Uint32(b[4:8]))
			typ := binary.LittleEndian.Uint32(b[20:24])
			if l != 6 || typ == 2 { // 2 = invalid
				continue
			}
			ip := net.IPv4(b[16], b[17], b[18], b[19]).String()
			if m := normMAC(net.HardwareAddr(b[8:14]).String()); m != "" {
				out[ip] = m
			}
		}
		return out
	}
	return out
}
