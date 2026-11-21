package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNetSummary(t *testing.T) {
	if len(netSummary(nil)) != 0 {
		t.Fatal("nothing measured yet: nothing said")
	}
	s := netSummary([]netSample{
		{ok: true, firstMs: 100, ms: 200, bytes: 125000}, // 10 Mbit/s
		{ok: true, firstMs: 300, ms: 400, bytes: 1000},
		{ok: false},
		{ok: true, firstMs: 200, ms: 300, bytes: 125000},
	})
	if s["net_ok"].(float64) != 0.75 || s["net_rtt_ms"].(float64) != 200 {
		t.Fatalf("summary %v", s)
	}
	if m := s["net_mbps"].(float64); m < 9.9 || m > 10.1 {
		t.Fatalf("speed %v", m)
	}
}

func TestProbeOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.Write([]byte(strings.Repeat("x", 50000)))
	}))
	defer srv.Close()
	got := probeOnce(&http.Client{Timeout: 5 * time.Second}, []string{srv.URL, "http://127.0.0.1:1/"})
	if len(got) != 2 || !got[0].ok || got[0].bytes != 50000 || got[0].firstMs < 15 || got[1].ok {
		t.Fatalf("probe %+v", got)
	}
}
