#!/bin/sh
# Adal Keep's own window on this PC (no browser bar). The server is already
# running as a service; this only makes sure of it, then opens the window.
# A second click brings the same window forward (same profile).
systemctl --user start adal-keep.service 2>/dev/null
for i in $(seq 1 60); do
  curl -s -o /dev/null http://localhost:4000/ 2>/dev/null && break
  sleep 0.5
done
BROWSER="$(command -v brave-browser || command -v brave || command -v google-chrome || command -v chromium || command -v chromium-browser)"
if [ -n "$BROWSER" ]; then
  # Its own profile: separate from the browser the agents work in.
  exec "$BROWSER" --app=http://localhost:4000 --class=AdalKeep --name=AdalKeep \
    --user-data-dir="$HOME/.adal-keep/app-window" --no-first-run --no-default-browser-check \
    --window-size=1440,900 >/dev/null 2>&1
fi
exec xdg-open http://localhost:4000
