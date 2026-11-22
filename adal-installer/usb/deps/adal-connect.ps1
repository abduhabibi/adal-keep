# adal-connect.ps1 - lets Adal (remote support) reach this PC, and opens the
# Adal Keep ports. Run by "Adal Connect - Main.bat" / "Adal Connect - Companion.bat".
# Needs admin (the .bat asks once). Never asks for or stores a password.
param([string]$Role = 'Main', [string]$UsbRoot = '', [string]$User = $env:USERNAME, [string]$PcNumber = '')

$ErrorActionPreference = 'Continue'
$KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE3VWqypYFwdgku7EMt6KQQKG0sHGsOPHmoKJIAY+KxY adal-remote-support'
$MAIN_PORT = 4000
$DISCO_PORT = 45454
if (-not $UsbRoot) { $UsbRoot = Split-Path -Parent $PSScriptRoot }
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { Write-Host $m; $log.Add($m) }

Say "=== Adal Connect ($Role) on $env:COMPUTERNAME - $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="

# 1. OpenSSH Server
Say "[1/5] OpenSSH Server..."
$zip = Join-Path $PSScriptRoot 'OpenSSH-Win64.zip'
$dest = "$env:ProgramFiles\OpenSSH"
if (Get-Service sshd -ErrorAction SilentlyContinue) {
  Say "      already installed"
} elseif (Test-Path $zip) {
  try {
    Say "      unpacking from USB (seconds)..."
    $tmp = Join-Path $env:TEMP 'adal-openssh'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item "$tmp\OpenSSH-Win64\*" $dest -Recurse -Force
    Say "      registering service..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dest\install-sshd.ps1" | Out-Null
    $mp = [Environment]::GetEnvironmentVariable('Path','Machine')
    if ($mp -notlike "*$dest*") { [Environment]::SetEnvironmentVariable('Path', "$mp;$dest", 'Machine') }
  } catch { Say "      unpack failed: $($_.Exception.Message)" }
} else {
  try {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    if ($cap -and $cap.State -ne 'Installed') {
      Say "      zip missing - installing from Windows Update (slow)..."
      Add-WindowsCapability -Online -Name $cap.Name | Out-Null
    }
  } catch { Say "      Add-WindowsCapability failed: $($_.Exception.Message)" }
}
try {
  Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
  Start-Service sshd -ErrorAction Stop
  New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
  Say "      sshd: $((Get-Service sshd).Status), starts with Windows, shell = PowerShell"
} catch { Say "      sshd problem: $($_.Exception.Message)" }

