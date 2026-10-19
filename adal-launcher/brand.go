//go:build windows

// brand.go — the Adal Keep Brave window shows the Adal Keep logo and name on
// the taskbar, not Brave's.
//
// Only the windows of the Brave that runs the Adal Keep profile
// (backend\data\browser-profile) are touched; a personal Brave keeps its own
// look. Each such window gets:
//   - the Adal Keep icon (WM_SETICON),
//   - Adal Keep's own taskbar id (AppUserModelID), with the Adal Keep name,
//     icon and AdalKeep.exe as what a pinned button starts.
// The installer gives the Adal Keep shortcuts the same id (--set-shortcut-ids),
// so Windows shows them as one app: the Adal Keep logo.
package main

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const appID = "AdalSoftware.AdalKeep"

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")
	ole32   = windows.NewLazySystemDLL("ole32.dll")
	ntdll   = windows.NewLazySystemDLL("ntdll.dll")

	pLoadImage                   = user32.NewProc("LoadImageW")
	pSendMessage                 = user32.NewProc("SendMessageW")
	pGetWindow                   = user32.NewProc("GetWindow")
	pGetSystemMetrics            = user32.NewProc("GetSystemMetrics")
	pSHGetPropertyStoreForWindow = shell32.NewProc("SHGetPropertyStoreForWindow")
	pCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	pNtQueryInformationProcess   = ntdll.NewProc("NtQueryInformationProcess")
)

const (
	wmSetIcon      = 0x0080
	wmGetIcon      = 0x007F
	iconSmall      = 0
	iconBig        = 1
	imageIcon      = 1
	lrLoadFromFile = 0x0010
	gwOwner        = 4
	smCxIcon       = 11
	smCxSmIcon     = 49
)

// ---------------------------------------------------------------------------
// The window loop
// ---------------------------------------------------------------------------

func brandWindows(root string) {
	runtime.LockOSThread() // COM (the taskbar id) belongs to one thread
	windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	ico := filepath.Join(root, "adal.ico")
	big := loadIcon(ico, metric(smCxIcon, 32))
	small := loadIcon(ico, metric(smCxSmIcon, 16))
	if big == 0 {
		logf("logo: could not load %s", ico)
		return
	}
	profile := strings.ToLower(profileDir(root))
	exe := filepath.Join(root, "AdalKeep.exe")

	ours := map[uint32]bool{}        // process id → runs the Adal Keep profile
	tagged := map[windows.HWND]bool{} // windows that have the Adal Keep id
	cb := syscall.NewCallback(func(h windows.HWND, _ uintptr) uintptr {
		if !windows.IsWindowVisible(h) || owner(h) != 0 || className(h) != "Chrome_WidgetWin_1" {
			return 1
		}
		var pid uint32
		windows.GetWindowThreadProcessId(h, &pid)
		is, known := ours[pid]
		if !known {
			is = strings.Contains(strings.ToLower(commandLine(pid)), profile)
			ours[pid] = is
		}
		if !is {
			return 1
		}
		if cur, _, _ := pSendMessage.Call(uintptr(h), wmGetIcon, iconBig, 0); cur != big {
			pSendMessage.Call(uintptr(h), wmSetIcon, iconBig, big)
			pSendMessage.Call(uintptr(h), wmSetIcon, iconSmall, small)
		}
		if !tagged[h] {
			if err := setWindowAppID(h, exe, filepath.Join(root, "adal.ico")); err != nil {
				logf("logo: taskbar id not set: %v", err)
			}
			tagged[h] = true
		}
		return 1
	})
	for {
		windows.EnumWindows(cb, nil)
		if len(ours) > 500 { // processes come and go
			ours = map[uint32]bool{}
			tagged = map[windows.HWND]bool{}
		}
		time.Sleep(1500 * time.Millisecond)
	}
}

func metric(i int, fallback int) int {
	if v, _, _ := pGetSystemMetrics.Call(uintptr(i)); v > 0 {
		return int(v)
	}
	return fallback
}

func loadIcon(path string, size int) uintptr {
	p, _ := windows.UTF16PtrFromString(path)
	h, _, _ := pLoadImage.Call(0, uintptr(unsafe.Pointer(p)), imageIcon, uintptr(size), uintptr(size), lrLoadFromFile)
	return h
}

func owner(h windows.HWND) uintptr {
	o, _, _ := pGetWindow.Call(uintptr(h), gwOwner)
	return o
}

func className(h windows.HWND) string {
	buf := make([]uint16, 64)
	n, err := windows.GetClassName(h, &buf[0], int32(len(buf)))
	if err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

// commandLine of another process (Windows 8.1 and newer).
func commandLine(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	const processCommandLineInformation = 60
	buf := make([]byte, 64*1024)
	var n uint32
	r, _, _ := pNtQueryInformationProcess.Call(uintptr(h), processCommandLineInformation,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)))
	if r != 0 {
		return ""
	}
	us := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0]))
	if us.Buffer == nil || us.Length == 0 {
		return ""
	}
	return windows.UTF16ToString(unsafe.Slice(us.Buffer, us.Length/2))
}

