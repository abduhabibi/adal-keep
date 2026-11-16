//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"testing"
)

// A 2×2 bottom-up 24-bit DIB (as the clipboard holds it) becomes the same picture as a PNG.
func TestDibToPNG(t *testing.T) {
	w, h := 2, 2
	stride := ((w*24 + 31) / 32) * 4
	b := make([]byte, 40+stride*h)
	binary.LittleEndian.PutUint32(b[0:], 40)
	binary.LittleEndian.PutUint32(b[4:], uint32(w))
	binary.LittleEndian.PutUint32(b[8:], uint32(h))
	binary.LittleEndian.PutUint16(b[12:], 1)
	binary.LittleEndian.PutUint16(b[14:], 24)
	// bottom row first: red, green; top row: blue, white
	px := func(row, x int, r, g, bl byte) { o := 40 + row*stride + x*3; b[o], b[o+1], b[o+2] = bl, g, r }
	px(0, 0, 255, 0, 0)
	px(0, 1, 0, 255, 0)
	px(1, 0, 0, 0, 255)
	px(1, 1, 255, 255, 255)
	out := dibToPNG(b)
	if out == nil {
		t.Fatal("no PNG")
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	r, _, _, _ := img.At(0, 1).RGBA()
	_, g, _, _ := img.At(1, 1).RGBA()
	_, _, bl, _ := img.At(0, 0).RGBA()
	if r>>8 != 255 || g>>8 != 255 || bl>>8 != 255 {
		t.Fatalf("colours moved: %v %v %v", r>>8, g>>8, bl>>8)
	}
	if dibToPNG([]byte{1, 2, 3}) != nil {
		t.Fatal("a broken DIB gave a picture")
	}
}
