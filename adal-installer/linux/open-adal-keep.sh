#!/bin/sh
# Adal Keep's own window on this PC (no browser bar). Only a person runs this:
# the desktop icon / app grid (adal-keep.desktop). Nothing else opens the window
# (the owner, 2026-11-24: "don't make Adal open by itself in any way").
#
#   - ONE window: when it is already open, that window comes to the front
#     (DevTools' /json/activate on its own local port 9333) — the browser is
#     never asked for a second --app window.
#   - Never old windows back: the profile's last session is cleared before a
#     start (a crash used to bring back the last windows and tabs next to the
#     new one: "the chrome tabs open in 2 windows").
#   - X closes it: the browser does not stay in the background.
# The server is already running as a service; this only makes sure of it.
PROFILE="$HOME/.adal-keep/app-window"
PORT=9333
URL=http://localhost:4000

# Already open: in front, and nothing else.
LIST="$(curl -s -m 2 "http://127.0.0.1:$PORT/json/list" 2>/dev/null)"
if [ -n "$LIST" ]; then
  ID="$(printf '%s' "$LIST" | python3 -c '
import json, sys
try: pages = json.load(sys.stdin)
except Exception: pages = []
for p in pages:
    if p.get("type") == "page" and p.get("url", "").startswith(("http://localhost:4000", "http://127.0.0.1:4000")):
        print(p["id"]); break
' 2>/dev/null)"
  if [ -n "$ID" ]; then
    curl -s -m 2 "http://127.0.0.1:$PORT/json/activate/$ID" >/dev/null 2>&1
    exit 0
  fi
fi
# An older window (opened before this script had its port): in front if the desktop lets us, never a second one.
RUNNING=
if [ -z "$LIST" ] && pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; then
  RUNNING=1
  wmctrl -x -a AdalKeep >/dev/null 2>&1 && exit 0
  xdotool search --class AdalKeep windowactivate >/dev/null 2>&1 && exit 0
fi

systemctl --user start adal-keep.service 2>/dev/null
for i in $(seq 1 60); do
  curl -s -o /dev/null "$URL/" 2>/dev/null && break
  sleep 0.5
done

# No old windows or tabs back, no "restore pages?", no staying in the background after X.
if [ -d "$PROFILE" ] && [ -z "$RUNNING" ]; then
  rm -rf "$PROFILE/Default/Sessions" "$PROFILE/Default/Current Session" "$PROFILE/Default/Current Tabs" \
         "$PROFILE/Default/Last Session" "$PROFILE/Default/Last Tabs" 2>/dev/null
  python3 - "$PROFILE" <<'PY' 2>/dev/null
import json, os, sys
d = sys.argv[1]
def fix(path, change):
    try:
        with open(path) as f: j = json.load(f)
    except Exception: return
    change(j)
    with open(path + ".adal", "w") as f: json.dump(j, f)
    os.replace(path + ".adal", path)
def prefs(j):
    j.setdefault("profile", {})["exit_type"] = "Normal"
    j["profile"]["exited_cleanly"] = True
    j.setdefault("session", {})["restore_on_startup"] = 5
def local_state(j):
    j.setdefault("background_mode", {})["enabled"] = False
fix(os.path.join(d, "Default", "Preferences"), prefs)
fix(os.path.join(d, "Local State"), local_state)
PY
fi

BROWSER="$(command -v brave-browser || command -v brave || command -v google-chrome || command -v chromium || command -v chromium-browser)"
if [ -n "$BROWSER" ]; then
  # Its own profile: separate from the browser the agents work in.
  exec "$BROWSER" --app="$URL" --class=AdalKeep --name=AdalKeep \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    --hide-crash-restore-bubble --disable-session-crashed-bubble \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=$PORT \
    --window-size=1440,900 >/dev/null 2>&1
fi
exec xdg-open "$URL"