# 2. Adal's key for THIS agency (administrators_authorized_keys: Administrators + SYSTEM only).
# Adal's own support key (adal-remote-support: the support PC on the office
# Wi-Fi) always goes in. Each agency also has its own key, named by its Main PC's
# 5-digit number; the USB carries the public halves in
# deps\support-keys\<number>.pub, and that one goes in beside it (2026-11-22).
# Keys are only added, never removed here.
Say "[2/5] Adal support key..."
$sshDir = "$env:ProgramData\ssh"
$logDir = Join-Path $sshDir 'logs'
# The number is read from this PC itself; asking is the last resort.
function InstDirEarly($k, $d) { try { (Get-ItemProperty "HKLM:\Software\$k" -ErrorAction Stop).InstallDir } catch { $d } }
function NumFromJson($f) {
  try { if (Test-Path $f) { $n = [string]((Get-Content $f -Raw | ConvertFrom-Json).pc_number); if ($n -match '^\d{5}$') { return $n } } } catch {}
  return $null
}
function NumFromConf($f) {
  try { if (Test-Path $f) { $l = Get-Content $f | Where-Object { $_ -match '^\s*ADAL_PC_NUMBER\s*=\s*"?(\d{5})"?\s*$' } | Select-Object -First 1; if ($l -match '(\d{5})') { return $Matches[1] } } } catch {}
  return $null
}
if ($PcNumber -notmatch '^\d{5}$') {
  $mDir = InstDirEarly 'AdalKeep' 'C:\AdalKeep'
  $cDir = InstDirEarly 'AdalKeepCompanion' 'C:\AdalKeepCompanion'
  $mj = { NumFromJson (Join-Path $mDir 'backend\data\main-pc.json') }
  $cc = { NumFromConf (Join-Path $cDir 'companion.conf') }
  $cj = { $r = $null; foreach ($f in @((Join-Path $cDir 'main-pc.json'), (Join-Path $cDir 'backend\data\main-pc.json'), (Join-Path $cDir 'data\main-pc.json'))) { $r = NumFromJson $f; if ($r) { break } }; $r }
  if ($Role -eq 'Main') { $cands = @(@($mj, "main-pc.json of this Main PC"), @($cc, "companion.conf"), @($cj, "main-pc.json in the Companion folder")) }
  else { $cands = @(@($cc, "companion.conf of this Companion"), @($cj, "main-pc.json in the Companion folder"), @($mj, "main-pc.json of the Main install")) }
  foreach ($c in $cands) {
    $n = & $c[0]
    if ($n) { $PcNumber = $n; Say "      agency PC number $PcNumber (read from $($c[1]))"; break }
  }
}
# A USB made for one agency carries just its key: that number, without asking.
if ($PcNumber -notmatch '^\d{5}$') {
  $only = @(Get-ChildItem (Join-Path $PSScriptRoot 'support-keys') -Filter '*.pub' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -match '^\d{5}$' })
  if ($only.Count -eq 1) { $PcNumber = $only[0].BaseName; Say "      agency PC number $PcNumber (the only key file on this USB)" }
}
while ($PcNumber -notmatch '^\d{5}$') {
  Say "      Could not find this PC's number by itself."
  $PcNumber = (Read-Host "      The agency's 5-digit PC number (Main PC: Adal Keep -> Settings -> Main PC; or the number in C:\AdalKeep\backend\data\main-pc.json)").Trim()
}
$keyFile = Join-Path $PSScriptRoot "support-keys\$PcNumber.pub"
$agencyKey = $null
if (Test-Path $keyFile) {
  $agencyKey = (Get-Content $keyFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^ssh-ed25519 \S+' } | Select-Object -First 1)
  if ($agencyKey) { $agencyKey = (($agencyKey.Trim() -split '\s+')[0..1] -join ' ') + " adal-support-$PcNumber" }
}
try {
  New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
  $f = Join-Path $sshDir 'administrators_authorized_keys'
  $have = @(if (Test-Path $f) { Get-Content $f -ErrorAction SilentlyContinue })
  $want = @($KEY); if ($agencyKey) { $want += $agencyKey }
  $missing = @($want | Where-Object { $have -notcontains $_ })
  if ($missing) {
    if ($have.Count -and (Get-Content $f -Raw) -notmatch "`n$") { Add-Content -Path $f -Value '' -Encoding ascii }
    Add-Content -Path $f -Value $missing -Encoding ascii
  }
  Say "      Adal's support key in place$(if ($agencyKey) { ", and the key for PC $PcNumber" })"
  if (-not $agencyKey) { Say "      (no key for PC $PcNumber on this USB: deps\support-keys\$PcNumber.pub - Adal's key alone)" }
  icacls.exe $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
} catch { Say "      key problem: $($_.Exception.Message)" }

# Every SSH login is written down on this PC: sshd logs at VERBOSE (the key's
# fingerprint, user and address of each login) into $logDir\sshd.log
# (SyslogFacility LOCAL0 = log file on Windows OpenSSH). The settings go at the
# top of sshd_config: below its "Match" block SyslogFacility would stop sshd.
try {
  $cfg = Join-Path $sshDir 'sshd_config'
  if (-not (Test-Path $cfg) -and (Test-Path "$env:ProgramFiles\OpenSSH\sshd_config_default")) {
    Copy-Item "$env:ProgramFiles\OpenSSH\sshd_config_default" $cfg
  }
  if (Test-Path $cfg) {
    $lines = @(Get-Content $cfg | Where-Object { $_ -notmatch '^\s*#?\s*(LogLevel|SyslogFacility)\b' -and $_ -notmatch '^# Adal: every login is logged' })
    Set-Content -Path $cfg -Value (@('# Adal: every login is logged', 'SyslogFacility LOCAL0', 'LogLevel VERBOSE') + $lines) -Encoding ascii
  }
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Add-Content -Path (Join-Path $logDir 'adal-support.log') -Encoding ascii -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') CONNECT $Role PC=$PcNumber key=adal-remote-support$(if ($agencyKey) { " + adal-support-$PcNumber" }) by $User"
  Restart-Service sshd -ErrorAction Stop
  Say "      every SSH login is logged in $logDir\sshd.log"
} catch { Say "      log setup problem: $($_.Exception.Message)" }

# 3. Firewall: every network type (Public too - the usual blocker)
Say "[3/5] Firewall (all network types)..."
function Rule($name, $proto, $port, $from = 'any') {
  netsh advfirewall firewall delete rule name="$name" | Out-Null
  netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=$proto localport=$port remoteip=$from profile=any | Out-Null
}
# SSH only from the office network itself (and OpenSSH's own rule too).
Rule 'Adal Remote Support (SSH)' TCP 22 'localsubnet'
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress LocalSubnet -ErrorAction SilentlyContinue
Rule 'Adal Keep' TCP $MAIN_PORT
Rule 'Adal Keep Discovery' UDP $DISCO_PORT
function InstDir($k, $d) { try { (Get-ItemProperty "HKLM:\Software\$k" -ErrorAction Stop).InstallDir } catch { $d } }
$MAINDIR = InstDir 'AdalKeep' 'C:\AdalKeep'
$COMPDIR = InstDir 'AdalKeepCompanion' 'C:\AdalKeepCompanion'
foreach ($p in @("$MAINDIR\runtime\node.exe", "$COMPDIR\adal-companion.exe")) {
  if (Test-Path $p) {
    # Windows may have added BLOCK rules for these on its own; a block beats every allow.
    Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $n = if ($p -like '*node.exe') { 'Adal Keep Server' } else { 'Adal Keep Companion' }
    netsh advfirewall firewall delete rule name="$n" | Out-Null
    netsh advfirewall firewall add rule name="$n" dir=in action=allow program="$p" profile=any | Out-Null
  }
}
try {
  $prof = (Get-NetConnectionProfile | ForEach-Object { "$($_.InterfaceAlias)=$($_.NetworkCategory)" }) -join ', '
  Say "      rules added; networks: $prof"
  $shields = Get-NetFirewallProfile | Where-Object { $_.AllowInboundRules -eq 'False' } | ForEach-Object { $_.Name }
  if ($shields) { Say "      WARNING: 'block all incoming' is on for: $($shields -join ', ') - turning it off"; Set-NetFirewallProfile -Name $shields -AllowInboundRules True }
} catch {}

# 4. Adal Keep itself
Say "[4/5] Adal Keep..."
$listen = netstat -ano | Select-String ":$MAIN_PORT\s" | Select-Object -First 3 | ForEach-Object { $_.Line.Trim() }
Say "      port ${MAIN_PORT}: $(if ($listen) { $listen -join ' | ' } else { 'nothing listening' })"
$conf = "$COMPDIR\companion.conf"
if (Test-Path $conf) { Say "      companion.conf: $((Get-Content $conf | Where-Object { $_ -match '^ADAL_HOST_URL' }) -join ' ')" }

# 5. Updates now, and the office network the PCs share on
Say "[5/5] Updates and sharing on the office network..."
# What the PCs of an office share with each other: the newest version (UDP 45455 +
# a Companion's port 47810), the copy of the agency and the server in waiting
# (47810), which Companion stands in for the main PC (UDP 45456), the stand-in
# itself (4000, already open above).
Rule 'Adal Keep Updates (LAN)' UDP 45455
Rule 'Adal Keep Stand-in (LAN)' UDP 45456
Rule 'Adal Keep Companion (LAN)' TCP 47810
Say "      the office network may share updates, the copy, the server and robots"
$ver = { param($dir) try { ((Get-Content (Join-Path $dir '.adal-version.json') -Raw | ConvertFrom-Json).sha).Substring(0,7) } catch { '?' } }
$updated = $false
if ($Role -eq 'Main' -and (Test-Path "$MAINDIR\backend")) {
  Say "      version now: $(& $ver $MAINDIR)"
  try {
    # The newest signed version from Supabase, or from a PC of the office that has it.
    $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$MAIN_PORT/api/system/update/apply" -ContentType 'application/json' -Body '{"force":true}' -TimeoutSec 900
    Say "      $(if ($r.message) { $r.message } elseif ($r.ok) { 'updated' } else { ($r | ConvertTo-Json -Compress) })"
    $updated = $true
  } catch { Say "      the running Adal Keep could not update itself now: $($_.Exception.Message)" }
} elseif ($Role -eq 'Companion' -and (Test-Path "$COMPDIR\adal-companion.exe")) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47810/update/apply' -Headers @{ 'X-Adal' = '1' } -TimeoutSec 900
    Say "      $(if ($r.message) { $r.message } else { ($r | ConvertTo-Json -Compress) })"
    $updated = $true
  } catch { Say "      the Companion could not update itself now: $($_.Exception.Message)" }
}
if (-not $updated) {
  # No internet, or it is not running: the installer on this USB (the database,
  # documents and sign-ins are kept; only the program is put in again).
  $inst = if ($Role -eq 'Main') { Join-Path $UsbRoot '2 - Install Adal Main.exe' } else { Join-Path $UsbRoot '3 - Install Adal Companion.exe' }
  if (Test-Path $inst) {
    $wasOn = @(Get-Process -Name 'AdalKeep', 'adal-companion' -ErrorAction SilentlyContinue).Count -gt 0
    Say "      installing the version on this USB (data kept)..."
    $p = Start-Process -FilePath $inst -ArgumentList '/S' -Wait -PassThru
    Say "      installer finished ($($p.ExitCode), 0 = done)"
    if ($wasOn) {
      # It was running: its background part again (never a window nobody asked for).
      if ($Role -eq 'Main') { Start-Process "$MAINDIR\AdalKeep.exe" -ArgumentList '--background' -ErrorAction SilentlyContinue }
      else { Start-Process "$COMPDIR\adal-companion.exe" -ErrorAction SilentlyContinue }
    }
  } else { Say "      no installer on this USB for a $Role PC" }
}

$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { $_.IPAddress }) -join ', '
$summary = @"

==============================================
  PC name:       $env:COMPUTERNAME
  Windows user:  $User
  LAN IPs:       $lan
  Agency PC no.: $PcNumber $(if ($agencyKey) { "(Adal's key + the agency's own)" } else { "(Adal's key; no agency key file on USB)" })
  Login log:     $logDir\sshd.log

  Tell Claude: $Role ready
==============================================
"@
$log.Add($summary)
try { $log | Set-Content -Path "$UsbRoot\Adal-Connect-$env:COMPUTERNAME.txt" -Encoding utf8 } catch {}
Write-Host $summary -ForegroundColor Green
try {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($summary, "Adal Connect - $Role", 'OK', 'Information') | Out-Null
} catch {}
Read-Host 'Press Enter to close'
