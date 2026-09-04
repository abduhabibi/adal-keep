#!/bin/bash
# Start Adal Keep - Full Stack (Backend + Frontend + WhatsApp Bridge)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "🚀 Starting Adal Keep..."

# Free ports if something is already listening
fuser -k 4000/tcp 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true
fuser -k 3001/tcp 2>/dev/null || true
pkill -f "nodemon server.js" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "adal-whatsapp-bridge" 2>/dev/null || true
sleep 1

# ============================================
# BACKEND (port 4000)
# Handles: API, AI ingestion, subscriptions, file management
# Works 100% OFFLINE - SQLite is local
# ============================================
cd "$ROOT/adal-keep-backend"
npm run dev > "$ROOT/backend.log" 2>&1 &
BACKEND_PID=$!

# Wait for backend to be ready
echo "⏳ Waiting for backend..."
for i in $(seq 1 30); do
  if curl -s http://localhost:4000/api/health >/dev/null 2>&1; then
    echo "✅ Backend ready"
    break
  fi
  sleep 1
done

# ============================================
# FRONTEND (port 3000)
# The main Adal Keep web app
# Works 100% OFFLINE - static files served locally
# ============================================
cd "$ROOT/adal-keep-frontend"
npm run dev > "$ROOT/frontend.log" 2>&1 &
FRONTEND_PID=$!

# ============================================
# WHATSAPP BRIDGE (port 3001)
# Receives WhatsApp messages via Baileys
# Forwards to backend /api/whatsapp/webhook
# First run requires QR code scan
# ============================================
cd "$ROOT/adal-whatsapp-bridge"
if [ ! -d "node_modules" ]; then
  echo "📦 Installing WhatsApp bridge dependencies..."
  npm install > "$ROOT/whatsapp-bridge-install.log" 2>&1
fi
node index.js > "$ROOT/whatsapp-bridge.log" 2>&1 &
WHATSAPP_PID=$!

# ============================================
# AUTO-RECONNECT CHECKER
# Periodically checks internet connectivity
# When internet returns, syncs subscription status
# ============================================
(
  while true; do
    sleep 60
    if curl -s --max-time 5 https://openrouter.ai >/dev/null 2>&1; then
      FINGERPRINT=$(curl -s http://localhost:4000/api/license/status 2>/dev/null | grep -o '"fingerprint":"[^"]*"' | cut -d'"' -f4 || echo "")
      if [ -n "$FINGERPRINT" ]; then
        curl -s --max-time 10 "http://localhost:4000/api/subscription/status?fingerprint=$FINGERPRINT" >/dev/null 2>&1 || true
        echo "🌐 $(date '+%H:%M:%S') Internet restored — synced subscription" >> "$ROOT/reconnect.log"
      fi
    else
      echo "📴 $(date '+%H:%M:%S') Offline — file management still works, AI paused" >> "$ROOT/reconnect.log"
    fi
  done
) &
RECONNECT_PID=$!

sleep 2

NETWORK_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "unknown")

echo ""
echo "============================================"
echo "  ✅ ADAL KEEP IS RUNNING"
echo "============================================"
echo ""
echo "📋 Access Points:"
echo "   Main App:         http://localhost:3000"
echo "   Network:          http://${NETWORK_IP}:3000"
echo "   Backend API:      http://localhost:4000"
echo "   WhatsApp Bridge:  http://localhost:3001"
echo ""
echo "📱 WhatsApp Setup:"
echo "   Check whatsapp-bridge.log for QR code"
echo "   Scan with WhatsApp → Linked Devices"
echo "   Messages auto-forward to AI ingestion"
echo ""
echo "🔌 Offline Mode:"
echo "   ✅ File management — WORKS (local SQLite)"
echo "   ✅ Profiles/Brokers/Tasks — WORKS (local)"
echo "   ✅ Document uploads — WORKS (stored locally)"
echo "   ⏸️  AI Ingestion — PAUSED until internet returns"
echo "   🔄 Auto-reconnect — CHECKING every 60 seconds"
echo ""
echo "📝 Logs:"
echo "   Backend:          tail -f $ROOT/backend.log"
echo "   Frontend:         tail -f $ROOT/frontend.log"
echo "   WhatsApp Bridge:  tail -f $ROOT/whatsapp-bridge.log"
echo "   Reconnect:        tail -f $ROOT/reconnect.log"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

cleanup() {
  echo ""
  echo "🛑 Stopping all services..."
  kill "$BACKEND_PID" "$FRONTEND_PID" "$WHATSAPP_PID" "$RECONNECT_PID" 2>/dev/null || true
  fuser -k 4000/tcp 2>/dev/null || true
  fuser -k 3000/tcp 2>/dev/null || true
  fuser -k 3001/tcp 2>/dev/null || true
  echo "✅ All stopped."
  exit 0
}

trap cleanup INT TERM
wait
