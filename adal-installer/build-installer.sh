#!/usr/bin/env bash
# =====================================================================
#  Adal Keep - build the USB folder
#
#  Result:  "<repo>/Adal Keep USB/"   <- copy this whole folder to the USB
#      Install Adal Main.exe                          server PC, one click
#      Install Adal Companion.exe                     employee PCs, one click
#      PREPARE - run once on a PC with internet.bat   fills deps\ once
#      deps\                                          Windows dependencies
#      README-USB.txt
#
#  The Windows Node runtime and the server's node_modules are NOT built
#  here: native modules (sqlite3, sharp) must be built on Windows. PREPARE
#  does that once on any Windows PC with internet and stores them in deps\.
#
#  Requires: node, npm, go, makensis (nsis), rsync
#  Optional env: SKIP_FRONTEND=1  (reuse the existing dist/)
# =====================================================================
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST="$BASE/adal-installer"
STAGE="$INST/stage"
USB="$BASE/Adal Keep USB"
BACK="$BASE/adal-keep-backend"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' is not installed"; exit 1; }; }
need makensis; need go; need rsync; need node

rm -rf "$STAGE"
mkdir -p "$STAGE/main/backend" "$STAGE/main/frontend" "$STAGE/companion"

echo "== [1/6] Frontend =="
if [ "${SKIP_FRONTEND:-0}" = "1" ]; then
  echo "   skipped (SKIP_FRONTEND=1)"
else
  ( cd "$BASE/adal-keep-frontend" && npm run build )
fi
rsync -a "$BASE/adal-keep-frontend/dist/" "$STAGE/main/frontend/"

echo "== [2/6] Backend (no personal data, no node_modules) =="
rsync -a --exclude node_modules --exclude data --exclude uploads \
  --exclude '*.sqlite*' --exclude '.env*' "$BACK/src/" "$STAGE/main/backend/src/"
for f in server.js knexfile.js package.json package-lock.json eng.traineddata amh.traineddata; do
  [ -f "$BACK/$f" ] && cp -f "$BACK/$f" "$STAGE/main/backend/$f"
done
# Windows .env: the keys from this PC, minus settings that only make sense
# here (Linux paths, the removed agent pool). The inbox defaults to
# C:\AdalKeep\inbox on Windows.
if [ -f "$BACK/.env" ]; then
  grep -vE '^(WATCH_DIR|AUTOMATION_LANES|AUTOMATION_MIN_AGENTS|AUTOMATION_MAX_AGENTS|NODE_ENV|SQLITE_PATH|FRONTEND_DIR|BRAVE_CDP_URL)=' "$BACK/.env" \
    > "$STAGE/main/backend/.env"
  echo "NODE_ENV=production" >> "$STAGE/main/backend/.env"
  echo "   .env: $(grep -cE '^[A-Z_]+=' "$STAGE/main/backend/.env") settings (values not shown)"
else
  echo "   WARN no backend .env - the AI keys must be added on the server PC"
fi

echo "== [3/6] Windows programs (Go, windows/amd64) =="
( cd "$BASE/adal-launcher"  && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o "$STAGE/main/AdalKeep.exe" . )
( cd "$BASE/adal-companion" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o "$STAGE/main/adal-companion.exe" . )
( cd "$BASE/adal-agent"     && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o "$STAGE/main/adal-agent.exe" ./cmd/agent )
cp -f "$STAGE/main/adal-companion.exe" "$STAGE/companion/adal-companion.exe"
cp -f "$INST/files/run-server.bat" "$INST/files/start-companion.bat" "$INST/files/finish-install.ps1" "$STAGE/main/"
cp -f "$INST/files/start-companion.bat" "$STAGE/companion/"
cp -f "$INST/files/stop-adal.ps1" "$STAGE/"
file "$STAGE/main/"*.exe | sed 's/^/   /'
# Windows needs CRLF line endings in .bat files.
for f in "$STAGE/main/"*.bat "$STAGE/companion/"*.bat; do sed -i 's/\r*$/\r/' "$f"; done

echo "== [4/6] Installers =="
( cd "$INST" && makensis -V2 usb-installer.nsi && makensis -V2 -DCOMPANION usb-installer.nsi )

echo "== [5/6] USB folder =="
# Keep deps\ a previous PREPARE already filled (it is the slow part).
if [ -d "$USB/deps" ]; then mv "$USB/deps" "$INST/.deps-keep"; fi
rm -rf "$USB"
mkdir -p "$USB"
if [ -d "$INST/.deps-keep" ]; then mv "$INST/.deps-keep" "$USB/deps"; fi
mkdir -p "$USB/deps/source"
mv -f "$INST/Install Adal Main.exe" "$INST/Install Adal Companion.exe" "$USB/"
cp -f "$INST/usb/PREPARE - run once on a PC with internet.bat" "$USB/"
cp -f "$INST/usb/deps/prepare-deps.ps1" "$USB/deps/"
cp -f "$BACK/package.json" "$BACK/package-lock.json" "$USB/deps/source/"
cp -f "$INST/README-USB.txt" "$USB/README-USB.txt"
# A previous PREPARE built node_modules for an older package.json: say so.
if [ -f "$USB/deps/READY.txt" ] && [ -f "$USB/deps/source.sha" ] && \
   [ "$(sha256sum "$USB/deps/source/package-lock.json" | cut -d' ' -f1)" != "$(cat "$USB/deps/source.sha")" ]; then
  rm -f "$USB/deps/READY.txt"
  echo "   NOTE packages changed since the last PREPARE - run PREPARE again"
fi
sha256sum "$USB/deps/source/package-lock.json" | cut -d' ' -f1 > "$USB/deps/source.sha"
# Windows needs CRLF line endings in .bat files.
for f in "$USB/"*.bat; do sed -i 's/\r*$/\r/' "$f"; done

echo "== [6/6] Done =="
rm -rf "$STAGE"
du -sh "$USB"
ls -la "$USB" "$USB/deps"
echo
echo "USB folder ready: $USB"
if [ ! -f "$USB/deps/READY.txt" ]; then
  echo "NEXT: copy it to the USB, then run PREPARE once on a Windows PC with internet."
fi
