//go:build windows

// adal-clip.exe — the double "C" screen crop, anywhere on the PC, while Adal
// Keep runs (asked on 2026-11-16: fast, also on old PCs, also when the Adal
// Keep page is not the one in front).
//
// The Adal Keep server starts it (services/screenClip.js) and it ends with the
// server. It watches the keyboard (a low-level hook: it only looks, every key
// still goes where it was going). "C" pressed twice quickly, alone — no Ctrl,
// Alt, Shift or Windows key, and no other key just before (so typing "cc" in
// a word does nothing) — freezes the screen at once and opens Adal Keep's own
// crop over it (overlay.go, ~0.1 s; Windows' own crop, ms-screenclip:, took
// 1–3 s to start and is only used when this one cannot open). The cropped
// picture is sent to the server, which puts it in the tray of every open
// Adal Keep page, and onto the clipboard.
//
//	adal-clip.exe --server http://127.0.0.1:4000 --parent <pid>
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")

	setHook       = user32.NewProc("SetWindowsHookExW")
	callNext      = user32.NewProc("CallNextHookEx")
	getMessage    = user32.NewProc("GetMessageW")
	asyncKey      = user32.NewProc("GetAsyncKeyState")
	clipSeq       = user32.NewProc("GetClipboardSequenceNumber")
	openClip      = user32.NewProc("OpenClipboard")
	closeClip     = user32.NewProc("CloseClipboard")
	clipData      = user32.NewProc("GetClipboardData")
	clipAvailable = user32.NewProc("IsClipboardFormatAvailable")
	registerFmt   = user32.NewProc("RegisterClipboardFormatW")
	globalLock    = kernel32.NewProc("GlobalLock")
	globalUnlock  = kernel32.NewProc("GlobalUnlock")
	globalSize    = kernel32.NewProc("GlobalSize")
	moduleHandle  = kernel32.NewProc("GetModuleHandleW")
	shellExecute  = shell32.NewProc("ShellExecuteW")
)

const (
	whKeyboardLL = 13
	wmKeyDown    = 0x0100
	wmKeyUp      = 0x0101
	wmSysKeyDown = 0x0104
	wmSysKeyUp   = 0x0105
	vkC          = 0x43
	llkhInjected = 0x10
	cfDIB        = 8
)

type kbdHook struct {
	VkCode, ScanCode, Flags, Time uint32
	ExtraInfo                     uintptr
}

var (
	server  string
	presses = make(chan struct{}, 4)
	// Keyboard state, only ever touched in the hook's own thread.
	cDown            bool
	lastC, lastOther time.Time
	firstCAfterQuiet bool
)

const (
	pair  = 450 * time.Millisecond // the two presses of C
	quiet = 700 * time.Millisecond // no other key just before the first C (typing)
)

func held(vk int) bool {
	r, _, _ := asyncKey.Call(uintptr(vk))
	return r&0x8000 != 0
}

func hook(code int, wparam uintptr, lparam uintptr) uintptr {
	if code >= 0 {
		k := (*kbdHook)(unsafe.Pointer(lparam))
		now := time.Now()
		// The crop screen is open: Esc closes it (it may not have the keyboard).
		if k.VkCode == vkEscape && overlayHwnd.Load() != 0 {
			if wparam == wmKeyDown || wparam == wmSysKeyDown {
				postMessage.Call(overlayHwnd.Load(), wmClose, 0, 0)
			}
			return 1
		}
		if k.Flags&llkhInjected == 0 {
			switch wparam {
			case wmKeyDown, wmSysKeyDown:
				if k.VkCode == vkC {
					if !cDown { // a new press, not the key held down
						cDown = true
						mods := held(0x11) || held(0x12) || held(0x10) || held(0x5B) || held(0x5C)
						switch {
						case mods:
							lastC = time.Time{}
						case !lastC.IsZero() && now.Sub(lastC) <= pair && firstCAfterQuiet:
							lastC = time.Time{}
							select {
							case presses <- struct{}{}:
							default:
							}
						default:
							lastC = now
							firstCAfterQuiet = now.Sub(lastOther) > quiet
						}
					}
				} else if k.VkCode != 0x10 && k.VkCode != 0xA0 && k.VkCode != 0xA1 {
					lastOther = now
					lastC = time.Time{}
				}
			case wmKeyUp, wmSysKeyUp:
				if k.VkCode == vkC {
					cDown = false
				}
			}
		}
	}
	r, _, _ := callNext.Call(0, uintptr(code), wparam, lparam)
	return r
}

func watchKeyboard() {
	runtime.LockOSThread()
	mod, _, _ := moduleHandle.Call(0)
	h, _, _ := setHook.Call(whKeyboardLL, windows.NewCallback(hook), mod, 0)
	if h == 0 {
		os.Exit(2)
	}
	var msg [48]byte
	for {
		r, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
	}
}

func seq() uint32 { r, _, _ := clipSeq.Call(); return uint32(r) }

// The clipboard's picture as PNG bytes (Windows' crop puts a PNG and a DIB there).
func clipboardPNG() []byte {
	if ok, _, _ := openClip.Call(0); ok == 0 {
		return nil
	}
	defer closeClip.Call()
	name, _ := windows.UTF16PtrFromString("PNG")
	if f, _, _ := registerFmt.Call(uintptr(unsafe.Pointer(name))); f != 0 {
		if b := globalBytes(f); len(b) > 8 && bytes.HasPrefix(b, []byte("\x89PNG")) {
			return b
		}
	}
	if a, _, _ := clipAvailable.Call(cfDIB); a == 0 {
		return nil
	}
	return dibToPNG(globalBytes(cfDIB))
}

