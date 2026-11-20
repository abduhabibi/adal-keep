package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRobotNeedsTheToken(t *testing.T) {
	mux := http.NewServeMux()
	addRobotRoutes(mux, t.TempDir())
	srv := httptest.NewServer(mux)
	defer srv.Close()
	for _, p := range []string{"/robot/json/version", "/robot/file?name=a.txt", "/robot/ws/devtools/browser/x"} {
		resp, err := http.Post(srv.URL+p, "text/plain", strings.NewReader("x"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s without the token: %d", p, resp.StatusCode)
		}
	}
	// With it: a file is kept here and its path answered.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/robot/file?name="+url.QueryEscape("../../evil name.pdf"), strings.NewReader("PDF"))
	req.Header.Set("x-adal-robot", robotToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body); t.Fatalf("file: %d %s", resp.StatusCode, b)
	}
}

func TestRobotRewrite(t *testing.T) {
	got := robotRewrite("ws://127.0.0.1:9223/devtools/browser/abc", "192.168.1.20:47810")
	if got != "ws://192.168.1.20:47810/robot/ws/devtools/browser/abc" {
		t.Fatal(got)
	}
}

// TestRobotLive (ADAL_ROBOT_E2E=<file>): serves the robot routes with a real
// browser for 90 s and writes "url token" to that file, for the backend's
// end-to-end check (tests/remoteBrowser.e2e.mjs).
func TestRobotLive(t *testing.T) {
	out := os.Getenv("ADAL_ROBOT_E2E")
	if out == "" {
		t.Skip("set ADAL_ROBOT_E2E to run")
	}
	mux := http.NewServeMux()
	addRobotRoutes(mux, t.TempDir())
	srv := httptest.NewServer(mux)
	defer srv.Close()
	os.WriteFile(out, []byte(srv.URL+" "+robotToken), 0o600)
	time.Sleep(90 * time.Second)
	if robotCmd != nil && robotCmd.Process != nil {
		robotCmd.Process.Kill()
	}
}
