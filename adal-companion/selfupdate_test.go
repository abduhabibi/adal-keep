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

// Supabase holding a release (a fake on this PC): latest.json and its pieces by
// name (the manifest names each piece's file). Since 2026-11-23 Supabase is the
// only place a PC updates from.
func holder(t *testing.T, pub ed25519.PublicKey, env envelope, pieces map[string][]byte) (*updater, string) {
	var m struct {
		File     string `json:"file"`
		SHA256   string `json:"sha256"`
		Programs []struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256"`
		} `json:"programs"`
		ProgramsX86 []struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256"`
		} `json:"programs_x86"`
		Online *struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256"`
		} `json:"online"`
	}
	json.Unmarshal(env.Manifest, &m)
	byFile := map[string][]byte{m.File: pieces[m.SHA256]}
	for _, p := range append(m.Programs, m.ProgramsX86...) {
		byFile[p.File] = pieces[p.SHA256]
	}
	if m.Online != nil {
		byFile[m.Online.File] = pieces[m.Online.SHA256]
	}
	srv := fakeCloud(t, env, byFile)
	return nil, srv.URL
}

// fromHere: this Companion's online account points at that (fake) Supabase, and it updates from it.
func fromHere(u *updater, cloudURL string) error {
	cj, _ := json.Marshal(cloudCreds{URL: cloudURL, Anon: "anon", Email: "c@x", Password: "p"})
	os.WriteFile(filepath.Join(u.root, "companion-cloud.json"), cj, 0o600)
	return u.fromCloud()
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

func TestNothingUnsignedOrChangedIsInstalled(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("new companion program")
	pages := tgz(t, map[string]string{"index.html": "new pages"})

	// Signed by someone else (Supabase answering with it).
	env, pieces := release(t, other, strings.Repeat("2", 40), "2026-11-19T11:00:00.000Z", prog, pages)
	_, base := holder(t, other.Public().(ed25519.PublicKey), env, pieces)
	b := companionPC(t, pub)
	if err := fromHere(b, base); err == nil || !strings.Contains(err.Error(), "not signed") {
		t.Fatalf("unsigned: %v", err)
	}
	// Signed, but the program on Supabase was changed.
	env2, pieces2 := release(t, priv, strings.Repeat("3", 40), "2026-11-19T12:00:00.000Z", prog, pages)
	pieces2[sum(prog)] = []byte("evil program")
	_, base2 := holder(t, pub, env2, pieces2)
	if err := fromHere(b, base2); err == nil {
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
func TestCompanionNeverTakesAnOlderRelease(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("main's older companion")
	pages := tgz(t, map[string]string{"index.html": "older pages"})
	env, pieces := sign2(t, priv, strings.Repeat("7", 40), "2026-11-18T10:00:00.000Z", "2026-11-18T09:00:00Z", prog, pages)
	_, base := holder(t, pub, env, pieces)
	b := companionPC(t, pub)
	b.built = &releaseManifest{SHA: strings.Repeat("c", 40), Date: "2026-11-19T08:00:00Z"}
	if err := fromHere(b, base); err != nil {
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
	if err := fromHere(b, base2); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b.root, "adal-companion.exe")); string(got) != string(prog2) {
		t.Fatalf("newer not taken: %q", got)
	}
	// Then the older one again: refused.
	if err := fromHere(b, base); err != nil {
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

// "Go back to previous version" (2026-11-22): release X carries, inside its
// signed manifest, a signed way back to Y (rollback_of X, seq just after X).
// The Companion verifies both, takes the way back from X (even when it only
// knows X by its USB build), never takes X again, and takes the next release.
func TestSignedWayBackFromTheMainPC(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	y := strings.Repeat("1", 40)
	x := strings.Repeat("2", 40)
	back := map[string]any{"sha": y, "short": y[:7], "file": "release/" + y + ".tar.gz", "sha256": sum([]byte("y")), "date": "2026-11-20T10:00:00+03:00",
		"published_at": "2026-11-21T10:00:00.001Z", "seq": 1763719200001, "rollback_of": x, "early": []string{},
		"migrations": []string{"001_a.js"}, "notes": []string{"Went back — “quotes”, ኣማርኛ & more"}}
	wb := sign(t, priv, back)
	var wbm any
	json.Unmarshal(wb.Manifest, &wbm)
	xenv := sign(t, priv, map[string]any{"sha": x, "short": x[:7], "date": "2026-11-21T09:00:00+03:00", "published_at": "2026-11-21T10:00:00.000Z", "seq": 1763719200000,
		"notes": []string{"New: one", "two", "three"}, "rollback": map[string]any{"manifest": wbm, "signature": wb.Signature}})
	xm, err := verifyRelease(xenv, pub)
	if err != nil {
		t.Fatal(err)
	}
	var outer struct {
		Rollback envelope `json:"rollback"`
	}
	json.Unmarshal(xenv.Manifest, &outer)
	rm, err := verifyRelease(outer.Rollback, pub)
	if err != nil {
		t.Fatal("the nested way back does not verify:", err)
	}
	if !isNewerRelease(rm, xm) || isNewerRelease(xm, rm) {
		t.Fatal("the way back must win over X, and X must not come back")
	}
	if !isNewerRelease(rm, &releaseManifest{SHA: x, Date: "2026-11-21T09:00:00+03:00"}) {
		t.Fatal("a Companion knowing X only by its build refused the way back")
	}
	z := &releaseManifest{SHA: strings.Repeat("3", 40), Date: "2026-11-22T09:00:00+03:00", PublishedAt: "2026-11-22T10:00:00Z", Seq: 1763805600000}
	if !isNewerRelease(z, rm) || isNewerRelease(rm, z) {
		t.Fatal("the next release must move it forward")
	}
	// Another release's way back (not X's) is just an older commit.
	other := *rm
	other.RollbackOf = strings.Repeat("4", 40)
	if isNewerRelease(&other, z) {
		t.Fatal("a way back from another release went back")
	}
}
