#!/usr/bin/env bash
# key-safe-copy.sh — a second, locked copy of the keys that cannot be made again.
#
#   ./scripts/key-safe-copy.sh          (from the project folder on Adal's Linux PC)
#
# Bundles, into ONE file locked with a passphrase you choose (asked here, never
# saved, never uploaded; OpenSSL AES-256, PBKDF2 600 000 rounds):
#   ~/.adal-keep/update-signing.pem (+ .pub)  every PC's updates and the licences Admin signs
#   ~/.adal-keep/phone-release.jks (+ .properties)  the phone app's updates
#   adal-keep-backend/.env, adal-admin/.env   ADAL_LICENSE_KEY (unlock codes) and the Supabase keys
#   adal-keep-backend/data/account-vault.key  this PC's saved portal passwords
# and writes it to
#   1. the USB:  /media/abduhabibi/ADALKEEP/keys/   (when it is plugged in)
#   2. Supabase: private bucket adal-install, folder keys/  (adal-admin/.env)
# Each copy is read back and compared. It also checks the move bundle on the USB
# ("Adal Keep Move", see adal-installer/move).
#
# The keys are only read. Nothing is moved, changed or printed.
# Another agency PC's account-vault.key travels inside that PC's own Telegram
# backup (locked with its backup password) and comes back with a restore.
#
# To open a copy later:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in adal-keys-….enc | tar -xzf - -C <empty folder>
#
# Test overrides (never needed for a real run): ADAL_PROJECT, ADAL_KEYS_DIR,
# ADAL_USB, ADAL_ADMIN_ENV, ADAL_MOVE_DIR.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${ADAL_PROJECT:-$(cd "$HERE/.." && pwd)}"
KEYS_DIR="${ADAL_KEYS_DIR:-$HOME/.adal-keep}"
USB="${ADAL_USB:-/media/abduhabibi/ADALKEEP}"
ADMIN_ENV="${ADAL_ADMIN_ENV:-$PROJECT/adal-admin/.env}"
MOVE_DIR="${ADAL_MOVE_DIR:-$USB/Adal Keep Move}"
BUCKET="adal-install"
ITER=600000
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="adal-keys-$STAMP.tar.gz.enc"

say() { printf '%s\n' "$*"; }
bad() { printf 'NOT DONE: %s\n' "$*" >&2; exit 1; }
command -v openssl >/dev/null || bad "openssl is missing"
command -v tar >/dev/null || bad "tar is missing"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/adal-keys.XXXXXX")"
cleanup() { rm -rf "$WORK"; unset PASS PASS2 || true; }
trap cleanup EXIT INT TERM

# ── 1. What goes in ─────────────────────────────────────────────────────────
WANT=(
  "$KEYS_DIR/update-signing.pem|update signing key (updates for every PC, licences)|must"
  "$KEYS_DIR/update-signing.pub.pem|its public half|may"
  "$KEYS_DIR/phone-release.jks|phone app signing key|must"
  "$KEYS_DIR/phone-release.properties|phone signing key password|must"
  "$PROJECT/adal-keep-backend/.env|backend .env (ADAL_LICENSE_KEY)|must"
  "$PROJECT/adal-admin/.env|Admin .env (licence key, Supabase)|may"
  "$PROJECT/adal-keep-backend/data/account-vault.key|this PC's password vault key|may"
)
FILES=()
missing=0
say "Keys:"
for w in "${WANT[@]}"; do
  IFS='|' read -r f what need <<<"$w"
  if [[ -f "$f" && -r "$f" ]]; then FILES+=("$f"); say "  ok       $what"
  elif [[ "$need" == must ]]; then say "  MISSING  $what  ($f)"; missing=1
  else say "  (none)   $what"; fi
done
[[ $missing == 0 ]] || bad "a key that cannot be made again is missing: nothing was written"

