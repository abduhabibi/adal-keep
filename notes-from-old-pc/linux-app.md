---
name: linux-app
description: This PC runs Adal Keep as a systemd user service with a desktop icon; start.sh is development only
metadata:
  type: project
---
Since 2026-11-05 this PC runs Adal Keep as `adal-keep.service` (systemd user, /usr/bin/node, starts at login, Restart=always, log in adal-keep-backend/logs/adal-keep.log). The icon (menu, Desktop, dock) runs `adal-installer/linux/open-adal-keep.sh`, opening a Brave --app window with profile ~/.adal-keep/app-window. Setup: `adal-installer/linux/install-linux-app.sh`.

**Why:** the user was fed up with running a program by hand.

**How to apply:** the app serves the built frontend, so run `npm run build` in adal-keep-frontend after UI changes and `systemctl --user restart adal-keep` after backend changes (no nodemon now). `start.sh` stops the service for dev work. Check ports before claiming the server is stopped: the user may have started it. The window does not open by itself at login, in line with [[browser-opening-rule]]. Repo copies never self-update (`isRepo`).
