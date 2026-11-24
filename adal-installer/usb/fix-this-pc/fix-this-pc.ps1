# fix-this-pc.ps1 - "Fix this PC" from Adal's USB (run by "Fix this PC.cmd", as administrator).
#
#   1. Stops every robot: Adal Keep is asked to stop (its own Quit), then what is left of it ends:
#      its programs (AdalKeep.exe, adal-companion.exe, adal-agent.exe, its node.exe) and the ROBOT
#      browsers (a browser started from this install with a control port; never WhatsApp's, never
#      the person's own browser, never Adal Keep's own window). Every robot run waiting, working
#      or paused is marked cancelled, with a note (fix-runs.mjs). Nothing else in the data changes.
#   2. Frees the PC: half-downloads (.part) and old programs (*.old) are removed.
#   3. Installs Adal's newest release from this USB (release\): the signed pieces, checked against
#      Adal's signature, installed by the release's own code (apply-release.mjs). No internet.
#   4. Starts Adal Keep again in the background (server only: its window opens from its icon).
#   5. Says the version now and how many robot runs were stopped; a log goes to logs\ on the USB.
# Safe to run twice. Never touches the data, the keys (account-vault.key, sync-id.json) or uploads.
$ErrorActionPreference = 'Continue'
$Here = $PSScriptRoot
$Logs = Join-Path $Here 'logs'
New-Item -ItemType Directory -Force $Logs | Out-Null
$LogFile = Join-Path $Logs ("{0}-{1}.txt" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $LogFile -Force | Out-Null
$Release = Join-Path $Here 'release'
function Say($t) { Write-Host $t }

Say "Fix this PC - $env:COMPUTERNAME - $(Get-Date)"

# --- Where Adal Keep is installed --------------------------------------------------------------
$roots = @('C:\AdalKeep', 'C:\AdalKeepCompanion')
foreach ($k in 'HKLM:\Software\AdalKeep', 'HKLM:\Software\WOW6432Node\AdalKeep') {
  $d = (Get-ItemProperty $k -ErrorAction SilentlyContinue).InstallDir
  if ($d) { $roots += $d }
}
$roots = @($roots | Where-Object { $_ -and (Test-Path $_) } | ForEach-Object { (Resolve-Path $_).Path.TrimEnd('\') } | Sort-Object -Unique)
if (-not $roots.Count) { Say 'Adal Keep is not installed on this PC (no C:\AdalKeep or C:\AdalKeepCompanion).'; Stop-Transcript | Out-Null; exit 1 }
Say ("Adal Keep here: " + ($roots -join ', '))

# Each install's servers (Main: <root>\backend; a Companion's own copy: <root>\server\backend).
function BackendsOf($root) {
  @((Join-Path $root 'backend'), (Join-Path $root 'server\backend')) | Where-Object { Test-Path (Join-Path $_ 'server.js') }
}
function NodeOf($backend) { Join-Path (Split-Path $backend -Parent) 'runtime\node.exe' }
function Under($p, $root) { $p -and $p.ToLower().StartsWith(($root + '\').ToLower()) }

# --- 1. Stop Adal Keep and its robots ----------------------------------------------------------
try {
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4000/api/app/quit' -TimeoutSec 10 | Out-Null
  Say 'Adal Keep was asked to stop (its own Quit).'
  Start-Sleep -Seconds 12
} catch { Say 'Adal Keep did not answer its Quit (stopped already, or hung): its programs are ended below.' }

$programs = 'AdalKeep.exe', 'adal-companion.exe', 'adal-agent.exe', 'node.exe'
$browsers = 'AdalBrowser.exe', 'chrome.exe', 'msedge.exe', 'brave.exe'
$ended = 0; $robotBrowsers = 0
for ($round = 0; $round -lt 3; $round++) {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  foreach ($p in $procs) {
    foreach ($root in $roots) {
      if ($programs -contains $p.Name -and (Under $p.ExecutablePath $root)) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $ended++
      } elseif ($browsers -contains $p.Name -and $p.CommandLine) {
        $cl = $p.CommandLine.ToLower()
        # A robot browser: started from this install's folders, with a control port. Not WhatsApp's.
        if ($cl.Contains($root.ToLower() + '\') -and $cl.Contains('--remote-debugging-port') -and -not $cl.Contains('\whatsapp\') -and -not $cl.Contains('--type=')) {
          Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $robotBrowsers++
        }
      }
    }
  }
  Start-Sleep -Seconds 2
}
Say "Ended: $ended Adal Keep program(s), $robotBrowsers robot browser(s)."

# Every robot run waiting, working or paused: cancelled, with a note.
$runsStopped = 0
foreach ($root in $roots) {
  foreach ($b in BackendsOf $root) {
    $node = NodeOf $b
    if (-not (Test-Path $node)) { Say "  (no Node for $b - its runs are left as they are)"; continue }
    $dbs = @((Join-Path $b 'data.sqlite'), (Join-Path $b 'data\data.sqlite')) | Where-Object { Test-Path $_ }
    if (-not $dbs.Count) { continue }
    $out = & $node (Join-Path $Here 'fix-runs.mjs') $b @dbs 2>&1 | ForEach-Object { "$_" }
    $out | ForEach-Object { Say "  $_" }
    foreach ($l in $out) { if ($l -match '^RUNS-TOTAL (\d+)') { $runsStopped += [int]$Matches[1] } }
  }
}
Say "Robot runs stopped: $runsStopped"

# --- 2. Free the PC ------------------------------------------------------------------------------
$freed = 0
foreach ($root in $roots) {
  $caches = @()
  foreach ($b in BackendsOf $root) { $caches += Join-Path $b 'data\lan-release\files' }
  $caches += Join-Path $root 'updates\files'
  foreach ($c in $caches) {
    if (Test-Path $c) { Get-ChildItem $c -Filter *.part -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; $freed++ } }
  }
  Get-ChildItem $root -Filter *.old -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; $freed++ }
}
Say "Freed: $freed leftover file(s) (half-downloads, old programs)."

# --- 3. The newest release from this USB -------------------------------------------------------
$installed = @()
if (-not (Test-Path (Join-Path $Release 'current.json'))) {
  Say 'NOT UPDATED: this USB has no release (release\current.json is missing).'
} else {
  foreach ($root in $roots) {
    $mainBackend = Join-Path $root 'backend'
    if (Test-Path (Join-Path $mainBackend 'server.js')) {
      $node = Join-Path $root 'runtime\node.exe'
      Say "Installing the release into $root ..."
      $out = & $node (Join-Path $Release 'apply-release.mjs') $Release --root $root 2>&1 | ForEach-Object { "$_" }
      $out | ForEach-Object { Say "  $_" }
      if ($LASTEXITCODE -eq 0) { $installed += $root } else { Say "  NOT INSTALLED in $root (see above)" }
    } elseif (Test-Path (Join-Path $root 'adal-companion.exe')) {
      # A Companion without its own server: the pieces go into its update cache; it installs them
      # itself at its next update look (it checks each piece against Adal's signed release).
      $cache = Join-Path $root 'updates\files'
      New-Item -ItemType Directory -Force $cache | Out-Null
      Get-ChildItem (Join-Path $Release 'files') -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $cache $_.Name) -Force }
      Say "  The release's pieces are in $cache (the Companion installs them itself)."
    }
  }
}

# --- 4. Adal Keep again, in the background (never its window) ----------------------------------
foreach ($root in $roots) {
  $launcher = Join-Path $root 'AdalKeep.exe'
  $companion = Join-Path $root 'adal-companion.exe'
  $isCompanion = (Test-Path (Join-Path $root 'companion-install')) -or -not (Test-Path (Join-Path $root 'backend\server.js'))
  if (-not $isCompanion -and (Test-Path $launcher)) {
    Start-Process -FilePath $launcher -ArgumentList '--background' -WindowStyle Hidden
    Say "Started: $root (server only, hidden)."
  } elseif (Test-Path $companion) {
    Start-Process -FilePath $companion -WindowStyle Hidden
    Say "Started: $root Companion (hidden)."
  }
}

# --- 5. The result -------------------------------------------------------------------------------
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/api/health' -TimeoutSec 3 | Out-Null; $up = $true } catch { Start-Sleep -Seconds 3 }
}
Say ''
Say '==================== RESULT ===================='
foreach ($root in $roots) {
  $v = $null
  foreach ($f in (Join-Path $root '.adal-version.json'), (Join-Path $root 'server\.adal-version.json')) {
    if (Test-Path $f) { try { $v = (Get-Content $f -Raw | ConvertFrom-Json).sha } catch {} ; if ($v) { break } }
  }
  $short = if ($v) { $v.Substring(0, [Math]::Min(7, $v.Length)) } else { '?' }
  Say ("  {0}: version {1}{2}" -f $root, $short, $(if ($installed -contains $root) { ' (installed now)' } else { '' }))
}
Say "  Robots stopped: $runsStopped run(s), $robotBrowsers robot browser(s)"
Say ("  Adal Keep answers on this PC: {0}" -f $(if ($up) { 'yes' } else { 'not yet (it may still be starting)' }))
Say "  Log: $LogFile"
Say '================================================'
Stop-Transcript | Out-Null
