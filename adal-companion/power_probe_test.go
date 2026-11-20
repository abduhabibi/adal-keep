//go:build windows

package main

import ("testing";"time")

func TestPowerNowProbe(t *testing.T) {
	powerNow(); time.Sleep(500 * time.Millisecond)
	p := powerNow()
	t.Logf("%v", p)
	if p["mem_gb"] == nil || p["load"] == nil { t.Fatal("no memory or load") }
}
