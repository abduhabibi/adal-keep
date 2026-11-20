# =====================================================================
#  Adal Keep - remote support by Adal, built into Adal Keep (no more
#  double-clicking "Adal Connect"). Same steps as usb\deps\adal-connect.ps1:
#    - the OpenSSH server (from OpenSSH-Win64.zip beside this script), Automatic
#    - Adal's support key in administrators_authorized_keys (right ACLs)
#    - the firewall rules: TCP 22, TCP 4000, UDP 45454 and the programs, all profiles
#
#  Lives in C:\ProgramData\AdalSupport (administrators write, everyone reads):
#  it runs as SYSTEM from a scheduled task, so a normal user must not be able
#  to change it. Never asks for or stores a password, never shows a window.
#
#  -Mode Install   installer: registers the task, then does Auto
#  -Mode Auto      the task (at start-up, every 6 hours, and on demand from
#                  AdalKeep.exe / Settings): switch on => make sure everything is
#                  there and repair what is not; switch off => do what
#                  "Adal Disconnect" does. The switch is <InstDir>\support-off.flag.
#  -Mode Remove    uninstaller: the task goes (the key and the log stay)
#
#  Every change is written to C:\ProgramData\ssh\logs\adal-support.log.
#  An update of Adal Keep never touches the key: this script only adds or
#  repairs it, and removes it only when the switch is off.
# =====================================================================
param(
    [ValidateSet('Install', 'Auto', 'Remove')][string]$Mode = 'Auto',
    [string]$InstDir = '',
    [ValidateSet('Main', 'Companion')][string]$Role = 'Main'
)
$ErrorActionPreference = 'Continue'
$SHARED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE3VWqypYFwdgku7EMt6KQQKG0sHGsOPHmoKJIAY+KxY adal-remote-support'
$HOME_DIR = $PSScriptRoot
$sshDir = "$env:ProgramData\ssh"
$logDir = Join-Path $sshDir 'logs'
$logFile = Join-Path $logDir 'adal-support.log'
$taskName = "Adal Keep Support ($Role)"
$stateFile = Join-Path $HOME_DIR "state-$Role.txt"
if (-not $InstDir) { $InstDir = if ($Role -eq 'Main') { 'C:\AdalKeep' } else { 'C:\AdalKeepCompanion' } }
$flag = Join-Path $InstDir 'support-off.flag'

function Log($m) {
    try {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        Add-Content -Path $logFile -Encoding ascii -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    } catch {}
}

if ($Mode -eq 'Remove') {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Log "UNINSTALL $Role task removed (key and log stay)"
    exit 0
}

# ------------------------------------------------------------------ Install
if ($Mode -eq 'Install') {
    try {
        # Only administrators and SYSTEM write here; users read (SYSTEM runs this folder).
        icacls.exe $HOME_DIR /inheritance:r /grant '*S-1-5-32-544:(OI)(CI)F' /grant '*S-1-5-18:(OI)(CI)F' /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
        $me = Join-Path $HOME_DIR 'support-setup.ps1'
        $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$me`" -Mode Auto -InstDir `"$InstDir`" -Role $Role"
        $t1 = New-ScheduledTaskTrigger -AtStartup
        $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 6)
        $pr = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest
        $se = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $act -Trigger @($t1, $t2) -Principal $pr -Settings $se -Force | Out-Null
        # Any signed-in user may start (not edit) the task: AdalKeep.exe and Settings do, with no prompt.
        try {
            $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
            $svc.GetFolder('\').GetTask($taskName).SetSecurityDescriptor('D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FRFX;;;AU)', 0)
        } catch { Log "INSTALL $Role could not let users start the task: $($_.Exception.Message)" }
        Log "INSTALL $Role task '$taskName' registered (InstDir=$InstDir)"
    } catch { Log "INSTALL $Role task problem: $($_.Exception.Message)" }
}

