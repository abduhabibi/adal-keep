package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSupportOriginOK(t *testing.T) {
	for o, want := range map[string]bool{
		"http://127.0.0.1:4000": true, "http://localhost:4000": true, "http://192.168.1.6:4000": true,
		"http://10.0.0.2:4000": true, "http://evil.example.com": false, "https://8.8.8.8": false, "http://8.8.8.8:4000": false,
	} {
		if supportOriginOK(o) != want {
			t.Errorf("%s: want %v", o, want)
		}
	}
}

func TestSupportSwitch(t *testing.T) {
	h := http.HandlerFunc(supportHandler)
	req := httptest.NewRequest("POST", "/support", strings.NewReader(`{"on":false}`))
	req.RemoteAddr = "8.8.8.8:1"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("a request from the network must be refused, got %d", rec.Code)
	}
	req = httptest.NewRequest("POST", "/support", strings.NewReader(`{"on":false}`))
	req.RemoteAddr = "127.0.0.1:1"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("a POST without X-Adal must be refused, got %d", rec.Code)
	}
	req = httptest.NewRequest("POST", "/support", strings.NewReader(`{"on":false}`))
	req.RemoteAddr = "127.0.0.1:1"
	req.Header.Set("Origin", "http://evil.example.com")
	req.Header.Set("X-Adal", "1")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("a foreign origin must be refused, got %d", rec.Code)
	}
}
