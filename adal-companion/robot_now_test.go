package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The main PC asks how this PC is just before a run; nobody without the token.
func TestRobotNow(t *testing.T) {
	root := t.TempDir()
	mux := http.NewServeMux()
	addRobotRoutes(mux, root)
	r := httptest.NewRequest(http.MethodGet, "/robot/now", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("without the token: %d", rec.Code)
	}
	r.Header.Set("x-adal-robot", robotToken)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	var now map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &now); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if now["cores"].(float64) < 1 || now["updating"] != false {
		t.Fatalf("%v", now)
	}
}

// Another PC's work shows nothing here, and each browser keeps a profile of the robots' own.
func TestRobotBrowserOutOfSight(t *testing.T) {
	quiet := strings.Join(robotArgs("p", true), " ")
	if !strings.Contains(quiet, "--headless=new") || strings.Contains(quiet, "--start-") {
		t.Fatal(quiet)
	}
	if strings.Contains(strings.Join(robotArgs("p", false), " "), "--headless") {
		t.Fatal("a person's own browser is on the screen")
	}
	root := t.TempDir()
	own := filepath.Join(root, "browser", "chrome.exe")
	if robotProfile(root, own) != filepath.Join(root, "robot-profile") {
		t.Fatal("Adal Browser's profile")
	}
	if robotProfile(root, filepath.Join(root, "x", "chrome.exe")) == robotProfile(root, own) || robotProfile(root, "msedge.exe") == robotProfile(root, "brave.exe") {
		t.Fatal("one profile each")
	}
	os.MkdirAll(filepath.Dir(own), 0o755)
	os.WriteFile(own, nil, 0o755)
	if robotBrowserExe(root) != own {
		t.Fatal("Adal Browser first")
	}
}
