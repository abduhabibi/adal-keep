//go:build windows

package main

import "testing"

func TestOneOpenerAtATime(t *testing.T) {
	release, ok := openingNow()
	if !ok {
		t.Fatal("nobody opens it")
	}
	if _, ok := openingNow(); ok {
		t.Fatal("two at once")
	}
	release()
	release, ok = openingNow()
	if !ok {
		t.Fatal("not free again")
	}
	release()
	profileHolders(`C:\none`) // runs
}
