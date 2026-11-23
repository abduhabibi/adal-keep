package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"testing"
)

// Patches made by Node (bsdiff.js diff) give exactly the new file here.
func TestBspatchMatchesNode(t *testing.T) {
	for _, n := range []string{"small", "text", "empty"} {
		old, _ := os.ReadFile("testdata/delta/" + n + ".old")
		want, err := os.ReadFile("testdata/delta/" + n + ".new")
		p, err2 := os.ReadFile("testdata/delta/" + n + ".adalpatch")
		if err != nil || err2 != nil {
			t.Fatal(n, err, err2)
		}
		got, err := bspatch(old, p)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: %v (got %d bytes, want %d)", n, err, len(got), len(want))
		}
	}
	// Two real Go builds (Windows amd64); the new one is known by its SHA-256 only.
	old, _ := os.ReadFile("testdata/delta/go.old")
	p, _ := os.ReadFile("testdata/delta/go.adalpatch")
	got, err := bspatch(old, p)
	if err != nil || sum(got) != "ddcb67d1de72e2b8f9be38d60441e2d323229edd850e311b7d78f2727aaf4f1e" {
		t.Fatalf("go build: %v", err)
	}
}

func TestBspatchRefusesDamage(t *testing.T) {
	old, _ := os.ReadFile("testdata/delta/small.old")
	p, _ := os.ReadFile("testdata/delta/small.adalpatch")
	bad := func(name string, change func(b []byte) []byte) {
		b := change(append([]byte(nil), p...))
		if _, err := bspatch(old, b); err == nil {
			t.Fatalf("%s: a damaged patch was applied", name)
		}
	}
	bad("magic", func(b []byte) []byte { b[0] = 'X'; return b })
	bad("short", func(b []byte) []byte { return b[:20] })
	bad("cut", func(b []byte) []byte { return b[:len(b)-10] })
	bad("a byte in the ctrl stream", func(b []byte) []byte { b[32+12] ^= 0xff; return b })
	bad("ctrl length", func(b []byte) []byte { binary.LittleEndian.PutUint64(b[16:], 1<<40); return b })
	bad("negative size", func(b []byte) []byte { binary.LittleEndian.PutUint64(b[8:], ^uint64(0)); return b })
	bad("too big", func(b []byte) []byte { binary.LittleEndian.PutUint64(b[8:], 1<<31+1); return b })
	bad("bigger than the streams", func(b []byte) []byte { binary.LittleEndian.PutUint64(b[8:], 1<<20); return b })
}
