package main

// A release seeded on ONE Companion (manifest.audience): Supabase hands it only to that
// PC; the other Companions get it from it over the office network, signed and checked.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAudienceAllows(t *testing.T) {
	if !audienceAllows(&releaseManifest{}, "pc-a") {
		t.Fatal("no audience: everyone")
	}
	m := &releaseManifest{Audience: &audience{PCs: []string{"seed-pc"}}}
	if !audienceAllows(m, "SEED-PC") || audienceAllows(m, "other") {
		t.Fatal("only the named PC (any case)")
	}
}

func TestSeededReleaseReachesTheOthersOverTheOffice(t *testing.T) {
	fastDownloads(t)
	t.Setenv("ADAL_RELEASE_PEERS", "test") // loopback PCs count as other PCs here
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	prog := []byte("the seeded companion program")
	sha := strings.Repeat("7", 40)
	env, _, byFile := fullRelease(t, priv, sha, 20, prog)
	// the same release, with an audience of one PC
	var raw map[string]any
	json.Unmarshal(env.Manifest, &raw)
	raw["audience"] = map[string]any{"pcs": []string{"seed-pc"}}
	env = sign(t, priv, raw)
	cloud := fakeCloud(t, env, byFile)
	cj, _ := json.Marshal(cloudCreds{URL: cloud.URL, Anon: "anon", Email: "c@x", Password: "p"})

	oldHost := ownHost
	t.Cleanup(func() { ownHost = oldHost })

	seed := companionPC(t, pub)
	os.WriteFile(filepath.Join(seed.root, "companion-cloud.json"), cj, 0o600)
	other := companionPC(t, pub)
	os.WriteFile(filepath.Join(other.root, "companion-cloud.json"), cj, 0o600)

	// Supabase: the other PC is not in the audience and takes nothing; the seed does.
	ownHost = func() string { return "other-pc" }
	if err := other.fromCloud(); err != nil {
		t.Fatal(err)
	}
	if cur, _ := other.current(); cur != nil {
		t.Fatal("a PC outside the audience took the release from Supabase")
	}
	ownHost = func() string { return "Seed-PC" }
	if err := seed.fromCloud(); err != nil {
		t.Fatal(err)
	}
	m, _ := seed.current()
	if m == nil || m.SHA != sha {
		t.Fatalf("the seeded PC did not install: %+v", m)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !seed.complete(m) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	// The seed hands it on over the office: the other PC (its handler) is told, and takes it from the seed.
	seedSrv := httptest.NewServer(seed.handler())
	defer seedSrv.Close()
	otherSrv := httptest.NewServer(other.handler())
	defer otherSrv.Close()
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(otherSrv.URL, "http://"))
	p, _ := strconv.Atoi(port)
	rememberPeers([]officePeer{{Name: "other-pc", IP: host, Port: p}})
	t.Cleanup(func() { rememberPeers(nil) })
	// the offer carries the seed's address (its own LAN port): point it at the test server
	_, seedPort, _ := net.SplitHostPort(strings.TrimPrefix(seedSrv.URL, "http://"))
	oldPort := lanHTTPPort
	sp, _ := strconv.Atoi(seedPort)
	lanHTTPPort = sp
	t.Cleanup(func() { lanHTTPPort = oldPort })

	if n := seed.offerToPeers(); n != 1 {
		t.Fatalf("offers to the other Companions: %d", n)
	}
	if !waitFile(filepath.Join(other.root, "adal-companion.exe"), string(prog)) {
		t.Fatal("the other PC did not take the release from the seed over the office network")
	}
	var om *releaseManifest
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if om, _ = other.current(); om != nil {
			break
		}
	}
	if om == nil || om.SHA != sha {
		t.Fatalf("the other PC's release: %+v", om)
	}
	// Told once per release; and a PC that has it is not asked again.
	if n := seed.offerToPeers(); n != 0 {
		t.Fatalf("offered again: %d", n)
	}
}
