//go:build windows

package main

// power_windows.go — how strong this PC is right now, for the main PC to pick
// who does the heavy work ("PCs share their power", asked on 2026-11-20): its
// memory (all and free), how busy its processor is, and whether it is on its
// battery. Read every time the robot browser is announced.

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalMemoryEx    = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetSystemTimes    = kernel32.NewProc("GetSystemTimes")
	procGetPowerStatus    = kernel32.NewProc("GetSystemPowerStatus")
	cpuMu                 sync.Mutex
	lastIdle, lastBusyAll uint64
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func ft(f windows.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }

// powerNow: {"mem_gb", "free_gb", "load" (0-100, since the last call), "battery"}.
func powerNow() map[string]any {
	out := map[string]any{}
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	if r, _, _ := procGlobalMemoryEx.Call(uintptr(unsafe.Pointer(&m))); r != 0 {
		out["mem_gb"] = float64(m.TotalPhys) / (1 << 30)
		out["free_gb"] = float64(m.AvailPhys) / (1 << 30)
	}
	var idle, kernel, user windows.Filetime
	if r, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user))); r != 0 {
		i, all := ft(idle), ft(kernel)+ft(user) // kernel time includes idle time
		cpuMu.Lock()
		if lastBusyAll != 0 && all > lastBusyAll {
			d := all - lastBusyAll
			out["load"] = int(100 * (d - (i - lastIdle)) / d)
		}
		lastIdle, lastBusyAll = i, all
		cpuMu.Unlock()
	}
	var ps struct {
		ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag byte
		BatteryLifeTime, BatteryFullLifeTime                            uint32
	}
	if r, _, _ := procGetPowerStatus.Call(uintptr(unsafe.Pointer(&ps))); r != 0 {
		out["battery"] = ps.ACLineStatus == 0 // unplugged
	}
	return out
}
