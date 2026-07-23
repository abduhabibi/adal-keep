#!/bin/bash
# Start Adal Keep
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "🚀 Starting Adal Keep..."

# Free ports if something is already listening
fuser -k 4000/tcp 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true
pkill -f "nodemon server.js" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

cd "$ROOT/adal-keep-backend"
npm run dev > "$ROOT/backend.log" 2>&1 &
BACKEND_PID=$!

cd "$ROOT/adal-keep-frontend"
npm run dev > "$ROOT/frontend.log" 2>&1 &
FRONTEND_PID=$!

sleep 2

echo "✅ Backend PID: $BACKEND_PID (http://localhost:4000)"
echo "✅ Frontend PID: $FRONTEND_PID (http://localhost:3000)"
echo ""
echo "📋 Open Adal Keep:"
echo "   Local:   http://localhost:3000"
echo "   Network: http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "📝 Logs:"
echo "   Backend:  tail -f $ROOT/backend.log"
echo "   Frontend: tail -f $ROOT/frontend.log"
echo ""
echo "Press Ctrl+C to stop"

cleanup() {
  echo "Stopping services..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  fuser -k 4000/tcp 2>/dev/null || true
  fuser -k 3000/tcp 2>/dev/null || true
  exit 0
}

trap cleanup INT TERM
wait
