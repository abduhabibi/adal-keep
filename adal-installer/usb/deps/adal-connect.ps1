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
Say "[1/4] OpenSSH Server..."
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
# Each agency has its own key, named by its Main PC's 5-digit number; the USB
# carries the public halves in deps\support-keys\<number>.pub. Only that one is
# installed, and every other Adal key (the old shared adal-remote-support one,
# other agencies') is removed. Without a file for the number, the old shared key
# stays as it was, so nothing breaks until the agency's key is on the USB.
Say "[2/4] Adal support key..."
$sshDir = "$env:ProgramData\ssh"
$logDir = Join-Path $sshDir 'logs'
while ($PcNumber -notmatch '^\d{5}$') {
  $PcNumber = (Read-Host "      The agency's 5-digit PC number (Main PC: Adal Keep -> Settings -> Main PC)").Trim()
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
  if ($agencyKey) {
    $keep = @($have | Where-Object { $_ -and $_ -notmatch 'adal-remote-support|adal-support-\d{5}' })
    Set-Content -Path $f -Value (@($keep) + $agencyKey) -Encoding ascii
    Say "      key for PC $PcNumber in place (old shared key removed)"
  } else {
    if (-not ($have -contains $KEY)) { Add-Content -Path $f -Value $KEY -Encoding ascii }
    Say "      WARNING: no key for PC $PcNumber on this USB (deps\support-keys\$PcNumber.pub)"
    Say "      the old shared key stays; Adal: run scripts/support-key.sh $PcNumber, then Connect again"
  }
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
  Add-Content -Path (Join-Path $logDir 'adal-support.log') -Encoding ascii -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') CONNECT $Role PC=$PcNumber key=$(if ($agencyKey) { "adal-support-$PcNumber" } else { 'adal-remote-support (old shared)' }) by $User"
  Restart-Service sshd -ErrorAction Stop
  Say "      every SSH login is logged in $logDir\sshd.log"
} catch { Say "      log setup problem: $($_.Exception.Message)" }

# 3. Firewall: every network type (Public too - the usual blocker)
Say "[3/4] Firewall (all network types)..."
function Rule($name, $proto, $port) {
  netsh advfirewall firewall delete rule name="$name" | Out-Null
  netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=$proto localport=$port profile=any | Out-Null
}
Rule 'Adal Remote Support (SSH)' TCP 22
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
Say "[4/4] Adal Keep..."
$listen = netstat -ano | Select-String ":$MAIN_PORT\s" | Select-Object -First 3 | ForEach-Object { $_.Line.Trim() }
Say "      port ${MAIN_PORT}: $(if ($listen) { $listen -join ' | ' } else { 'nothing listening' })"
$conf = "$COMPDIR\companion.conf"
if (Test-Path $conf) { Say "      companion.conf: $((Get-Content $conf | Where-Object { $_ -match '^ADAL_HOST_URL' }) -join ' ')" }

$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { $_.IPAddress }) -join ', '
$summary = @"

==============================================
  PC name:       $env:COMPUTERNAME
  Windows user:  $User
  LAN IPs:       $lan
  Agency PC no.: $PcNumber $(if ($agencyKey) { '(own key)' } else { '(OLD shared key - no key file on USB)' })
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
