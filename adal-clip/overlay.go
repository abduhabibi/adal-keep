//go:build windows

// Adal Keep's own screen crop (asked on 2026-11-20: "make the double C crop as
// fast as possible"). Windows' crop (ms-screenclip:) starts the Snipping Tool
// app first — 1 to 3 seconds, more on old PCs, and Windows 7/8 have none. Here
// the screen is frozen the moment C is pressed the second time (one copy of
// the screen, a few milliseconds), shown dimmed over every monitor, and the
// part dragged over is the picture: no app starts, nothing waits on the
// clipboard. Esc or a right click: no crop.
package main

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	gdi32 = windows.NewLazySystemDLL("gdi32.dll")

	getSysMetrics   = user32.NewProc("GetSystemMetrics")
	getDC           = user32.NewProc("GetDC")
	releaseDC       = user32.NewProc("ReleaseDC")
	registerClass   = user32.NewProc("RegisterClassExW")
	createWindow    = user32.NewProc("CreateWindowExW")
	defWindowProc   = user32.NewProc("DefWindowProcW")
	destroyWindow   = user32.NewProc("DestroyWindow")
	setWindowPos    = user32.NewProc("SetWindowPos")
	showWindow      = user32.NewProc("ShowWindow")
	updateWindow    = user32.NewProc("UpdateWindow")
	setForeground   = user32.NewProc("SetForegroundWindow")
	invalidateRect  = user32.NewProc("InvalidateRect")
	beginPaint      = user32.NewProc("BeginPaint")
	endPaint        = user32.NewProc("EndPaint")
	postMessage     = user32.NewProc("PostMessageW")
	postQuit        = user32.NewProc("PostQuitMessage")
	dispatchMessage = user32.NewProc("DispatchMessageW")
	translateMsg    = user32.NewProc("TranslateMessage")
	loadCursor      = user32.NewProc("LoadCursorW")
	setCursor       = user32.NewProc("SetCursor")
	setCapture      = user32.NewProc("SetCapture")
	releaseCapture  = user32.NewProc("ReleaseCapture")
	dpiAwareCtx     = user32.NewProc("SetProcessDpiAwarenessContext")
	dpiAware        = user32.NewProc("SetProcessDPIAware")

	createCompatDC = gdi32.NewProc("CreateCompatibleDC")
	createDIB      = gdi32.NewProc("CreateDIBSection")
	selectObject   = gdi32.NewProc("SelectObject")
	deleteObject   = gdi32.NewProc("DeleteObject")
	deleteDC       = gdi32.NewProc("DeleteDC")
	bitBlt         = gdi32.NewProc("BitBlt")
	gdiFlush       = gdi32.NewProc("GdiFlush")
	createPen      = gdi32.NewProc("CreatePen")
	getStockObject = gdi32.NewProc("GetStockObject")
	rectangle      = gdi32.NewProc("Rectangle")
)

const (
	wmDestroy     = 0x0002
	wmClose       = 0x0010
	wmPaint       = 0x000F
	wmEraseBkgnd  = 0x0014
	wmSetCursor   = 0x0020
	wmMouseMove   = 0x0200
	wmLButtonDown = 0x0201
	wmLButtonUp   = 0x0202
	wmRButtonDown = 0x0204
	wmKeyDownMsg  = 0x0100
	vkEscape      = 0x1B
	srcCopy       = 0x00CC0020
)

type rect struct{ Left, Top, Right, Bottom int32 }

type paintStruct struct {
	Hdc                uintptr
	Erase              int32
	Paint              rect
	Restore, IncUpdate int32
	Reserved           [32]byte
}

type wndClassEx struct {
	Size, Style                uint32
	WndProc                    uintptr
	ClsExtra, WndExtra         int32
	Instance, Icon, Cursor, Bg uintptr
	MenuName, ClassName        *uint16
	IconSm                     uintptr
}

type bitmapInfoHeader struct {
	Size                   uint32
	Width, Height          int32
	Planes, BitCount       uint16
	Compression, SizeImage uint32
	XPels, YPels           int32
	ClrUsed, ClrImportant  uint32
}

// A picture of w×h held by Windows (a DIB section), its pixels (BGRA, top row first) readable here.
type dib struct {
	dc, bmp uintptr
	px      []byte
}

