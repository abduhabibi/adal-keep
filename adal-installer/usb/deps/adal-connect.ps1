# adal-connect.ps1 - lets Adal (remote support) reach this PC, and opens the
# Adal Keep ports. Run by "Adal Connect - Main.bat" / "Adal Connect - Companion.bat".
# Needs admin (the .bat asks once). Never asks for or stores a password.
param([string]$Role = 'Main', [string]$UsbRoot = '', [string]$User = $env:USERNAME)

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
try {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
  if ($cap -and $cap.State -ne 'Installed') {
    Say "      installing (a few minutes)..."
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
  }
} catch { Say "      Add-WindowsCapability failed: $($_.Exception.Message)" }
try {
  Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
  Start-Service sshd -ErrorAction Stop
  New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
  Say "      sshd: $((Get-Service sshd).Status), starts with Windows, shell = PowerShell"
} catch { Say "      sshd problem: $($_.Exception.Message)" }

# 2. Adal's key (administrators_authorized_keys: Administrators + SYSTEM only)
Say "[2/4] Adal support key..."
try {
  $dir = "$env:ProgramData\ssh"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $f = Join-Path $dir 'administrators_authorized_keys'
  $have = if (Test-Path $f) { Get-Content $f -ErrorAction SilentlyContinue } else { @() }
  if (-not ($have -contains $KEY)) { Add-Content -Path $f -Value $KEY -Encoding ascii }
  icacls.exe $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
  Say "      key in place"
} catch { Say "      key problem: $($_.Exception.Message)" }

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
