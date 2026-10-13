#!/usr/bin/env bash
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ROOT="$HOME/AdalKeep"
echo "Detected home: $HOME"
read -p "Install to [$DEFAULT_ROOT]? (Enter = accept): " ROOT
ROOT=${ROOT:-$DEFAULT_ROOT}
mkdir -p "$ROOT"
if [ ! -w "$ROOT" ]; then ROOT="$HOME/AdalKeep"; mkdir -p "$ROOT"; fi
echo "[OK] Installing to: $ROOT"
cp -r "$HERE/adal-master" "$ROOT/"
cp -r "$HERE/adal-companion" "$ROOT/"
echo "[1/2] Master dependencies..."
(cd "$ROOT/adal-master/adal-keep-backend" && npm install --no-audit --no-fund)
echo "[2/2] Companion dependencies..."
(cd "$ROOT/adal-companion/adal-keep-backend" && npm install --no-audit --no-fund)
cat > "$ROOT/adal-master/adal-keep-backend/.env" << ENVEOF
PORT=3000
NODE_ENV=production
WATCH_DIR=$HOME/Downloads
DEV_MASTER_PASSWORD=759126348
CODE_SECRET=adal-keep-code-signing-secret-v1
TENANT_SECRET=adal-keep-local-secret
ENVEOF
cp "$ROOT/adal-master/adal-keep-backend/.env" "$ROOT/adal-companion/adal-keep-backend/.env"
printf '#!/usr/bin/env bash\ncd "%s/adal-master/adal-keep-backend" && node server.js\n' "$ROOT" > "$ROOT/start-adal-keep.sh"
chmod +x "$ROOT/start-adal-keep.sh"
echo "DONE. This PC: http://localhost:3000 | LAN: http://$(hostname -I | awk '{print $1}'):3000"
