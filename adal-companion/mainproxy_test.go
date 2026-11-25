package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The online pages' calls go to the main PC over the network, with this
// Companion's key; nobody else may use the way through.
func TestMainProxyCarriesTheKeyAndTheUpload(t *testing.T) {
	withTemp(t)
	var gotKey, gotBody, gotPath, gotCookie string
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath, gotCookie = r.Header.Get("x-adal-pc"), r.URL.RequestURI(), r.Header.Get("Cookie")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer main.Close()
	old := hostServer
	hostServer = main.URL
	defer func() { hostServer = old }()
	if err := saveKeys(replicaKeys{AccessKey: "the-key"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	addMainProxy(mux)

	req := httptest.NewRequest(http.MethodPost, "/local/main/profiles/7/fields/3/files?x=1", bytes.NewBufferString("photo bytes"))
	req.RemoteAddr = "127.0.0.1:5555"
	req.Header.Set("X-Adal", "1")
	req.Header.Set("Cookie", "secret=1")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated || gotKey != "the-key" || gotPath != "/api/profiles/7/fields/3/files?x=1" || gotBody != "photo bytes" || gotCookie != "" {
		t.Fatalf("code %d key %q path %q body %q cookie %q", rec.Code, gotKey, gotPath, gotBody, gotCookie)
	}
	if !strings.Contains(rec.Body.String(), "ok") || rec.Header().Get("X-Adal-Via") != "lan" {
		t.Fatalf("answer %q", rec.Body.String())
	}

	// Another computer, or a page without the header: nothing.
	for _, r := range []*http.Request{
		func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/local/main/profiles", nil)
			r.RemoteAddr = "192.168.1.9:4444"
			r.Header.Set("X-Adal", "1")
			return r
		}(),
		func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/local/main/profiles", nil)
			r.RemoteAddr = "127.0.0.1:4444"
			return r
		}(),
	} {
		gotKey = ""
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		if rec.Code != http.StatusNotFound || gotKey != "" {
			t.Fatalf("let through: %d", rec.Code)
		}
	}
}

// A live view through the Companion: each picture is there at once, not when the next one comes.
func TestMainProxyHandsOnAtOnce(t *testing.T) {
	withTemp(t)
	more := make(chan bool)
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-adal-flush") != "1" {
			t.Error("the main PC is not told that nothing is held back")
		}
		w.Write([]byte("picture"))
		w.(http.Flusher).Flush()
		<-more
	}))
	defer main.Close()
	defer close(more)
	old := hostServer
	hostServer = main.URL
	defer func() { hostServer = old }()
	if err := saveKeys(replicaKeys{AccessKey: "the-key"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	addMainProxy(mux)
	here := httptest.NewServer(mux)
	defer here.Close()
	req, _ := http.NewRequest(http.MethodGet, here.URL+"/local/main/automations/7/live", nil)
	req.Header.Set("X-Adal", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := make(chan string, 1)
	go func() {
		b := make([]byte, 7)
		io.ReadFull(resp.Body, b)
		got <- string(b)
	}()
	select {
	case s := <-got:
		if s != "picture" {
			t.Fatalf("got %q", s)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the picture was held back")
	}
}