func newDIB(screen uintptr, w, h int) (*dib, error) {
	bi := bitmapInfoHeader{Size: 40, Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	var bits uintptr
	bmp, _, _ := createDIB.Call(screen, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 || bits == 0 {
		return nil, errors.New("no bitmap")
	}
	dc, _, _ := createCompatDC.Call(screen)
	selectObject.Call(dc, bmp)
	return &dib{dc: dc, bmp: bmp, px: unsafe.Slice((*byte)(unsafe.Pointer(bits)), w*h*4)}, nil
}

func (d *dib) free() {
	if d != nil {
		deleteDC.Call(d.dc)
		deleteObject.Call(d.bmp)
	}
}

// One crop at a time: its state, touched only in the crop's own thread (and the hook's Esc).
var ov struct {
	hwnd           uintptr
	vx, vy, w, h   int
	shot, dim, buf *dib
	pen, cross     uintptr
	dragging       bool
	x0, y0, x1, y1 int
	done           bool
	sel            rect // the picture's part, when done
}

var onShown func()             // (a test: when the crop screen shows)
var overlayHwnd atomic.Uintptr // the hook closes it on Esc
var classOnce sync.Once
var className, _ = windows.UTF16PtrFromString("AdalKeepCrop")

func dpiOnce() {
	// Real pixels on every monitor (else a scaled screen crops the wrong part).
	if dpiAwareCtx.Find() == nil {
		if r, _, _ := dpiAwareCtx.Call(^uintptr(3)); r != 0 { // PER_MONITOR_AWARE_V2 (-4)
			return
		}
	}
	if dpiAware.Find() == nil {
		dpiAware.Call()
	}
}

func selRect() rect {
	l, r := ov.x0, ov.x1
	if l > r {
		l, r = r, l
	}
	t, b := ov.y0, ov.y1
	if t > b {
		t, b = b, t
	}
	return rect{int32(l), int32(t), int32(r), int32(b)}
}

func union(a, b rect) rect {
	if b.Left < a.Left {
		a.Left = b.Left
	}
	if b.Top < a.Top {
		a.Top = b.Top
	}
	if b.Right > a.Right {
		a.Right = b.Right
	}
	if b.Bottom > a.Bottom {
		a.Bottom = b.Bottom
	}
	return rect{a.Left - 3, a.Top - 3, a.Right + 3, a.Bottom + 3}
}

func paint(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := beginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	p := ps.Paint
	pw, ph := uintptr(p.Right-p.Left), uintptr(p.Bottom-p.Top)
	if !ov.dragging { // the first look: the dimmed screen straight to the window
		bitBlt.Call(hdc, uintptr(p.Left), uintptr(p.Top), pw, ph, ov.dim.dc, uintptr(p.Left), uintptr(p.Top), srcCopy)
		endPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		return
	}
	// Only the part that changed: the dimmed screen, the chosen part in full light, its frame.
	bitBlt.Call(ov.buf.dc, uintptr(p.Left), uintptr(p.Top), pw, ph, ov.dim.dc, uintptr(p.Left), uintptr(p.Top), srcCopy)
	if ov.dragging {
		s := selRect()
		if s.Right > s.Left && s.Bottom > s.Top {
			bitBlt.Call(ov.buf.dc, uintptr(s.Left), uintptr(s.Top), uintptr(s.Right-s.Left), uintptr(s.Bottom-s.Top), ov.shot.dc, uintptr(s.Left), uintptr(s.Top), srcCopy)
			old, _, _ := selectObject.Call(ov.buf.dc, ov.pen)
			hollow, _, _ := getStockObject.Call(5) // NULL_BRUSH
			oldB, _, _ := selectObject.Call(ov.buf.dc, hollow)
			rectangle.Call(ov.buf.dc, uintptr(s.Left-1), uintptr(s.Top-1), uintptr(s.Right+1), uintptr(s.Bottom+1))
			selectObject.Call(ov.buf.dc, old)
			selectObject.Call(ov.buf.dc, oldB)
		}
	}
	bitBlt.Call(hdc, uintptr(p.Left), uintptr(p.Top), pw, ph, ov.buf.dc, uintptr(p.Left), uintptr(p.Top), srcCopy)
	endPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
}

// The mouse's place in the crop screen, kept inside it (it is captured, so it can be dragged past the edge).
func xy(lp uintptr) (int, int) {
	clamp := func(v, hi int) int {
		if v < 0 {
			return 0
		}
		if v > hi {
			return hi
		}
		return v
	}
	return clamp(int(int16(lp&0xFFFF)), ov.w), clamp(int(int16((lp>>16)&0xFFFF)), ov.h)
}

func redraw(r rect) { invalidateRect.Call(ov.hwnd, uintptr(unsafe.Pointer(&r)), 0) }

func wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		paint(hwnd)
		return 0
	case wmSetCursor:
		setCursor.Call(ov.cross)
		return 1
	case wmLButtonDown:
		ov.x0, ov.y0 = xy(lp)
		ov.x1, ov.y1 = ov.x0, ov.y0
		ov.dragging = true
		setCapture.Call(hwnd)
		return 0
	case wmMouseMove:
		if ov.dragging {
			before := selRect()
			ov.x1, ov.y1 = xy(lp)
			redraw(union(before, selRect()))
		}
		return 0
	case wmLButtonUp:
		if ov.dragging {
			ov.x1, ov.y1 = xy(lp)
			releaseCapture.Call()
			s := selRect()
			if s.Right-s.Left >= 4 && s.Bottom-s.Top >= 4 { // a click alone crops nothing
				ov.sel, ov.done = s, true
			}
			finish(hwnd)
		}
		return 0
	case wmRButtonDown, wmClose:
		finish(hwnd)
		return 0
	case wmKeyDownMsg:
		if wp == vkEscape {
			finish(hwnd)
		}
		return 0
	case wmDestroy:
		ov.hwnd = 0
		return 0
	}
	r, _, _ := defWindowProc.Call(hwnd, msg, wp, lp)
	return r
}

