#!/usr/bin/env bash
# office-pcs.sh - reach every office PC that ran "Adal Connect" (SSH, agency key).
#
# Each Connect run leaves Adal-Connect-<PC>.txt on the USB (name, Windows user,
# addresses). This reads those reports (the USB root and the build folder),
# remembers them in ~/.ssh/adal-pcs-<n>.txt, and tries each address in turn.
#
#   bash scripts/office-pcs.sh            list the PCs and whether each answers
#   bash scripts/office-pcs.sh run 'Get-Date'   run a PowerShell line on every PC
#   PC=DESK-1 bash scripts/office-pcs.sh run '...'   only that PC
#
# Key: ~/.ssh/adal-<n> (scripts/support-key.sh <n>). Never a password login.
set -uo pipefail
N="${ADAL_PC_NUMBER:-47040}"
BASE="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$HOME/.ssh/adal-$N"
LIST="$HOME/.ssh/adal-pcs-$N.txt"
[ -f "$KEY" ] || { echo "no key $KEY - run: bash scripts/support-key.sh $N" >&2; exit 2; }
touch "$LIST"

# 1. Learn the PCs from every Connect report we can see.
for f in "${USB_DIR:-/d}"/Adal-Connect-*.txt "$BASE/Adal Keep USB"/Adal-Connect-*.txt; do
  [ -f "$f" ] || continue
  t="$(sed 's/^\xEF\xBB\xBF//; s/\r$//' "$f")"
  name="$(sed -n 's/^ *PC name: *//p' <<<"$t" | head -1)"
  user="$(sed -n 's/^ *Windows user: *//p' <<<"$t" | head -1)"
  ips="$(sed -n 's/^ *LAN IPs: *//p' <<<"$t" | head -1 | tr -d ' ')"
  [ -n "$name" ] && [ -n "$user" ] && [ -n "$ips" ] || continue
  grep -v "^$name " "$LIST" > "$LIST.new" || true
  echo "$name $user $ips" >> "$LIST.new"; mv -f "$LIST.new" "$LIST"
done
[ -s "$LIST" ] || { echo "No PC has run Adal Connect yet (no Adal-Connect-*.txt on the USB)."; exit 0; }

ssh_to() {  # user ip command...
  local u="$1" ip="$2"; shift 2
  ssh -i "$KEY" -o BatchMode=yes -o PasswordAuthentication=no -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts_adal" \
      "$u@$ip" "$@"
}

MODE="${1:-list}"; CMD="${2:-}"
while read -r name user ips; do
  [ -n "${PC:-}" ] && [ "$PC" != "$name" ] && continue
  ok=''
  for ip in ${ips//,/ }; do
    if ssh_to "$user" "$ip" "exit 0" </dev/null 2>/dev/null; then ok="$ip"; break; fi
  done
  if [ -z "$ok" ]; then echo "$name: not reachable ($ips)"; continue; fi
  if [ "$MODE" = run ] && [ -n "$CMD" ]; then
    echo "== $name ($ok)"
    ssh_to "$user" "$ok" "$CMD" </dev/null
  else
    echo "$name: reachable at $ok as $user"
  fi
done < "$LIST"
