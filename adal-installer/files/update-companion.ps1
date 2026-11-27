# update-companion.ps1 - puts new Adal Companion programs on a PC that runs an older Companion, over ssh,
# hidden, the way Main's installs work: everything kept first, a health check, back to the old one on failure.
#
#   powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File update-companion.ps1 [-Package <folder>] [-Root <install folder>]
#
# The package folder: adal-companion.exe, AdalKeep.exe, SHA256SUMS (and this script).
#  - Only the two programs are replaced. The data (companion.conf, companion-id, main-pc.json, keys,
#    the locked copy, the robot browser's profile) stays where it is, untouched.
#  - The new Companion is started for the person signed in at this PC (a task in their session): over ssh
#    a program would run in the ssh session and could not open this user's sealed keys.
#  - Healthy = within 60 s it runs from the install folder, answers on 127.0.0.1:47810 and writes to
#    companion.log. Else: the old programs back, started again, exit code 2.
#  - The robot browser and a person's Adal Keep window are never closed by this script.
# Log: <Root>\update-companion.log.  Exit 0 = new one healthy, 2 = rolled back, 1 = nothing changed.
param([string]$Package = $PSScriptRoot, [string]$Root = '')
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
function Say($m) { $l = "[$(Get-Date -Format 'HH:mm:ss')] $m"; Write-Output $l; if ($script:LogFile) { Add-Content -Path $script:LogFile -Value $l } }

# 1. Where the Companion is: the running program, else the installer's registry entry, else the default.
if (-not $Root) {
  $p = Get-Process adal-companion -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($p) { $Root = Split-Path $p.Path }
}
if (-not $Root) {
  foreach ($k in 'HKLM:\Software\AdalKeepCompanion', 'HKLM:\Software\WOW6432Node\AdalKeepCompanion') {
    $d = (Get-ItemProperty $k -ErrorAction SilentlyContinue).InstallDir
    if ($d -and (Test-Path (Join-Path $d 'adal-companion.exe'))) { $Root = $d; break }
  }
}
if (-not $Root) { $Root = 'C:\AdalKeepCompanion' }
if (-not (Test-Path (Join-Path $Root 'adal-companion.exe'))) { Write-Output "No Adal Companion in $Root - nothing changed"; exit 1 }
$script:LogFile = Join-Path $Root 'update-companion.log'
Say "Adal Companion in $Root, package $Package"

# 2. The package is whole (every file has the SHA-256 the list says).
$names = 'adal-companion.exe', 'AdalKeep.exe'
$sums = @{}
foreach ($line in Get-Content (Join-Path $Package 'SHA256SUMS')) { $f = $line -split '\s+'; if ($f.Count -ge 2) { $sums[$f[1].TrimStart('*')] = $f[0].ToLower() } }
foreach ($n in $names) {
  $h = (Get-FileHash -Algorithm SHA256 (Join-Path $Package $n)).Hash.ToLower()
  if ($sums[$n] -ne $h) { Say "$n in the package is damaged ($h) - nothing changed"; exit 1 }
}

# 3. The person signed in at this PC (the new Companion runs in their session).
$user = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $user) { Say 'Nobody is signed in at this PC: the Companion could not be started for them - nothing changed'; exit 1 }

# 4. Everything kept first: the two programs as they are now.
$keep = Join-Path $Root "update-backup-$stamp"
New-Item -ItemType Directory -Path $keep | Out-Null
foreach ($n in $names) { if (Test-Path (Join-Path $Root $n)) { Copy-Item (Join-Path $Root $n) $keep } }
Say "kept in $keep"

function Stop-Companion {
  # Only the Companion and its hidden AdalKeep.exe of this folder (never the browsers: the robot's or a person's).
  Get-Process adal-companion, AdalKeep -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force
  Start-Sleep -Seconds 2
}
function Start-Companion {
  $task = "Adal Companion start $stamp"
  $act = New-ScheduledTaskAction -Execute (Join-Path $Root 'adal-companion.exe') -WorkingDirectory $Root
  $pr = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $se = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $task -Action $act -Principal $pr -Settings $se -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 3
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
}
function Healthy {
  $log = Join-Path $Root 'companion.log'
  $before = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $p = Get-Process adal-companion -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) }
    if (-not $p) { continue }
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47810/local/host' -Headers @{ 'X-Adal' = '1' } -TimeoutSec 5 } catch { continue }
    $grew = (Test-Path $log) -and ((Get-Item $log).Length -gt $before)
    if ($grew) { Say "running (pid $($p.Id -join ',')), answers on 47810 (main PC: $($r.Content))"; return $true }
  }
  return $false
}

# 5. Stopped, the new programs in, started for the person signed in.
try {
  Stop-Companion
  foreach ($n in $names) {
    $to = Join-Path $Root $n
    if (Test-Path $to) { Move-Item $to "$to.old-$stamp" -Force }   # (a file still in use can be renamed, not overwritten)
    Copy-Item (Join-Path $Package $n) $to
  }
  Say 'new programs in place'
  Start-Companion
  if (Healthy) { Say 'the new Adal Companion is healthy'; exit 0 }
  Say 'the new Adal Companion is not healthy - going back to the old one'
} catch { Say "failed: $($_.Exception.Message) - going back to the old one" }

# 6. Back: the kept programs, started again.
Stop-Companion
foreach ($n in $names) { $b = Join-Path $keep $n; if (Test-Path $b) { Copy-Item $b (Join-Path $Root $n) -Force } }
Start-Companion
if (Healthy) { Say 'the old Adal Companion runs again' } else { Say 'the old Adal Companion did not answer either: look at companion.log' }
exit 2
