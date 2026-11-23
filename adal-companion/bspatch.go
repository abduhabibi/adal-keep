// bspatch.go — applies a patch made by bsdiff.js (asked on 2026-11-23: a 60 MB
// update took 20 minutes on an agency's slow Wi-Fi; a patch is ~1 MB).
//
//	"ADALDIF1" | newSize i64 | ctrlGz i64 | diffGz i64 | ctrl.gz | diff.gz | extra.gz
//	ctrl = (add i64, copy i64, seek i64)*   — little-endian, seek may be negative
//
// The same as patch() in bsdiff.js. The result is always checked against the
// signed SHA-256 afterwards (getPiece); a damaged patch is an error here.
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"io"
)

var errDamagedPatch = errors.New("damaged patch")

func gunzipAll(b []byte, limit int64) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, errDamagedPatch
	}
	defer zr.Close()
	out, err := io.ReadAll(io.LimitReader(zr, limit+1))
	if err != nil || int64(len(out)) > limit {
		return nil, errDamagedPatch
	}
	return out, nil
}

// bspatch: old + a patch from bsdiff.js → the new file.
func bspatch(old, patch []byte) ([]byte, error) {
	if len(patch) < 32 || string(patch[:8]) != "ADALDIF1" {
		return nil, errors.New("not an Adal patch")
	}
	i64 := func(b []byte) int64 { return int64(binary.LittleEndian.Uint64(b)) }
	newSize, cl, dl := i64(patch[8:]), i64(patch[16:]), i64(patch[24:])
	rest := int64(len(patch)) - 32
	if newSize < 0 || cl < 0 || dl < 0 || cl > rest || dl > rest-cl || newSize > 1<<31 {
		return nil, errDamagedPatch
	}
	// Each stream is at most what the new file needs (ctrl: a triple per byte at most).
	ctrl, err := gunzipAll(patch[32:32+cl], 24*(newSize+1))
	if err != nil {
		return nil, err
	}
	db, err := gunzipAll(patch[32+cl:32+cl+dl], newSize)
	if err != nil {
		return nil, err
	}
	eb, err := gunzipAll(patch[32+cl+dl:], newSize)
	if err != nil {
		return nil, err
	}
	out := make([]byte, newSize)
	oldLen := int64(len(old))
	var oldpos, newpos, dp, ep int64
	for c := 0; newpos < newSize; c += 24 {
		if c+24 > len(ctrl) {
			return nil, errDamagedPatch
		}
		x, y, z := i64(ctrl[c:]), i64(ctrl[c+8:]), i64(ctrl[c+16:])
		if x < 0 || y < 0 || x > newSize-newpos || x > int64(len(db))-dp {
			return nil, errDamagedPatch
		}
		for i := int64(0); i < x; i++ {
			v := db[dp+i]
			if o := oldpos + i; o >= 0 && o < oldLen {
				v += old[o]
			}
			out[newpos+i] = v
		}
		newpos += x
		oldpos += x
		dp += x
		if y > newSize-newpos || y > int64(len(eb))-ep {
			return nil, errDamagedPatch
		}
		copy(out[newpos:newpos+y], eb[ep:ep+y])
		newpos += y
		ep += y
		// A seek that would run far out of any file is damage (JS numbers would lose it too).
		if z > 1<<40 || z < -(1<<40) {
			return nil, errDamagedPatch
		}
		oldpos += z
	}
	return out, nil
}
