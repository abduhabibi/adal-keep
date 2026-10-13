#!/usr/bin/env bash
# start-agent.sh — free the port, activate venv, launch the agent UI.

set -e

cd "$(dirname "$0")"

PORT=8765
VENV=".venv/bin/activate"
ENTRY="webui.py"

# ---- free the port if something's already holding it ----
if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti tcp:"${PORT}" 2>/dev/null || true)
    [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
fi
sleep 0.5

# ---- activate venv ----
if [ ! -f "$VENV" ]; then
    echo "error: $VENV not found. Run this from the project root." >&2
    exit 1
fi
# shellcheck disable=SC1091
source "$VENV"

# ---- launch ----
exec python3 "$ENTRY"