# ── 2. The passphrase (asked, never kept) ───────────────────────────────────
say ""
say "Choose a passphrase for this copy. Write it on paper and keep it away from the USB."
IFS= read -rs -p "Passphrase (12+ characters): " PASS; echo
IFS= read -rs -p "Again: " PASS2; echo
[[ "$PASS" == "$PASS2" ]] || bad "the two passphrases are not the same"
[[ ${#PASS} -ge 12 ]] || bad "the passphrase is shorter than 12 characters"
unset PASS2

# ── 3. Lock ─────────────────────────────────────────────────────────────────
# Paths are stored relative to / so a restore shows where each one belongs.
REL=(); for f in "${FILES[@]}"; do REL+=("${f#/}"); done
OUT="$WORK/$NAME"
tar -czf - -C / "${REL[@]}" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -md sha256 -salt -pass fd:3 -out "$OUT" 3< <(printf '%s' "$PASS")
# Read back with the passphrase and compare every file with the real one (tar -d).
openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -md sha256 -pass fd:3 -in "$OUT" 3< <(printf '%s' "$PASS") \
  | tar -dzf - -C / >/dev/null || bad "the locked copy did not read back the same"
unset PASS
SUM="$(sha256sum "$OUT" | cut -d' ' -f1)"
printf '%s  %s\n' "$SUM" "$NAME" > "$WORK/$NAME.sha256"
say ""
say "Locked: $NAME ($(stat -c %s "$OUT") bytes, ${#FILES[@]} files), read back and compared."

done_usb=0 done_online=0

# ── 4. USB ──────────────────────────────────────────────────────────────────
if [[ -d "$USB" ]] && { [[ -n "${ADAL_USB:-}" ]] || mountpoint -q "$USB"; }; then
  mkdir -p "$USB/keys"
  cp "$OUT" "$WORK/$NAME.sha256" "$USB/keys/"
  sync
  if (cd "$USB/keys" && sha256sum -c --status "$NAME.sha256"); then say "USB:      $USB/keys/$NAME  (checked)"; done_usb=1
  else say "USB:      the copy on the USB does not match: write it again"; fi
else
  say "USB:      not plugged in ($USB): no USB copy"
fi

# ── 5. Supabase (private bucket adal-install/keys/) ─────────────────────────
envval() { [[ -f "$ADMIN_ENV" ]] && sed -n "s/^$1=//p" "$ADMIN_ENV" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | tr -d '\r'; }
SB_URL="$(envval SUPABASE_URL)"; SB_URL="${SB_URL%/}"
if [[ -n "$SB_URL" ]] && command -v curl >/dev/null; then
  # The service key goes in a header file, not on the command line (ps would show it).
  { printf 'Authorization: Bearer %s\n' "$(envval SUPABASE_SERVICE_KEY)"; printf 'apikey: %s\n' "$(envval SUPABASE_SERVICE_KEY)"; } > "$WORK/h"
  up=0
  for f in "$NAME" "$NAME.sha256"; do
    code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X POST -H @"$WORK/h" -H 'Content-Type: application/octet-stream' -H 'x-upsert: false' \
      --data-binary @"$WORK/$f" "$SB_URL/storage/v1/object/$BUCKET/keys/$f" || true)"
    [[ "$code" =~ ^2 ]] && up=$((up + 1)) || say "Online:   upload of $f answered $code"
  done
  if [[ $up == 2 ]]; then
    code="$(curl -sS -o "$WORK/back" -w '%{http_code}' -H @"$WORK/h" "$SB_URL/storage/v1/object/authenticated/$BUCKET/keys/$NAME" || true)"
    if [[ "$code" =~ ^2 ]] && [[ "$(sha256sum "$WORK/back" | cut -d' ' -f1)" == "$SUM" ]]; then say "Online:   $BUCKET/keys/$NAME  (downloaded back and checked)"; done_online=1
    else say "Online:   uploaded, but reading it back failed ($code)"; fi
  fi
else
  say "Online:   no SUPABASE_URL in $ADMIN_ENV: no online copy"
fi

# ── 6. The move bundle on the USB ───────────────────────────────────────────
if [[ -f "$MOVE_DIR/adal-move.json" ]]; then
  if command -v node >/dev/null; then
    node -e '
      const fs = require("fs"), path = require("path"), dir = process.argv[1]
      const i = JSON.parse(fs.readFileSync(path.join(dir, "adal-move.json"), "utf8"))
      let size = 0, gone = []
      for (let n = 1; n <= i.parts; n++) { const p = path.join(dir, `adal-move.part${String(n).padStart(3, "0")}`); if (fs.existsSync(p)) size += fs.statSync(p).size; else gone.push(path.basename(p)) }
      const whole = !gone.length && size === i.bytes && i.salt && i.iv && i.tag
      console.log(`Move:     made ${i.made}, ${i.parts} part(s), ${(i.bytes / 1048576).toFixed(0)} MB: ` + (whole ? "all parts there, sizes right" : `NOT whole (${gone.length ? gone.join(", ") + " missing" : "size " + size + " ≠ " + i.bytes})`))
      process.exit(whole ? 0 : 3)' "$MOVE_DIR" || true
  fi
  if [[ -f "$MOVE_DIR/restore-adal.mjs" && -t 0 ]]; then
    read -r -p "Unlock-test the move bundle too? It asks for ITS passphrase (y/N): " yes
    if [[ "$yes" =~ ^[yY] ]]; then (cd "$MOVE_DIR" && node restore-adal.mjs --check-only) || say "Move:     the unlock test failed"; fi
  fi
else
  say "Move:     no move bundle at $MOVE_DIR"
fi

say ""
if [[ $done_usb == 1 || $done_online == 1 ]]; then
  where=(); [[ $done_usb == 1 ]] && where+=(USB); [[ $done_online == 1 ]] && where+=(online)
  say "DONE (${where[*]}). The passphrase is only on your paper: without it no copy opens."
else
  bad "no copy was written (no USB and no online storage)"
fi
