package main

import (
	"os"
	"path/filepath"
)

// doorArgs: on a Companion the window asks the main PC through adal-companion.exe's door on this PC
// (adal-companion/owndocs.go): the photos, documents and pages used here come from this PC's own
// disk. Only plain http; with the program away the window goes to the main PC directly (Chromium's own
// fallback, "direct://"). This PC's own pages (127.0.0.1) never go through it. Off: ADAL_OWN_DOCS=0.
func doorArgs(root string) []string {
	if os.Getenv("ADAL_OWN_DOCS") == "0" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(root, "runtime", "node.exe")); err == nil {
		return nil // a main PC
	}
	port := os.Getenv("ADAL_OWN_PORT")
	if port == "" {
		port = "47812" // ownPort, owndocs.go
	}
	return []string{"--proxy-server=http=127.0.0.1:" + port + ",direct://"}
}
