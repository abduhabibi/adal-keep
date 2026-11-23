package main

// A release seeded on ONE PC (manifest.audience): Supabase hands it only to that PC;
// the others get it from Supabase when Adal opens it (no PC hands it on since 2026-11-23).

import (
	"testing"
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
