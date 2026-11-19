# apply-release.ps1 - installs a signed Adal Keep release copied to this PC
# (scp over the office network when the internet is down).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File apply-release.ps1 [-Bundle <folder or .zip>] [-Root C:\AdalKeep] [-Force]
#
# The release folder is what scripts/release-bundle.mjs makes (or any PC's
# data\lan-release / a Companion's updates folder): current.json + files\<sha256>.
# 1. A server that has POST /api/system/update/apply-local installs it itself
#    (and restarts by itself).
# 2. An older server: the release's own code installs it (apply-release.mjs,
#    with Adal Keep's own Node), then the server is restarted (AdalKeep.exe
#    starts it again with the new version).
# Nothing is installed unless Adal's signature and every piece's SHA-256 match.
param([string]$Bundle = $PSScriptRoot, [string]$Root = '', [switch]$Force)
$ErrorActionPreference = 'Stop'
$Bundle = (Resolve-Path $Bundle).Path
if (-not $Root) {
  foreach ($k in 'HKLM:\Software\AdalKeep', 'HKLM:\Software\WOW6432Node\AdalKeep') {
    $d = (Get-ItemProperty $k -ErrorAction SilentlyContinue).InstallDir
    if ($d -and (Test-Path $d)) { $Root = $d; break }
  }
  if (-not $Root) { $Root = 'C:\AdalKeep' }
}
Write-Host "Adal Keep: $Root   release: $Bundle"

# 1. The server installs it (newer servers).
$body = @{ path = $Bundle; force = [bool]$Force } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4000/api/system/update/apply-local' -ContentType 'application/json' -Body $body -TimeoutSec 3600
  if ($r.log) { Write-Host $r.log }
  Write-Host "OK: $($r.message)"
  exit 0
} catch {
  $code = 0
  try { $code = [int]$_.Exception.Response.StatusCode } catch {}
  if ($code -ne 404 -and $code -ne 0) {
    $msg = $_.ErrorDetails.Message
    try { $j = $msg | ConvertFrom-Json; if ($j.log) { Write-Host $j.log }; $msg = $j.error } catch {}
    Write-Host "NOT INSTALLED: $msg"
    exit 1
  }
  if ($code -eq 0) { Write-Host 'The server does not answer on :4000 - installing with the release''s own code.' }
  else { Write-Host 'This server is older (no apply-local) - installing with the release''s own code.' }
}

# 2. Older (or stopped) server: the release installs itself, then the server restarts.
$node = Join-Path $Root 'runtime\node.exe'
if (-not (Test-Path $node)) { Write-Host "NOT INSTALLED: no $node"; exit 1 }
$args2 = @((Join-Path $PSScriptRoot 'apply-release.mjs'), $Bundle, '--root', $Root)
if ($Force) { $args2 += '--force' }
$out = & $node @args2 2>&1 | ForEach-Object { "$_" }
$out | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Write-Host 'NOT INSTALLED'; exit 1 }
if ($out -contains 'RESTART_SERVER') {
  $pids = @(Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($p in $pids) { if ($p -gt 4) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }
  Write-Host 'OK: installed; the server restarts with the new version (AdalKeep.exe starts it again in a few seconds).'
} else { Write-Host 'OK: already up to date.' }
exit 0