func globalBytes(format uintptr) []byte {
	h, _, _ := clipData.Call(format)
	if h == 0 {
		return nil
	}
	p, _, _ := globalLock.Call(h)
	if p == 0 {
		return nil
	}
	defer globalUnlock.Call(h)
	n, _, _ := globalSize.Call(h)
	out := make([]byte, n)
	copy(out, unsafe.Slice((*byte)(unsafe.Pointer(p)), n))
	return out
}

// A device-independent bitmap (24 or 32 bits) as a PNG.
func dibToPNG(b []byte) []byte {
	if len(b) < 40 {
		return nil
	}
	hs := int(binary.LittleEndian.Uint32(b[0:]))
	w := int(int32(binary.LittleEndian.Uint32(b[4:])))
	hh := int(int32(binary.LittleEndian.Uint32(b[8:])))
	bpp := int(binary.LittleEndian.Uint16(b[14:]))
	comp := binary.LittleEndian.Uint32(b[16:])
	if w <= 0 || hh == 0 || (bpp != 24 && bpp != 32) {
		return nil
	}
	off := hs
	if comp == 3 && hs == 40 { // BI_BITFIELDS: three masks follow the header
		off += 12
	}
	top := hh < 0
	if top {
		hh = -hh
	}
	stride := ((w*bpp + 31) / 32) * 4
	if len(b) < off+stride*hh {
		return nil
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, hh))
	for y := 0; y < hh; y++ {
		row := y
		if !top {
			row = hh - 1 - y
		}
		line := b[off+row*stride:]
		for x := 0; x < w; x++ {
			px := line[x*bpp/8:]
			img.SetNRGBA(x, y, color.NRGBA{px[2], px[1], px[0], 255})
		}
	}
	var out bytes.Buffer
	if png.Encode(&out, img) != nil {
		return nil
	}
	return out.Bytes()
}

func tell(state string) {
	req, _ := http.NewRequest("POST", server+"/api/app/clip?state="+state, nil)
	c := &http.Client{Timeout: 5 * time.Second}
	if r, err := c.Do(req); err == nil {
		r.Body.Close()
	}
}

func sendPNG(p []byte) {
	c := &http.Client{Timeout: 60 * time.Second}
	if r, err := c.Post(server+"/api/app/clip", "image/png", bytes.NewReader(p)); err == nil {
		r.Body.Close()
	}
}

// One crop: Adal Keep's own crop screen, at once (overlay.go); the picture
// goes to the server and onto the clipboard (Ctrl+V works as before).
func crop() {
	p, err := cropHere()
	// C pressed again while it was open: not a new crop.
	for len(presses) > 0 {
		<-presses
	}
	if err == nil {
		if p != nil {
			sendPNG(p)
			putOnClipboard(p)
		}
		return
	}
	windowsCrop()
}

// Windows' own crop (when the crop screen could not open).
func windowsCrop() {
	before := seq()
	verb, _ := windows.UTF16PtrFromString("open")
	what, _ := windows.UTF16PtrFromString("ms-screenclip:")
	shellExecute.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(what)), 0, 0, 1)
	go tell("cropping")
	end := time.Now().Add(2 * time.Minute)
	for time.Now().Before(end) {
		time.Sleep(100 * time.Millisecond)
		select { // pressed again: a new crop starts over
		case <-presses:
			go windowsCrop()
			return
		default:
		}
		if s := seq(); s != before {
			if p := clipboardPNG(); p != nil {
				sendPNG(p)
				return
			}
			before = s
		}
	}
	tell("none")
}

func main() {
	flag.StringVar(&server, "server", "http://127.0.0.1:4000", "the Adal Keep server")
	parent := flag.Int("parent", 0, "ends when this process ends")
	once := flag.Int("once", 0, "this many crops now, then end (a test)")
	flag.Parse()
	dpiOnce()
	if *once > 0 {
		go watchKeyboard() // (Esc closes it, as in use)
		runtime.LockOSThread()
		prepare(false)
		for i := 0; i < *once; i++ {
			t0 := time.Now()
			onShown = func() { os.Stderr.WriteString("shown after " + time.Since(t0).String() + "\n") }
			crop()
			os.Stderr.WriteString("done after " + time.Since(t0).String() + "\n")
		}
		return
	}
	// One watcher per PC.
	name, _ := windows.UTF16PtrFromString(`Local\AdalKeepClip`)
	if _, err := windows.CreateMutex(nil, false, name); err == windows.ERROR_ALREADY_EXISTS {
		return
	}
	if *parent > 0 {
		go func() {
			h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(*parent))
			if err != nil {
				os.Exit(0)
			}
			windows.WaitForSingleObject(h, windows.INFINITE)
			os.Exit(0)
		}()
	}
	go func() {
		// The crop screen is made now and lives in this thread (overlay.go).
		runtime.LockOSThread()
		prepare(false)
		for range presses {
			crop()
		}
	}()
	watchKeyboard()
}
