#!/bin/sh
# Puts "FIX THIS PC" on Adal's USB with the release published now (Supabase release/latest.json,
# every piece checked against Adal's signature by release-bundle.mjs).
#   sh adal-installer/usb/fix-this-pc/build.sh "/media/$USER/ADAL KEEP"
# Needs adal-admin/.env (the service key) in this checkout. Keeps the USB's logs\.
set -e
USB="$1"; [ -d "$USB" ] || { echo "usage: build.sh <USB folder>"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="$USB/FIX THIS PC"
TMP="$(mktemp -d)"
node "$ROOT/adal-keep-backend/scripts/release-bundle.mjs" "$TMP/release.zip"
mkdir -p "$OUT/logs"
rm -rf "$OUT/release.new"; mkdir -p "$OUT/release.new"
unzip -q "$TMP/release.zip" -d "$OUT/release.new"
[ -f "$OUT/release.new/current.json" ] || { echo "the bundle has no current.json"; exit 1; }
rm -rf "$OUT/release"; mv "$OUT/release.new" "$OUT/release"
cp "$HERE/Fix this PC.cmd" "$HERE/fix-this-pc.ps1" "$HERE/fix-runs.mjs" "$OUT/"
node -e "const j=require(process.argv[1]); console.log('release on the USB:', j.manifest.short, j.manifest.published_at)" "$OUT/release/current.json" | tee "$OUT/release/VERSION.txt"
sync
rm -rf "$TMP"
echo "OK: $OUT"
