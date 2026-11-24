#!/bin/sh
# One PC that cannot finish its update download (a slow line): Adal's published release, every
# piece checked, copied into its cache over SSH, so the PC installs it BY ITSELF at its next look
# (about a minute; it waits for runs as always). Nothing is installed by this script, nothing signed.
#
#   sh adal-keep-backend/scripts/seed-release.sh hp@192.168.1.7 [~/.ssh/adal-remote]
#
# Then watch:  ssh … "Get-Content C:\AdalKeep\backend\data\server.log -Tail 40 -Wait"
# for "[update] download …: done" / "✅ Update … installed by itself". If it has not installed in
# 15 minutes (runs holding it), install at once with the bundle's own script:
#   ssh … "powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\adal-release\apply-release.ps1"
set -e
HOST="$1"; KEY="${2:-$HOME/.ssh/adal-remote}"
[ -n "$HOST" ] || { echo "usage: seed-release.sh user@host [key]"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIP="${TMPDIR:-/tmp}/adal-release-seed.zip"
node "$HERE/release-bundle.mjs" "$ZIP"
PS="${TMPDIR:-/tmp}/adal-seed-release.ps1"
cat > "$PS" <<'PS1'
$ErrorActionPreference = 'Stop'
$root = 'C:\AdalKeep'
$cache = Join-Path $root 'backend\data\lan-release\files'
$dir = Join-Path $env:USERPROFILE 'adal-release'
Expand-Archive -Force (Join-Path $env:USERPROFILE 'adal-release.zip') $dir
New-Item -ItemType Directory -Force $cache | Out-Null
# Each piece is named by its SHA-256; Adal Keep checks it again before it uses it.
Get-ChildItem (Join-Path $dir 'files') | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $cache $_.Name) -Force
  Write-Host ('piece ' + $_.Name.Substring(0, 12) + ' ' + [math]::Round($_.Length / 1MB, 1) + ' MB')
}
# Half-downloads of those pieces are not needed any more.
Get-ChildItem $cache -Filter *.part | Where-Object { Test-Path (Join-Path $cache $_.BaseName) } | Remove-Item -Force
Write-Host 'OK: the pieces are in the cache; Adal Keep installs the release by itself at its next look.'
PS1
scp -i "$KEY" -o IdentitiesOnly=yes "$ZIP" "$HOST:adal-release.zip"
scp -i "$KEY" -o IdentitiesOnly=yes "$PS" "$HOST:adal-seed-release.ps1"
ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" 'powershell -NoProfile -ExecutionPolicy Bypass -File adal-seed-release.ps1'
