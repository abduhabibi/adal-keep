package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The newest watcher is started (each version has its own name).
func TestNewestClip(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	for _, f := range []string{filepath.Join(a, "adal-clip.exe"), filepath.Join(a, "adal-clip-3.exe"), filepath.Join(b, "adal-clip-12.exe"), filepath.Join(b, "other.exe")} {
		os.WriteFile(f, []byte("x"), 0o755)
	}
	if got := newestClip(a, b, filepath.Join(a, "none")); filepath.Base(got) != "adal-clip-12.exe" {
		t.Fatalf("got %q", got)
	}
	if newestClip(t.TempDir()) != "" {
		t.Fatal("none there: nothing")
	}
}

// It sends through this program's door to the main PC; --beat only for a watcher that knows it.
func TestClipArgsAndSwitch(t *testing.T) {
	a := strings.Join(clipArgs(true), " ")
	if !strings.Contains(a, "--server http://127.0.0.1:47810/local/main") || !strings.Contains(a, "--beat 45s") || !strings.Contains(a, "--parent ") {
		t.Fatalf("args %q", a)
	}
	if strings.Contains(strings.Join(clipArgs(false), " "), "--beat") {
		t.Fatal("an older watcher gets no --beat")
	}
	old := hostServer
	defer func() { hostServer = old }()
	hostServer = "http://192.168.1.8:4000"
	if !clipWanted() {
		t.Fatal("a Companion with a main PC: the watcher runs here")
	}
	t.Setenv("ADAL_COMPANION_CLIP", "0")
	if clipWanted() {
		t.Fatal("ADAL_COMPANION_CLIP=0: off")
	}
	os.Unsetenv("ADAL_COMPANION_CLIP")
	hostServer = ""
	if clipWanted() {
		t.Fatal("no main PC: nothing to send to")
	}
}

// What the watcher sends (adal-clip tell / sendPNG: X-Adal: 1) reaches the main PC's /api/app/clip
// with this Companion's key: "the watcher runs" and the picture, as an image.
func TestClipReachesTheMainPC(t *testing.T) {
	withTemp(t)
	type got struct{ path, key, ctype, body string }
	var seen []got
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seen = append(seen, got{r.URL.RequestURI(), r.Header.Get("x-adal-pc"), r.Header.Get("Content-Type"), string(b)})
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"pages":1}`))
	}))
	defer main.Close()
	old := hostServer
	hostServer = main.URL
	defer func() { hostServer = old }()
	if err := saveKeys(replicaKeys{AccessKey: "companion-key"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	addMainProxy(mux)
	send := func(path, ctype string, body []byte, xadal bool) int {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:5000"
		if xadal {
			req.Header.Set("X-Adal", "1")
		}
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := send("/local/main/app/clip?state=hook", "", nil, true); c != 200 {
		t.Fatalf("hook: %d", c)
	}
	if c := send("/local/main/app/clip", "image/png", []byte("PNG bytes"), true); c != 200 {
		t.Fatalf("picture: %d", c)
	}
	if len(seen) != 2 || seen[0].path != "/api/app/clip?state=hook" || seen[0].key != "companion-key" ||
		seen[1].path != "/api/app/clip" || seen[1].ctype != "image/png" || seen[1].body != "PNG bytes" || seen[1].key != "companion-key" {
		t.Fatalf("main PC saw %+v", seen)
	}
	// Without X-Adal (an older watcher): refused here, nothing reaches the main PC.
	if c := send("/local/main/app/clip?state=hook", "", nil, false); c == 200 || len(seen) != 2 {
		t.Fatalf("no X-Adal: %d, %d calls", c, len(seen))
	}
}
