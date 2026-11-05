#!/usr/bin/env bash
# Makes Adal Keep an application on this Linux PC: the server starts by itself at
# login and comes back if it stops, and an icon in the menu, on the Desktop and
# in the dock opens its window. Run it again after moving the folder.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$ROOT/adal-keep-backend"
NODE="$([ -x /usr/bin/node ] && echo /usr/bin/node || command -v node)"
OPEN="$ROOT/adal-installer/linux/open-adal-keep.sh"
chmod +x "$OPEN"

( cd "$ROOT/adal-keep-frontend" && npm run -s build >/dev/null )   # the window shows the built pages

mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/share/applications" "$BACKEND/logs"
cat > "$HOME/.config/systemd/user/adal-keep.service" <<UNIT
[Unit]
Description=Adal Keep
After=graphical-session.target

[Service]
WorkingDirectory=$BACKEND
ExecStart=$NODE server.js
Restart=always
RestartSec=3
# The agents' browser outlives a restart of the server.
KillMode=process
TimeoutStopSec=15
StandardOutput=append:$BACKEND/logs/adal-keep.log
StandardError=append:$BACKEND/logs/adal-keep.log

[Install]
WantedBy=graphical-session.target
UNIT
systemctl --user daemon-reload
systemctl --user enable adal-keep.service >/dev/null 2>&1
systemctl --user restart adal-keep.service

ENTRY="$HOME/.local/share/applications/adal-keep.desktop"
cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Adal Keep
Comment=Profiles, documents and the agents' work
Exec=$OPEN
Icon=$ROOT/adal-keep-frontend/public/adal-logo.png
Terminal=false
Categories=Office;
StartupWMClass=AdalKeep
StartupNotify=true
DESKTOP
chmod +x "$ENTRY"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESK" ]; then
  cp "$ENTRY" "$DESK/adal-keep.desktop"
  chmod +x "$DESK/adal-keep.desktop"
  gio set "$DESK/adal-keep.desktop" metadata::trusted true 2>/dev/null || true
fi

# In the dock, once.
if command -v gsettings >/dev/null 2>&1; then
  python3 - <<'PIN'
import ast, subprocess
now = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'favorite-apps'], text=True).replace('@as ', ''))
if 'adal-keep.desktop' not in now:
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'favorite-apps', str(now + ['adal-keep.desktop'])])
PIN
fi
echo "Adal Keep is installed: the server is running and starts by itself at login."