var wndProcCb = windows.NewCallback(wndProc)

// The crop ends: the screen is hidden, not closed (the next one only shows it again).
func finish(hwnd uintptr) {
	if ov.dragging {
		releaseCapture.Call()
		ov.dragging = false
	}
	showWindow.Call(hwnd, 0) // SW_HIDE
	overlayHwnd.Store(0)
	postQuit.Call(0)
}

func freePictures() {
	ov.shot.free()
	ov.dim.free()
	ov.buf.free()
	ov.shot, ov.dim, ov.buf = nil, nil, nil
}

// The crop screen, made when the watcher starts (a double C then only copies
// the screen and shows it), placed again over every monitor each time; with
// pictures: the screen's three pictures too (a few milliseconds).
func prepare(pictures bool) error {
	mod, _, _ := moduleHandle.Call(0)
	classOnce.Do(func() {
		cross, _, _ := loadCursor.Call(0, 32515) // IDC_CROSS
		ov.cross = cross
		ov.pen, _, _ = createPen.Call(0, 2, 0x00A6B814) // teal
		wc := wndClassEx{Size: uint32(unsafe.Sizeof(wndClassEx{})), WndProc: wndProcCb, Instance: mod, Cursor: cross, ClassName: className}
		registerClass.Call(uintptr(unsafe.Pointer(&wc)))
	})
	// Every monitor together (the virtual screen).
	m := func(i uintptr) int { r, _, _ := getSysMetrics.Call(i); return int(int32(r)) }
	vx, vy, w, h := m(76), m(77), m(78), m(79)
	if w <= 0 || h <= 0 {
		return errors.New("no screen")
	}
	if pictures {
		freePictures()
		screen, _, _ := getDC.Call(0)
		defer releaseDC.Call(0, screen)
		var err error
		if ov.shot, err = newDIB(screen, w, h); err != nil {
			return err
		}
		if ov.dim, err = newDIB(screen, w, h); err != nil {
			return err
		}
		if ov.buf, err = newDIB(screen, w, h); err != nil {
			return err
		}
	}
	ov.vx, ov.vy, ov.w, ov.h = vx, vy, w, h
	if ov.hwnd == 0 {
		hwnd, _, _ := createWindow.Call(0x08|0x80, uintptr(unsafe.Pointer(className)), 0, 0x80000000, // TOPMOST|TOOLWINDOW, POPUP (hidden)
			uintptr(vx), uintptr(vy), uintptr(w), uintptr(h), 0, 0, mod, 0)
		if hwnd == 0 {
			return errors.New("no window")
		}
		ov.hwnd = hwnd
	}
	return nil
}