// ---------------------------------------------------------------------------
// Taskbar id (AppUserModelID) — COM by hand, no cgo
// ---------------------------------------------------------------------------

var (
	fmtidAppUserModel = windows.GUID{Data1: 0x9F4C2855, Data2: 0x9F79, Data3: 0x4B39, Data4: [8]byte{0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}}
	iidPropertyStore  = windows.GUID{Data1: 0x886d8eeb, Data2: 0x8cf2, Data3: 0x4446, Data4: [8]byte{0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99}}
	clsidShellLink    = windows.GUID{Data1: 0x00021401, Data2: 0, Data3: 0, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidShellLinkW     = windows.GUID{Data1: 0x000214F9, Data2: 0, Data3: 0, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidPersistFile    = windows.GUID{Data1: 0x0000010b, Data2: 0, Data3: 0, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

const (
	pidRelaunchCommand     = 2
	pidRelaunchIcon        = 3
	pidRelaunchDisplayName = 4
	pidID                  = 5
	vtLPWSTR               = 31
)

type propertyKey struct {
	fmtid windows.GUID
	pid   uint32
}

type propVariant struct {
	vt       uint16
	reserved [3]uint16
	val      uintptr
	pad      uintptr
}

// comCall calls method `index` of the COM object `obj`.
func comCall(obj uintptr, index int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

func release(obj uintptr) { comCall(obj, 2) }

// IPropertyStore: 6 SetValue, 7 Commit.
func setString(store uintptr, pid uint32, value string) error {
	s, _ := windows.UTF16PtrFromString(value)
	key := propertyKey{fmtidAppUserModel, pid}
	pv := propVariant{vt: vtLPWSTR, val: uintptr(unsafe.Pointer(s))}
	if hr := comCall(store, 6, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv))); hr != 0 {
		return hrError("SetValue", hr)
	}
	return nil
}

func hrError(what string, hr uintptr) error {
	return errors.New(what + " failed: 0x" + strings.ToUpper(strconvHex(uint32(hr))))
}

func strconvHex(v uint32) string {
	const d = "0123456789abcdef"
	out := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		out[i] = d[v&15]
		v >>= 4
	}
	return string(out)
}

func setWindowAppID(h windows.HWND, exe, ico string) error {
	var store uintptr
	if hr, _, _ := pSHGetPropertyStoreForWindow.Call(uintptr(h), uintptr(unsafe.Pointer(&iidPropertyStore)), uintptr(unsafe.Pointer(&store))); hr != 0 {
		return hrError("SHGetPropertyStoreForWindow", hr)
	}
	defer release(store)
	// The relaunch details go first: Windows reads them when the id changes.
	for _, p := range []struct {
		pid uint32
		v   string
	}{
		{pidRelaunchCommand, `"` + exe + `"`},
		{pidRelaunchDisplayName, "Adal Keep"},
		{pidRelaunchIcon, ico + ",0"},
		{pidID, appID},
	} {
		if err := setString(store, p.pid, p.v); err != nil {
			return err
		}
	}
	return nil
}

// setShortcutAppID gives a shortcut the Adal Keep taskbar id.
// IPersistFile: 5 Load, 6 Save. IPropertyStore: 7 Commit.
func setShortcutAppID(lnk, root string) error {
	runtime.LockOSThread() // COM belongs to one thread
	defer runtime.UnlockOSThread()
	windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	defer windows.CoUninitialize()
	var link uintptr
	if hr, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidShellLink)), 0, 1 /* CLSCTX_INPROC_SERVER */,
		uintptr(unsafe.Pointer(&iidShellLinkW)), uintptr(unsafe.Pointer(&link))); hr != 0 {
		return hrError("CoCreateInstance", hr)
	}
	defer release(link)
	var file, store uintptr
	if hr := comCall(link, 0, uintptr(unsafe.Pointer(&iidPersistFile)), uintptr(unsafe.Pointer(&file))); hr != 0 {
		return hrError("IPersistFile", hr)
	}
	defer release(file)
	path, _ := windows.UTF16PtrFromString(lnk)
	if hr := comCall(file, 5, uintptr(unsafe.Pointer(path)), 2 /* STGM_READWRITE */); hr != 0 {
		return hrError("Load", hr)
	}
	if hr := comCall(link, 0, uintptr(unsafe.Pointer(&iidPropertyStore)), uintptr(unsafe.Pointer(&store))); hr != 0 {
		return hrError("IPropertyStore", hr)
	}
	defer release(store)
	if err := setString(store, pidID, appID); err != nil {
		return err
	}
	if hr := comCall(store, 7); hr != 0 {
		return hrError("Commit", hr)
	}
	if hr := comCall(file, 6, 0, 1); hr != 0 {
		return hrError("Save", hr)
	}
	return nil
}
