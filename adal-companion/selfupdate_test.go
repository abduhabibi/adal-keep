package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A manifest signed by Node (updateChannel.js canonical + crypto.sign), with
// quotes, backslashes, Amharic, U+2028 and tabs: Go must read the same text.
func TestSignatureMatchesNode(t *testing.T) {
	b, err := os.ReadFile("testdata/signed-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ Pub, Manifest, Sig, Canon string }
	json.Unmarshal(b, &v)
	text, err := canonicalJSON([]byte(v.Manifest))
	if err != nil || text != v.Canon {
		t.Fatalf("canonical differs from Node's:\n%s\n%s", text, v.Canon)
	}
	key := mustPublicKey(v.Pub)
	if _, err := verifyRelease(envelope{Manifest: json.RawMessage(v.Manifest), Signature: v.Sig}, key); err != nil {
		t.Fatal(err)
	}
	// One letter changed: refused.
	bad := strings.Replace(v.Manifest, "aaaaaaa\"", "aaaaaab\"", 1)
	if _, err := verifyRelease(envelope{Manifest: json.RawMessage(bad), Signature: v.Sig}, key); err == nil {
		t.Fatal("a changed manifest was accepted")
	}
	// The real key: a test signature is never Adal's.
	if _, err := verifyRelease(envelope{Manifest: json.RawMessage(v.Manifest), Signature: v.Sig}, updatePublicKey); err == nil {
		t.Fatal("accepted with Adal's key")
	}
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func tgz(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for n, c := range files {
		tw.WriteHeader(&tar.Header{Name: "./" + n, Mode: 0o644, Size: int64(len(c)), Typeflag: tar.TypeReg})
		tw.Write([]byte(c))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func sign(t *testing.T, priv ed25519.PrivateKey, m map[string]any) envelope {
	raw, _ := json.Marshal(m)
	text, err := canonicalJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	return envelope{Manifest: raw, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(text)))}
}

// Holds a release: current.json + its pieces, as after an install.
func holder(t *testing.T, pub ed25519.PublicKey, env envelope, pieces map[string][]byte) (*updater, string) {
	root := t.TempDir()
	u := newUpdater(root)
	u.key = pub
	os.MkdirAll(u.files(), 0o755)
	for sha, b := range pieces {
		os.WriteFile(filepath.Join(u.files(), sha), b, 0o644)
	}
	b, _ := json.Marshal(env)
	os.WriteFile(u.currentFile(), b, 0o644)
	srv := httptest.NewServer(u.handler())
	t.Cleanup(srv.Close)
	return u, srv.URL + "/lan"
}

func companionPC(t *testing.T, pub ed25519.PublicKey) *updater {
	root := t.TempDir()
	oldTag := ownAgencyTag
	ownAgencyTag = func() string { return agencyTag("47040") } // joined to one agency
	t.Cleanup(func() { ownAgencyTag = oldTag })
	os.WriteFile(filepath.Join(root, "adal-companion.exe"), []byte("old companion"), 0o755)
	os.MkdirAll(filepath.Join(root, "online"), 0o755)
	os.WriteFile(filepath.Join(root, "online", "index.html"), []byte("old pages"), 0o644)
	os.WriteFile(filepath.Join(root, "online", "config.js"), []byte("window.ADAL_CLOUD_CONFIG={}"), 0o644)
	u := newUpdater(root)
	u.key = pub
	u.built = nil
	return u
}

func release(t *testing.T, priv ed25519.PrivateKey, sha, at string, prog, pages []byte) (envelope, map[string][]byte) {
	app := []byte("the app " + sha)
	env := sign(t, priv, map[string]any{
		"sha": sha, "short": sha[:7], "file": "release/" + sha + ".tar.gz", "sha256": sum(app), "published_at": at, "everyone_at": at, "early": []string{},
		"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/c", "sha256": sum(prog), "size": len(prog)}, {"name": "adal-agent.exe", "file": "programs/a", "sha256": sum([]byte("agent")), "size": 5}},
		"online":   map[string]any{"file": "online/x.tar.gz", "sha256": sum(pages), "size": len(pages)},
	})
	return env, map[string][]byte{sum(app): app, sum(prog): prog, sum(pages): pages}
}

