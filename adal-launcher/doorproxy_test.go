package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"sync"
	"testing"
	"time"
)

// A page load through the door, as a browser does it: the page, then its files 6 at a
// time, then 3 bursts of 8 data calls (a list, its photos). Each load is a new browser
// (new connections from the browser to the door). The server answers in 2 ms.
func loadThrough(door string, files int) time.Duration {
	c := &http.Client{Transport: &http.Transport{MaxConnsPerHost: 6, MaxIdleConnsPerHost: 6}}
	defer c.CloseIdleConnections()
	get := func(p string) {
		r, err := c.Get(door + p)
		if err == nil {
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
		}
	}
	all := func(ps []string) {
		var wg sync.WaitGroup
		sem := make(chan struct{}, 6)
		for _, p := range ps {
			wg.Add(1)
			sem <- struct{}{}
			go func(p string) { defer wg.Done(); get(p); <-sem }(p)
		}
		wg.Wait()
	}
	t := time.Now()
	get("/")
	var ps []string
	for i := 0; i < files; i++ {
		ps = append(ps, fmt.Sprintf("/assets/f%d.js", i))
	}
	all(ps)
	for b := 0; b < 3; b++ {
		ps = ps[:0]
		for i := 0; i < 8; i++ {
			ps = append(ps, fmt.Sprintf("/api/x%d", i))
		}
		all(ps)
	}
	return time.Since(t)
}

func door(target *url.URL, pooled bool) (*httptest.Server, func()) {
	if pooled {
		os.Unsetenv("ADAL_DOOR_POOL")
	} else {
		os.Setenv("ADAL_DOOR_POOL", "0")
	}
	p := httputil.NewSingleHostReverseProxy(target)
	if t := doorTransport(target); t != nil {
		p.Transport = t
	} else {
		// A transport of its own with the default's settings (2 idle connections), so the two runs share nothing.
		p.Transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	p.FlushInterval = -1
	s := httptest.NewServer(p)
	return s, func() { s.Close(); os.Unsetenv("ADAL_DOOR_POOL") }
}

func TestDoorPoolLoadTime(t *testing.T) {
	if testing.Short() {
		t.Skip("timing")
	}
	big := make([]byte, 40<<10)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Millisecond)
		w.Write(big)
	})}
	// Like the server (Node's default): both IPv4 and IPv6.
	ln, err := net.Listen("tcp", "[::]:0")
	if err != nil {
		t.Skip(err)
	}
	go srv.Serve(ln)
	defer srv.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	target, _ := url.Parse(fmt.Sprintf("http://localhost:%d", port))
	median := func(pooled bool) (time.Duration, time.Duration) {
		d, stop := door(target, pooled)
		defer stop()
		var xs []time.Duration
		for i := 0; i < 25; i++ {
			xs = append(xs, loadThrough(d.URL, 60))
		}
		sort.Slice(xs, func(a, b int) bool { return xs[a] < xs[b] })
		return xs[len(xs)/2], xs[len(xs)*9/10]
	}
	m0, p0 := median(false)
	m1, p1 := median(true)
	t.Logf("before (2 kept, localhost): median %v, 90th %v", m0.Round(100*time.Microsecond), p0.Round(100*time.Microsecond))
	t.Logf("after (16 kept, 127.0.0.1): median %v, 90th %v", m1.Round(100*time.Microsecond), p1.Round(100*time.Microsecond))
}

func TestDoorPoolOffSwitch(t *testing.T) {
	u, _ := url.Parse("http://localhost:4000")
	os.Setenv("ADAL_DOOR_POOL", "0")
	defer os.Unsetenv("ADAL_DOOR_POOL")
	if doorTransport(u) != nil {
		t.Fatal("ADAL_DOOR_POOL=0 must keep Go's default transport")
	}
	os.Unsetenv("ADAL_DOOR_POOL")
	tr, ok := doorTransport(u).(*http.Transport)
	if !ok || tr.MaxIdleConnsPerHost != 16 {
		t.Fatal("16 kept connections expected")
	}
}
