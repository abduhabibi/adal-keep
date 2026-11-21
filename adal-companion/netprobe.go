package main

// netprobe.go — how good this PC's internet is for the robots (asked on
// 2026-11-21: the main PC gives a run to the PC that finishes it first, and
// the internet counts). Every 10 minutes the portals' first pages are asked
// for: the answer time (latency), how fast the bytes come (throughput) and
// whether an answer came at all (reliability). Said with the robot browser's
// announcement as net_rtt_ms, net_mbps, net_ok (backend services/netQuality.js
// measures the main PC the same way).

import (
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
)

var probeHosts = []string{
	"https://www.musaned.com.sa/",
	"https://visa.mofa.gov.sa/",
	"https://lmis.gov.et/",
	"https://wafid.com/",
}

type netSample struct {
	ok          bool
	firstMs, ms float64
	bytes       int64
}

var (
	netMu      sync.Mutex
	netSamples []netSample
)

const netKeep = 48

func medianOf(xs []float64) float64 {
	if len(xs) == 0 {
		return -1
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	return s[len(s)/2]
}

// netSummary: what is said to the main PC (empty before the first look).
func netSummary(list []netSample) map[string]any {
	if len(list) == 0 {
		return map[string]any{}
	}
	var rtts, speeds []float64
	good := 0
	for _, s := range list {
		if !s.ok {
			continue
		}
		good++
		rtts = append(rtts, s.firstMs)
		if s.bytes >= 20000 && s.ms > s.firstMs {
			speeds = append(speeds, float64(s.bytes*8)/((s.ms-s.firstMs)/1000)/1e6)
		}
	}
	out := map[string]any{"net_ok": float64(good) / float64(len(list))}
	if r := medianOf(rtts); r >= 0 {
		out["net_rtt_ms"] = r
	}
	if m := medianOf(speeds); m >= 0 {
		out["net_mbps"] = m
	}
	return out
}

func probeOnce(client *http.Client, hosts []string) []netSample {
	var out []netSample
	for _, u := range hosts {
		t0 := time.Now()
		req, _ := http.NewRequest(http.MethodGet, u, nil)
		req.Header.Set("Cache-Control", "no-cache")
		resp, err := client.Do(req)
		if err != nil {
			out = append(out, netSample{ok: false})
			continue
		}
		first := float64(time.Since(t0).Microseconds()) / 1000
		n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 512*1024))
		resp.Body.Close()
		out = append(out, netSample{ok: resp.StatusCode < 500, firstMs: first, ms: float64(time.Since(t0).Microseconds()) / 1000, bytes: n})
	}
	return out
}

func netNow() map[string]any {
	netMu.Lock()
	defer netMu.Unlock()
	return netSummary(netSamples)
}

// probeNetwork: the first look a minute after start, then every 10 minutes.
func probeNetwork() {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	time.Sleep(time.Minute)
	for {
		got := probeOnce(client, probeHosts)
		netMu.Lock()
		netSamples = append(netSamples, got...)
		if len(netSamples) > netKeep {
			netSamples = netSamples[len(netSamples)-netKeep:]
		}
		netMu.Unlock()
		time.Sleep(10 * time.Minute)
	}
}
