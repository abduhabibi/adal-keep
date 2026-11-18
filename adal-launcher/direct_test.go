//go:build windows

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrivateAddr(t *testing.T) {
	ok := map[string]string{
		"192.168.1.5:4000": "http://192.168.1.5:4000",
		"10.0.0.2":         "http://10.0.0.2:4000",
		"100.101.1.2:4000": "http://100.101.1.2:4000",
		"172.20.3.4:4100":  "http://172.20.3.4:4100",
	}
	for in, want := range ok {
		if got := privateAddr(in); got != want {
			t.Errorf("%s: got %q want %q", in, got, want)
		}
	}
	for _, bad := range []string{"8.8.8.8:4000", "example.com:4000", "1.2.3.4", "192.168.1.5:99999", "", "[fe80::1]:4000"} {
		if got := privateAddr(bad); got != "" {
			t.Errorf("%s should be refused, got %q", bad, got)
		}
	}
}

func fakeKeep(service string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/companion/info" {
			w.Write([]byte(`{"service":"` + service + `"}`))
			return
		}
		http.NotFound(w, r)
	}))
}

func TestFindMainPCFromTheMainPCsList(t *testing.T) {
	root := t.TempDir()
	os.Unsetenv("ADAL_HOST_URL")
	keep, other := fakeKeep("adal-keep"), fakeKeep("something-else")
	defer keep.Close()
	defer other.Close()
	a := strings.TrimPrefix(keep.URL, "http://")
	b := strings.TrimPrefix(other.URL, "http://")
	start := time.Now()
	got := findMainPC(root, "10.255.255.1:4000,"+b+","+a)
	if got != keep.URL {
		t.Fatalf("got %q want %q", got, keep.URL)
	}
	if time.Since(start) > 2500*time.Millisecond {
		t.Errorf("too slow: %v", time.Since(start))
	}
	if mainPCURL(root) != keep.URL {
		t.Errorf("not saved for the Companion: %q", mainPCURL(root))
	}
}

func TestTypedAddressIsKept(t *testing.T) {
	root := t.TempDir()
	os.Unsetenv("ADAL_HOST_URL")
	keep := fakeKeep("adal-keep")
	defer keep.Close()
	saveTypedMainURL(root, "http://192.168.50.50:4000")
	if got := findMainPC(root, strings.TrimPrefix(keep.URL, "http://")); got != keep.URL {
		t.Fatalf("got %q", got)
	}
	b, _ := os.ReadFile(filepath.Join(root, "companion.conf"))
	if !strings.Contains(string(b), "192.168.50.50") {
		t.Errorf("a typed address was overwritten")
	}
}

func TestNothingAnswers(t *testing.T) {
	root := t.TempDir()
	os.Unsetenv("ADAL_HOST_URL")
	if got := findMainPC(root, "8.8.8.8:4000,10.255.255.1:4000"); got != "" {
		t.Fatalf("got %q", got)
	}
}
