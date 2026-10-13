#!/usr/bin/env bash
# =====================================================================
#  Adal Keep - one-shot build of the USB installer
#
#  Result:
#     "<repo>/Adal Keep Main/AdalKeep-Setup.exe"   <- hand this USB stick out
#     "<repo>/Adal Keep Main/README-USB.txt"
#
#  Requires: node, npm, go, makensis (nsis), rsync
#  Optional env: SKIP_FRONTEND=1  (reuse the existing dist/)
# =====================================================================
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST="$BASE/adal-installer"
BUNDLE="$INST/bundle"
USB="$BASE/Adal Keep Main"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' is not installed"; exit 1; }; }
need makensis
need go

echo "== [1/7] Frontend =="
if [ "${SKIP_FRONTEND:-0}" = "1" ]; then
  echo "   skipped (SKIP_FRONTEND=1)"
else
  ( cd "$BASE/adal-keep-frontend" && npm run build )
fi
rsync -a --delete "$BASE/adal-keep-frontend/dist/" "$BUNDLE/frontend/"

echo "== [2/7] Backend sources (node_modules stay as shipped) =="
rsync -a --delete \
  --exclude node_modules --exclude data --exclude uploads \
  --exclude '*.sqlite' --exclude '*.sqlite-journal' --exclude .env \
  "$BASE/adal-keep-backend/src/" "$BUNDLE/backend/src/"
for f in server.js package.json knexfile.js .env; do
  if [ -f "$BASE/adal-keep-backend/$f" ]; then
    cp -f "$BASE/adal-keep-backend/$f" "$BUNDLE/backend/$f"
  fi
done

echo "== [3/7] Go binaries (windows/amd64) =="
( cd "$BASE/adal-launcher"  && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUNDLE/AdalKeep.exe" . )
( cd "$BASE/adal-companion" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUNDLE/adal-companion.exe" . )
cp -f "$BUNDLE/adal-companion.exe" "$BASE/adal-companion-dist/adal-companion.exe"
if command -v file >/dev/null 2>&1; then
  file "$BUNDLE/AdalKeep.exe" "$BUNDLE/adal-companion.exe" | sed 's/^/   /'
fi

echo "== [4/7] Windows node modules sanity =="
SQLITE="$BUNDLE/backend/node_modules/sqlite3/build/Release/node_sqlite3.node"
if [ -f "$SQLITE" ]; then
  if command -v file >/dev/null 2>&1; then
    file "$SQLITE" | grep -q 'MS Windows' \
      && echo "   OK  sqlite3 native binding is a Windows DLL" \
      || echo "   WARN sqlite3 native binding is not a Windows binary"
  else
    echo "   OK  sqlite3 native binding present"
  fi
else
  echo "   WARN sqlite3 native binding missing"
fi
if [ -d "$BUNDLE/backend/node_modules/@img/sharp-win32-x64" ]; then
  echo "   OK  @img/sharp-win32-x64 present"
else
  echo "   note sharp win32 runtime absent (sharp is not required by the backend)"
fi

echo "== [5/7] Compiling the installer =="
( cd "$INST" && makensis -V2 installer.nsi )
ls -lh "$INST/AdalKeep-Setup.exe" | sed 's/^/   /'

echo "== [6/7] Assembling the USB folder =="
rm -rf "$USB"
mkdir -p "$USB"
cp -f "$INST/AdalKeep-Setup.exe" "$USB/AdalKeep-Setup.exe"
cp -f "$INST/README-USB.txt"     "$USB/README-USB.txt"
cp -f "$BASE/adal.ico"           "$USB/adal.ico"

echo "== [7/7] Done =="
du -sh "$USB"
ls -la "$USB"
echo
echo "USB folder ready: $USB"
