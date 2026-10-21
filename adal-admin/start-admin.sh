#!/bin/sh
# Adal Keep admin panel: start it (if it is not running yet) and open it.
cd "$(dirname "$0")"
if ! curl -s -o /dev/null http://localhost:4100/ 2>/dev/null; then
  nohup node server.mjs >> admin.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null http://localhost:4100/ 2>/dev/null && break
    sleep 0.5
  done
fi
xdg-open http://localhost:4100 >/dev/null 2>&1 &
