#!/bin/sh
# Adal Keep Admin — its own window on this PC (no browser bar): starts the
# panel (and the agency windows' server) when it is not running, brings the
# agency pages up to date, then opens the Admin window.
cd "$(dirname "$0")"
HERE="$(pwd)"
FRONT="$HERE/../adal-keep-frontend"
# The agency windows are the Adal Keep pages themselves: rebuilt when they changed.
if [ -d "$FRONT/src" ] && { [ ! -f keep-app/index.html ] || [ -n "$(find "$FRONT/src" -newer keep-app/index.html -print -quit)" ]; }; then
  ( cd "$FRONT" && npm run -s build:admin >/dev/null 2>&1 && rm -f "$HERE/keep-app/sw.js" )
fi
if ! curl -s -o /dev/null http://localhost:4100/ 2>/dev/null; then
  nohup node server.mjs >> admin.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null http://localhost:4100/ 2>/dev/null && break
    sleep 0.5
  done
fi
BROWSER="$(command -v brave-browser || command -v brave || command -v google-chrome || command -v chromium || command -v chromium-browser)"
if [ -n "$BROWSER" ]; then
  # Its own profile: separate from the Brave that runs the automations.
  exec "$BROWSER" --app=http://localhost:4100 --class=AdalKeepAdmin --name=AdalKeepAdmin \
    --user-data-dir="$HOME/.adal-keep/admin-window" --no-first-run --no-default-browser-check \
    --window-size=1440,900 >/dev/null 2>&1
fi
xdg-open http://localhost:4100 >/dev/null 2>&1 &
