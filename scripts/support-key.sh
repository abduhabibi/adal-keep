#!/usr/bin/env bash
# support-key.sh <pcnumber> - Adal remote-support key for ONE agency.
#
# Each agency has its own key pair, named by its Main PC's 5-digit number
# (Settings -> Main PC). The private half stays on this PC (~/.ssh/adal-<n>,
# made here when missing, never overwritten). The public half is printed and
# written to the USB as deps/support-keys/<n>.pub, where
# "Adal Connect - Main/Companion.bat" installs it for that number only.
#
#   bash scripts/support-key.sh 12345
#   ssh -i ~/.ssh/adal-12345 <windows-user>@<pc>
set -euo pipefail
N="${1:-}"
if ! [[ "$N" =~ ^[0-9]{5}$ ]]; then
  echo "usage: $0 <5-digit PC number>" >&2; exit 2
fi
BASE="$(cd "$(dirname "$0")/.." && pwd)"
SSHD="${ADAL_SSH_DIR:-$HOME/.ssh}"
KEY="$SSHD/adal-$N"
mkdir -p "$SSHD"; chmod 700 "$SSHD"
if [ ! -f "$KEY" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "adal-support-$N" -f "$KEY" </dev/null >&2
  echo "made $KEY" >&2
fi
if [ ! -f "$KEY.pub" ]; then
  echo "$(ssh-keygen -y -f "$KEY" | cut -d' ' -f1,2) adal-support-$N" > "$KEY.pub"
fi
PUB="$(cut -d' ' -f1,2 "$KEY.pub") adal-support-$N"
# Every USB copy this PC knows: the build folder and the physical USB (root).
for USB in "${USB_DIR:-$BASE/Adal Keep USB}" "/media/$USER/ADALKEEP"; do
  [ -d "$USB" ] || continue
  mkdir -p "$USB/deps/support-keys"
  printf '%s\n' "$PUB" > "$USB/deps/support-keys/$N.pub"
  echo "wrote $USB/deps/support-keys/$N.pub" >&2
done
sync 2>/dev/null || true
printf '%s\n' "$PUB"