# ------------------------------------------------------------------ Auto
# One run at a time per PC (the task, AdalKeep.exe and Settings may all ask).
$mutex = New-Object System.Threading.Mutex($false, 'Global\AdalKeepSupportSetup')
if (-not $mutex.WaitOne(120000)) { exit 0 }
try {
    $on = -not (Test-Path -LiteralPath $flag)
    $prev = if (Test-Path $stateFile) { (Get-Content $stateFile -ErrorAction SilentlyContinue | Select-Object -First 1) } else { '' }
    $now = if ($on) { 'on' } else { 'off' }
    if ($Mode -eq 'Auto' -and $prev -and $prev -ne $now) {
        $who = ''; if (-not $on) { try { $who = " ($((Get-Content -LiteralPath $flag -ErrorAction Stop | Select-Object -First 1)))" } catch {} }
        Log "SETTING $Role Remote support by Adal turned $($now.ToUpper()) in Settings$who"
    }
    if ($prev -ne $now) { try { Set-Content -Path $stateFile -Value $now -Encoding ascii } catch {} }

    $svcName = 'sshd'
    $keyPattern = 'adal-remote-support|adal-support-\d{5}'

    if (-not $on) {
        # ---- the same as Adal Disconnect
        $changed = @()
        $s = Get-Service $svcName -ErrorAction SilentlyContinue
        if ($s) {
            if ($s.Status -eq 'Running') { try { Stop-Service $svcName -Force -ErrorAction Stop; $changed += 'sshd stopped' } catch {} }
            $wmi = Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue
            if ($wmi -and $wmi.StartMode -ne 'Disabled') { try { Set-Service $svcName -StartupType Disabled -ErrorAction Stop; $changed += 'sshd disabled' } catch {} }
        }
        $f = Join-Path $sshDir 'administrators_authorized_keys'
        if (Test-Path $f) {
            $have = @(Get-Content $f -ErrorAction SilentlyContinue)
            if ($have | Where-Object { $_ -match $keyPattern }) {
                $keep = @($have | Where-Object { $_ -and $_ -notmatch $keyPattern })
                if ($keep.Count) { Set-Content -Path $f -Value $keep -Encoding ascii } else { Remove-Item $f -Force }
                $changed += 'support key removed'
            }
        }
        if (-not ((netsh advfirewall firewall show rule name="Adal Remote Support (SSH)" | Out-String) -match 'No rules match')) {
            netsh advfirewall firewall delete rule name="Adal Remote Support (SSH)" | Out-Null
            $changed += 'SSH firewall rule removed'
        }
        if ($changed) { Log "DISCONNECT $Role (switch off): $($changed -join ', ')" }
        exit 0
    }

    # ---- switch on: everything there, repair what is not
    $fixed = @()

    # 1. OpenSSH Server
    $zip = Join-Path $HOME_DIR 'OpenSSH-Win64.zip'
    $dest = "$env:ProgramFiles\OpenSSH"
    if (-not (Get-Service $svcName -ErrorAction SilentlyContinue)) {
        if (Test-Path $zip) {
            try {
                $tmp = Join-Path $env:TEMP 'adal-openssh'
                Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
                Expand-Archive -Path $zip -DestinationPath $tmp -Force
                New-Item -ItemType Directory -Path $dest -Force | Out-Null
                Copy-Item "$tmp\OpenSSH-Win64\*" $dest -Recurse -Force
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$dest\install-sshd.ps1" | Out-Null
                $mp = [Environment]::GetEnvironmentVariable('Path', 'Machine')
                if ($mp -notlike "*$dest*") { [Environment]::SetEnvironmentVariable('Path', "$mp;$dest", 'Machine') }
                Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
                $fixed += 'OpenSSH server installed from the bundled zip'
            } catch { Log "ERROR $Role OpenSSH unpack failed: $($_.Exception.Message)" }
        } else {
            try {
                $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
                if ($cap -and $cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null; $fixed += 'OpenSSH server installed from Windows Update' }
            } catch { Log "ERROR $Role OpenSSH: no zip and Windows Update failed: $($_.Exception.Message)" }
        }
    }
    if (-not (Get-Service $svcName -ErrorAction SilentlyContinue)) { Log "ERROR $Role no OpenSSH server on this PC; nothing more to do"; exit 0 }

    # 2. the key (the agency's own when its file is here, else the old shared one)
    $pc = $null
    foreach ($j in @((Join-Path $InstDir 'backend\data\main-pc.json'), (Join-Path $InstDir 'main-pc.json'), (Join-Path $InstDir 'data\main-pc.json'))) {
        try { if (Test-Path $j) { $n = [string]((Get-Content $j -Raw | ConvertFrom-Json).pc_number); if ($n -match '^\d{5}$') { $pc = $n; break } } } catch {}
    }
    if (-not $pc) {
        $cf = Join-Path $InstDir 'companion.conf'
        try { if (Test-Path $cf) { $l = Get-Content $cf | Where-Object { $_ -match '^\s*ADAL_PC_NUMBER\s*=\s*"?(\d{5})"?\s*$' } | Select-Object -First 1; if ($l -match '(\d{5})') { $pc = $Matches[1] } } } catch {}
    }
    $pubs = @(Get-ChildItem (Join-Path $HOME_DIR 'support-keys') -Filter '*.pub' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -match '^\d{5}$' })
    if (-not $pc -and $pubs.Count -eq 1) { $pc = $pubs[0].BaseName }
    $agencyKey = $null
    if ($pc) {
        $kf = Join-Path $HOME_DIR "support-keys\$pc.pub"
        if (Test-Path $kf) {
            $k = Get-Content $kf -ErrorAction SilentlyContinue | Where-Object { $_ -match '^ssh-ed25519 \S+' } | Select-Object -First 1
            if ($k) { $agencyKey = (($k.Trim() -split '\s+')[0..1] -join ' ') + " adal-support-$pc" }
        }
    }
    $want = if ($agencyKey) { $agencyKey } else { $SHARED }
    $f = Join-Path $sshDir 'administrators_authorized_keys'
    $have = @(if (Test-Path $f) { Get-Content $f -ErrorAction SilentlyContinue })
    $ok = ($have -contains $want) -and (-not $agencyKey -or -not ($have | Where-Object { $_ -match 'adal-remote-support' }))
    if (-not $ok) {
        try {
            New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
            if ($agencyKey) { $keep = @($have | Where-Object { $_ -and $_ -notmatch $keyPattern }); Set-Content -Path $f -Value (@($keep) + $agencyKey) -Encoding ascii }
            else { Add-Content -Path $f -Value $want -Encoding ascii }
            $fixed += "support key $(if ($agencyKey) { "for PC $pc" } else { '(shared)' }) put in place"
        } catch { Log "ERROR $Role key: $($_.Exception.Message)" }
    }
    try {
        if (Test-Path $f) {
            $acl = Get-Acl $f
            $names = @($acl.Access | ForEach-Object { $_.IdentityReference.Value })
            $bad = (-not $acl.AreAccessRulesProtected) -or ($names | Where-Object { $_ -notmatch '^(BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM)$' })
            if ($bad) { icacls.exe $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null; $fixed += 'key file permissions repaired' }
        }
    } catch {}

    # 3. sshd: logging (every login written down), service Automatic and running, shell
    $restart = $false
    try {
        $cfg = Join-Path $sshDir 'sshd_config'
        if (-not (Test-Path $cfg) -and (Test-Path "$env:ProgramFiles\OpenSSH\sshd_config_default")) { Copy-Item "$env:ProgramFiles\OpenSSH\sshd_config_default" $cfg }
        if ((Test-Path $cfg) -and -not (Select-String -Path $cfg -Pattern '^# Adal: every login is logged' -Quiet)) {
            $lines = @(Get-Content $cfg | Where-Object { $_ -notmatch '^\s*#?\s*(LogLevel|SyslogFacility)\b' })
            Set-Content -Path $cfg -Value (@('# Adal: every login is logged', 'SyslogFacility LOCAL0', 'LogLevel VERBOSE') + $lines) -Encoding ascii
            $restart = $true; $fixed += 'login logging set'
        }
    } catch {}
    try {
        $dsh = (Get-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue).DefaultShell
        if (-not $dsh) {
            New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
            New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
            $fixed += 'default shell = PowerShell'
        }
    } catch {}
    $wmi = Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.StartMode -ne 'Auto') { try { Set-Service $svcName -StartupType Automatic -ErrorAction Stop; $fixed += 'sshd set to Automatic' } catch { Log "ERROR $Role sshd Automatic: $($_.Exception.Message)" } }
    $s = Get-Service $svcName
    if ($s.Status -ne 'Running') { try { Start-Service $svcName -ErrorAction Stop; $fixed += 'sshd started' } catch { Log "ERROR $Role sshd start: $($_.Exception.Message)" } }
    elseif ($restart) { try { Restart-Service $svcName -ErrorAction Stop } catch {} }

    # 4. firewall: every network type
    function RuleThere($name) { -not ((netsh advfirewall firewall show rule name="$name" | Out-String) -match 'No rules match') }
    function PortRule($name, $proto, $port) {
        if (-not (RuleThere $name)) {
            netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=$proto localport=$port profile=any | Out-Null
            $script:fixed += "firewall rule '$name' added"
        }
    }
    PortRule 'Adal Remote Support (SSH)' TCP 22
    PortRule 'Adal Keep' TCP 4000
    PortRule 'Adal Keep Discovery' UDP 45454
    $progs = @(@("$InstDir\runtime\node.exe", 'Adal Keep Server'), @("$InstDir\adal-companion.exe", 'Adal Keep Companion'))
    foreach ($p in $progs) {
        if (Test-Path $p[0]) {
            # Windows may add BLOCK rules for these by itself; a block beats every allow.
            Get-NetFirewallApplicationFilter -Program $p[0] -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
                Where-Object { $_.Action -eq 'Block' } | ForEach-Object { Remove-NetFirewallRule -InputObject $_ -ErrorAction SilentlyContinue; $fixed += "Windows' block rule for $(Split-Path $p[0] -Leaf) removed" }
            if (-not (RuleThere $p[1])) {
                netsh advfirewall firewall add rule name="$($p[1])" dir=in action=allow program="$($p[0])" profile=any | Out-Null
                $fixed += "firewall rule '$($p[1])' added"
            }
        }
    }

    if ($Mode -eq 'Install') { Log "CONNECT $Role PC=$(if ($pc) { $pc } else { '?' }) key=$(if ($agencyKey) { "adal-support-$pc" } else { 'adal-remote-support (shared)' }) (installer)" }
    if ($fixed) { Log "REPAIR $Role : $($fixed -join '; ')" }
} finally { try { $mutex.ReleaseMutex() } catch {} }
exit 0
