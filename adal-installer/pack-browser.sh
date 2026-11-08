#!/usr/bin/env bash
# =====================================================================
#  Adal Browser for the USB and the internet install.
#  Takes the pinned Chromium build (the same one adal-launcher fetches),
#  checks it, names it AdalBrowser.exe, gives it the Adal Keep logo and packs
#  it as deps/adal-browser.zip with one top folder: browser\
#
#  Usage: pack-browser.sh <deps-folder>   (needs curl, unzip, zip, wine)
# =====================================================================
set -euo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$1"
OUT="$DEPS/adal-browser.zip"
VERSION=$(sed -n 's/.*browserVersion = "\(.*\)"/\1/p' "$BASE/adal-launcher/browser.go")
SHA=$(sed -n 's/.*browserSHA .*= "\(.*\)"/\1/p' "$BASE/adal-launcher/browser.go")
[ -f "$OUT" ] && [ "$(cat "$DEPS/adal-browser.version" 2>/dev/null)" = "$VERSION" ] && { echo "   Adal Browser $VERSION already packed"; exit 0; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
ZIP="${ADAL_BROWSER_ZIP:-$WORK/chromium.zip}"
[ -f "$ZIP" ] || curl -L --fail --retry 5 -C - -o "$ZIP" "https://github.com/ungoogled-software/ungoogled-chromium-windows/releases/download/$VERSION/ungoogled-chromium_${VERSION}_windows_x64.zip"
echo "$SHA  $ZIP" | sha256sum -c --quiet
unzip -q "$ZIP" -d "$WORK/x"
mv "$(dirname "$(find "$WORK/x" -name chrome.exe | head -1)")" "$WORK/browser"
mv "$WORK/browser/chrome.exe" "$WORK/browser/AdalBrowser.exe"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) "$BASE/adal-installer/tools/seticon.exe" "$WORK/browser/AdalBrowser.exe" "$BASE/adal.ico" | tr -d '\r' ;;
  *) WINEDEBUG=-all wine "$BASE/adal-installer/tools/seticon.exe" "$WORK/browser/AdalBrowser.exe" "$BASE/adal.ico" | tr -d '\r' ;;
esac
rm -f "$OUT"
( cd "$WORK" && zip -q -r -9 "$OUT.tmp.zip" browser ) && mv "$OUT.tmp.zip" "$OUT"
echo "$VERSION" > "$DEPS/adal-browser.version"
echo "   Adal Browser $VERSION: $(du -h "$OUT" | cut -f1)"
