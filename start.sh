#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

kill_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "Killing PIDs on port $port: $pids"
      kill -9 $pids 2>/dev/null || true
    fi
  fi
  # Windows Git Bash / occasional node leftovers
  pkill -f "node.*server.js" 2>/dev/null || true
  pkill -f "nodemon.*server" 2>/dev/null || true
}

echo "→ Freeing ports 4000 and 3000..."
kill_port 4000
kill_port 3000
sleep 1

echo "→ Starting backend..."
cd "$ROOT/adal-keep-backend"
npm run dev &
BACK_PID=$!
cd "$ROOT"

echo "→ Starting frontend..."
cd "$ROOT/adal-keep-frontend"
npm run dev &
FRONT_PID=$!
cd "$ROOT"

echo "Backend PID $BACK_PID · Frontend PID $FRONT_PID"
echo "Open http://localhost:3000"
wait