// The part of the screen dragged over, as a PNG; nil when no crop was made.
// An error: this crop screen could not open (then Windows' own is used).
func cropHere() ([]byte, error) {
	// (The caller's thread for good: the crop screen lives in it.)
	runtime.LockOSThread()
	// The screen's three pictures only while a crop is open (two 4K screens: 200 MB).
	defer freePictures()
	if err := prepare(true); err != nil {
		return nil, err
	}
	screen, _, _ := getDC.Call(0)
	bitBlt.Call(ov.shot.dc, 0, 0, uintptr(ov.w), uintptr(ov.h), screen, uintptr(ov.vx), uintptr(ov.vy), srcCopy) // (no CAPTUREBLT: Windows 8+ composes every window into the screen anyway; it only made the cursor flicker)
	releaseDC.Call(0, screen)
	gdiFlush.Call()
	s, d := ov.shot.px, ov.dim.px
	// The screen at half light: four bytes at a time (a 4K screen in a few milliseconds).
	s32 := unsafe.Slice((*uint32)(unsafe.Pointer(&s[0])), len(s)/4)
	d32 := unsafe.Slice((*uint32)(unsafe.Pointer(&d[0])), len(d)/4)
	for i, v := range s32 {
		d32[i] = (v >> 1) & 0x7F7F7F7F
	}
	ov.dragging, ov.done = false, false
	hwnd := ov.hwnd
	// The new picture in the window before it shows (never a glimpse of the last crop).
	if wdc, _, _ := getDC.Call(hwnd); wdc != 0 {
		bitBlt.Call(wdc, 0, 0, uintptr(ov.w), uintptr(ov.h), ov.dim.dc, 0, 0, srcCopy)
		releaseDC.Call(hwnd, wdc)
	}
	invalidateRect.Call(hwnd, 0, 0)
	overlayHwnd.Store(hwnd)
	setWindowPos.Call(hwnd, ^uintptr(0), uintptr(ov.vx), uintptr(ov.vy), uintptr(ov.w), uintptr(ov.h), 0x0040) // HWND_TOPMOST, SWP_SHOWWINDOW
	updateWindow.Call(hwnd)
	setForeground.Call(hwnd)
	if onShown != nil {
		onShown()
	}
	var msg [48]byte
	for {
		r, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		translateMsg.Call(uintptr(unsafe.Pointer(&msg[0])))
		dispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
	}
	if !ov.done {
		return nil, nil
	}
	return cutPNG(ov.shot.px, ov.w, ov.sel), nil
}

// The part `r` of a BGRA picture `w` wide, as a PNG (fast compression: it is sent at once).
func cutPNG(px []byte, w int, r rect) []byte {
	cw, ch := int(r.Right-r.Left), int(r.Bottom-r.Top)
	img := image.NewNRGBA(image.Rect(0, 0, cw, ch))
	for y := 0; y < ch; y++ {
		src := px[((int(r.Top)+y)*w+int(r.Left))*4:]
		dst := img.Pix[y*img.Stride:]
		for x := 0; x < cw; x++ {
			o := x * 4
			dst[o], dst[o+1], dst[o+2], dst[o+3] = src[o+2], src[o+1], src[o], 255
		}
	}
	var out bytes.Buffer
	if (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&out, img) != nil {
		return nil
	}
	return out.Bytes()
}

var (
	emptyClip   = user32.NewProc("EmptyClipboard")
	setClipData = user32.NewProc("SetClipboardData")
	globalAlloc = kernel32.NewProc("GlobalAlloc")
	globalFree  = kernel32.NewProc("GlobalFree")
)

func putGlobal(format uintptr, b []byte) {
	h, _, _ := globalAlloc.Call(0x0002, uintptr(len(b))) // GMEM_MOVEABLE
	if h == 0 {
		return
	}
	p, _, _ := globalLock.Call(h)
	if p == 0 {
		globalFree.Call(h)
		return
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(p)), len(b)), b)
	globalUnlock.Call(h)
	if r, _, _ := setClipData.Call(format, h); r == 0 {
		globalFree.Call(h)
	}
}

// The cropped picture on the clipboard too, as Windows' crop did (PNG, and a
// bitmap for programs that only take that, such as Paint).
func putOnClipboard(p []byte) {
	img, err := png.Decode(bytes.NewReader(p))
	if err != nil {
		return
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	d := make([]byte, 40+w*h*4)
	bi := bitmapInfoHeader{Size: 40, Width: int32(w), Height: int32(h), Planes: 1, BitCount: 32}
	copy(d, unsafe.Slice((*byte)(unsafe.Pointer(&bi)), 40))
	var pix []byte
	stride := 0
	switch n := img.(type) { // an opaque PNG comes back as RGBA
	case *image.RGBA:
		pix, stride = n.Pix, n.Stride
	case *image.NRGBA:
		pix, stride = n.Pix, n.Stride
	}
	if pix != nil {
		for y := 0; y < h; y++ { // bottom row first
			src := pix[y*stride:]
			dst := d[40+(h-1-y)*w*4:]
			for x := 0; x < w; x++ {
				o := x * 4
				dst[o], dst[o+1], dst[o+2], dst[o+3] = src[o+2], src[o+1], src[o], 255
			}
		}
	}
	if ok, _, _ := openClip.Call(0); ok == 0 {
		return
	}
	defer closeClip.Call()
	emptyClip.Call()
	putGlobal(cfDIB, d)
	name, _ := windows.UTF16PtrFromString("PNG")
	if f, _, _ := registerFmt.Call(uintptr(unsafe.Pointer(name))); f != 0 {
		putGlobal(f, p)
	}
}