// Two local instances: one has a release, the other hears of it, checks it,
// installs it from that PC and then hands it on itself.
func TestReleaseSpreadsBetweenTwoPCs(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("new companion program")
	pages := tgz(t, map[string]string{"index.html": "new pages", "assets/a.js": "js"})
	env, pieces := release(t, priv, strings.Repeat("1", 40), "2026-11-19T10:00:00.000Z", prog, pages)
	_, baseA := holder(t, pub, env, pieces)

	b := companionPC(t, pub)
	// The news over UDP (on this PC: told on loopback).
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	a := newUpdater(t.TempDir())
	a.key = pub
	os.MkdirAll(a.dir(), 0o755)
	eb, _ := json.Marshal(env)
	os.WriteFile(a.currentFile(), eb, 0o644)
	sender, _ := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	a.conn = sender
	t.Setenv("ADAL_RELEASE_PEERS", conn.LocalAddr().String())
	a.announce()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 512)
	n, from, err := conn.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("no news heard: %v", err)
	}
	msg := string(buf[:n])
	if !strings.HasPrefix(msg, releaseMagic+"|"+strings.Repeat("1", 40)+"|") {
		t.Fatalf("news: %q", msg)
	}
	// B hears it (with A's HTTP address) and takes it.
	port := strings.Split(strings.TrimPrefix(baseA, "http://127.0.0.1:"), "/")[0]
	parts := strings.Split(msg, "|")
	parts[3] = port
	base, newer := b.heard(strings.Join(parts, "|"), from.IP)
	if !newer || base != baseA {
		t.Fatalf("heard: %s %v (want %s)", base, newer, baseA)
	}
	if err := b.fromPeer(base); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != string(prog) {
		t.Fatalf("program not updated: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "online", "index.html")); string(got) != "new pages" {
		t.Fatalf("pages not updated: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "online", "config.js")); !strings.Contains(string(got), "ADAL_CLOUD_CONFIG") {
		t.Fatal("this PC's config.js was lost")
	}
	if _, err := os.Stat(filepath.Join(b.root, "adal-agent.exe")); err == nil {
		t.Fatal("a program this PC does not have was added")
	}
	m, _ := b.current()
	if m == nil || m.SHA != strings.Repeat("1", 40) {
		t.Fatal("not kept to hand on")
	}
	// B now hands it on: a third PC gets it from B.
	srvB := httptest.NewServer(b.handler())
	defer srvB.Close()
	time.Sleep(200 * time.Millisecond) // the app piece is fetched in the background
	c := companionPC(t, pub)
	if err := c.fromPeer(srvB.URL + "/lan"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(c.root, "adal-companion.exe")); string(got) != string(prog) {
		t.Fatal("not handed on")
	}
	// The same sha again: nothing is fetched (no loop).
	if _, newer := b.heard(msg, net.IPv4(10, 0, 0, 9)); newer {
		t.Fatal("the same release counted as newer")
	}
}

func TestNothingUnsignedOrChangedIsInstalled(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("new companion program")
	pages := tgz(t, map[string]string{"index.html": "new pages"})

	// Signed by someone else (a peer that holds it with that key).
	env, pieces := release(t, other, strings.Repeat("2", 40), "2026-11-19T11:00:00.000Z", prog, pages)
	_, base := holder(t, other.Public().(ed25519.PublicKey), env, pieces)
	b := companionPC(t, pub)
	if err := b.fromPeer(base); err == nil || !strings.Contains(err.Error(), "not signed") {
		t.Fatalf("unsigned: %v", err)
	}
	// Signed, but the peer's program was changed.
	env2, pieces2 := release(t, priv, strings.Repeat("3", 40), "2026-11-19T12:00:00.000Z", prog, pages)
	pieces2[sum(prog)] = []byte("evil program")
	_, base2 := holder(t, pub, env2, pieces2)
	if err := b.fromPeer(base2); err == nil {
		t.Fatal("a changed program was installed")
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != "old companion" {
		t.Fatalf("program touched: %q", got)
	}
	if m, _ := b.current(); m != nil {
		t.Fatal("recorded a release that did not install")
	}
}

func TestStagedReleaseWaitsItsTurn(t *testing.T) {
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	m := &releaseManifest{EveryoneAt: later, Early: []string{"agency-1"}}
	if itsTurn(m, "agency-2", time.Now()) || !itsTurn(m, "agency-1", time.Now()) {
		t.Fatal("staging")
	}
}

func rel(sha, published, date string) *releaseManifest {
	return &releaseManifest{SHA: strings.Repeat(sha, 40)[:40], PublishedAt: published, Date: date}
}

// "It is just downgrading" (2026-11-19): only ever forward.
func TestReleaseOrderOnlyForward(t *testing.T) {
	a := rel("a", "2026-11-19T11:00:00.000Z", "2026-11-19T13:00:00+03:00")
	if !isNewerRelease(rel("b", "2026-11-19T12:00:00.000Z", "2026-11-19T14:00:00+03:00"), a) {
		t.Fatal("newer")
	}
	if isNewerRelease(rel("b", "2026-11-19T10:00:00.000Z", "2026-11-19T12:00:00+03:00"), a) {
		t.Fatal("older counted as newer")
	}
	// Published later but older code: not taken (unless a deliberate rollback).
	old := rel("b", "2026-11-19T12:00:00.000Z", "2026-11-18T09:00:00Z")
	if isNewerRelease(old, a) {
		t.Fatal("older commit taken")
	}
	old.RollbackOf = a.SHA
	if !isNewerRelease(old, a) {
		t.Fatal("Adal's rollback refused")
	}
	// The sequence wins over the clock.
	x, y := rel("c", "2026-11-19T09:00:00Z", ""), rel("d", "2026-11-19T10:00:00Z", "")
	x.Seq, y.Seq = 5, 4
	if !isNewerRelease(x, y) || isNewerRelease(y, x) {
		t.Fatal("seq")
	}
	// A USB install: only the build's commit date is known.
	built := &releaseManifest{SHA: strings.Repeat("e", 40), Date: "2026-11-19T10:00:00Z"}
	if isNewerRelease(rel("f", "2026-11-19T09:00:00Z", "2026-11-18T10:00:00Z"), built) {
		t.Fatal("older than the build taken")
	}
	if isNewerRelease(&releaseManifest{SHA: strings.Repeat("f", 40), PublishedAt: "2026-11-19T09:00:00Z"}, built) {
		t.Fatal("news of an older publish counted as newer")
	}
	if !isNewerRelease(rel("f", "2026-11-19T11:00:00Z", "2026-11-19T10:30:00Z"), built) {
		t.Fatal("newer than the build refused")
	}
	// The same release, short or long: never again. Unknown order: never.
	if isNewerRelease(&releaseManifest{SHA: a.SHA[:7]}, a) || isNewerRelease(&releaseManifest{SHA: strings.Repeat("9", 40)}, a) {
		t.Fatal("same / unknown")
	}
}

// A Companion installed from a newer USB build than the main PC's release
// never takes the main PC's older one; it does take a newer one.
func TestCompanionNeverTakesMainsOlderRelease(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("main's older companion")
	pages := tgz(t, map[string]string{"index.html": "older pages"})
	env, pieces := sign2(t, priv, strings.Repeat("7", 40), "2026-11-18T10:00:00.000Z", "2026-11-18T09:00:00Z", prog, pages)
	_, base := holder(t, pub, env, pieces)
	b := companionPC(t, pub)
	b.built = &releaseManifest{SHA: strings.Repeat("c", 40), Date: "2026-11-19T08:00:00Z"}
	if _, newer := b.heard(releaseMagic+"|"+strings.Repeat("7", 40)+"|2026-11-18T10:00:00.000Z|47810|/lan|"+ownAgencyTag(), net.IPv4(10, 0, 0, 9)); newer {
		t.Fatal("heard an older release as newer")
	}
	if err := b.fromPeer(base); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != "old companion" {
		t.Fatalf("downgraded: %q", got)
	}
	// Even install() itself refuses it (every path goes through it).
	m, _ := verifyRelease(env, pub)
	if err := b.install(m, &env, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != "old companion" {
		t.Fatal("install() downgraded")
	}
	// A newer one is taken.
	prog2 := []byte("newer companion")
	env2, pieces2 := sign2(t, priv, strings.Repeat("8", 40), "2026-11-19T12:00:00.000Z", "2026-11-19T11:00:00Z", prog2, pages)
	_, base2 := holder(t, pub, env2, pieces2)
	if err := b.fromPeer(base2); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != string(prog2) {
		t.Fatalf("newer not taken: %q", got)
	}
	// Then the older one again (main PC still on it): refused.
	if err := b.fromPeer(base); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != string(prog2) {
		t.Fatal("went back")
	}
}

func sign2(t *testing.T, priv ed25519.PrivateKey, sha, at, date string, prog, pages []byte) (envelope, map[string][]byte) {
	app := []byte("the app " + sha)
	env := sign(t, priv, map[string]any{
		"sha": sha, "short": sha[:7], "date": date, "file": "release/" + sha + ".tar.gz", "sha256": sum(app), "published_at": at, "everyone_at": at, "early": []string{},
		"programs": []map[string]any{{"name": "adal-companion.exe", "file": "programs/c", "sha256": sum(prog), "size": len(prog)}},
		"online":   map[string]any{"file": "online/x.tar.gz", "sha256": sum(pages), "size": len(pages)},
	})
	return env, map[string][]byte{sum(app): app, sum(prog): prog, sum(pages): pages}
}
