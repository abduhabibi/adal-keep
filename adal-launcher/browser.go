//go:build windows

// browser.go — Adal Browser, and which browser opens Adal Keep.
//
// Adal Browser is Adal Keep's own Chromium: <install>\browser\AdalBrowser.exe,
// fetched once by ensureBrowser (ungoogled-chromium, pinned to one checked
// file). Until it is there, or if it cannot be fetched, a browser already on
// the PC is used the same way (Edge is on every Windows 10/11).
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

// appPath: where Windows says an installed program is (App Paths).
func appPath(exe string) string {
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		k, err := registry.OpenKey(root, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`+exe, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("")
		k.Close()
		v = strings.Trim(v, `"`)
		if err == nil && fileExists(v) {
			return v
		}
	}
	return ""
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if p != "" && fileExists(p) {
			return p
		}
	}
	return ""
}

func braveExe() string {
	return firstExisting(
		filepath.Join(os.Getenv("ProgramFiles"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		appPath("brave.exe"),
	)
}

// otherChromium: Chrome or Edge (Edge is on every Windows 10/11).
func otherChromium() string {
	return firstExisting(
		filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "Application", "chrome.exe"),
		appPath("chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
		appPath("msedge.exe"),
	)
}

// pickBrowser: Adal Browser, else one already on this PC.
func pickBrowser() string {
	if b := adalBrowser(installRoot); fileExists(b) {
		return b
	}
	if b := braveExe(); b != "" {
		return b
	}
	if b := otherChromium(); b != "" {
		logf("Adal Browser not here yet — using %s", b)
		return b
	}
	logf("no browser found — opening the default browser")
	return ""
}

const (
	browserVersion = "156.0.8078.79-1.1"
	browserURL     = "https://github.com/ungoogled-software/ungoogled-chromium-windows/releases/download/" + browserVersion + "/ungoogled-chromium_" + browserVersion + "_windows_x64.zip"
	browserSHA     = "a97c5378e16075967660f85cc34150444a9cfbc79733f048b9c6b42a851e4eb9"
)

var installRoot string

func adalBrowser(root string) string { return filepath.Join(root, "browser", "AdalBrowser.exe") }

// ensureBrowser fetches Adal Browser when it is missing, in the background,
// trying again every minute until it is there.
func ensureBrowser(root string) {
	for !fileExists(adalBrowser(root)) {
		logf("fetching Adal Browser %s", browserVersion)
		if err := fetchBrowser(root); err != nil {
			logf("Adal Browser: %v — trying again in a minute", err)
			time.Sleep(time.Minute)
			continue
		}
		logf("Adal Browser is ready")
	}
}

func fetchBrowser(root string) error {
	// Goes on where it stopped: a slow line drops long downloads.
	part := filepath.Join(root, "browser.zip.part")
	var have int64
	if st, err := os.Stat(part); err == nil {
		have = st.Size()
	}
	req, err := http.NewRequest(http.MethodGet, browserURL, nil)
	if err != nil {
		return err
	}
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	switch resp.StatusCode {
	case http.StatusPartialContent:
		flags |= os.O_APPEND
	case http.StatusOK:
		flags |= os.O_TRUNC
	case http.StatusRequestedRangeNotSatisfiable: // already whole
	default:
		return fmt.Errorf("download: %s", resp.Status)
	}
	if resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		f, err := os.OpenFile(part, flags, 0o644)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, resp.Body)
		f.Close()
		if err != nil {
			return err // the next try goes on from here
		}
	}
	f, err := os.Open(part)
	if err != nil {
		return err
	}
	sum := sha256.New()
	_, err = io.Copy(sum, f)
	f.Close()
	if err != nil {
		return err
	}
	if hex.EncodeToString(sum.Sum(nil)) != browserSHA {
		os.Remove(part)
		return fmt.Errorf("the download is damaged")
	}
	defer os.Remove(part)
	tmp := filepath.Join(root, "browser.new")
	os.RemoveAll(tmp)
	defer os.RemoveAll(tmp)
	z, err := zip.OpenReader(part)
	if err != nil {
		return err
	}
	defer z.Close()
	// Everything sits in one folder inside the zip: the one holding chrome.exe.
	prefix := ""
	for _, e := range z.File {
		if strings.EqualFold(filepath.Base(e.Name), "chrome.exe") {
			prefix = strings.TrimSuffix(e.Name, filepath.Base(e.Name))
			break
		}
	}
	for _, e := range z.File {
		name := strings.TrimPrefix(e.Name, prefix)
		if name == "" || !strings.HasPrefix(e.Name, prefix) || strings.Contains(name, "..") {
			continue
		}
		to := filepath.Join(tmp, filepath.FromSlash(name))
		if e.FileInfo().IsDir() {
			os.MkdirAll(to, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(to), 0o755)
		in, err := e.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(to)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		out.Close()
		in.Close()
		if err != nil {
			return err
		}
	}
	if err := os.Rename(filepath.Join(tmp, "chrome.exe"), filepath.Join(tmp, "AdalBrowser.exe")); err != nil {
		return err
	}
	os.RemoveAll(filepath.Join(root, "browser"))
	return os.Rename(tmp, filepath.Join(root, "browser"))
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
