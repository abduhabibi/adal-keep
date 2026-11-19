# adal-disconnect.ps1 - ends Adal remote support on this PC (run by "Adal Disconnect.bat").
# The Adal Keep firewall rules stay (Main and Companion need them).
# Removes every Adal key: the old shared one and the per-agency adal-support-<number> ones.
$KEY = 'adal-remote-support|adal-support-\d{5}'
Write-Host "Stopping remote support on $env:COMPUTERNAME..."
try { Stop-Service sshd -Force -ErrorAction Stop } catch {}
try { Set-Service sshd -StartupType Disabled -ErrorAction Stop; Write-Host "  sshd stopped and disabled" } catch { Write-Host "  sshd: not installed" }
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
if (Test-Path $f) {
  $keep = @(Get-Content $f | Where-Object { $_ -notmatch $KEY })
  if ($keep.Count) { Set-Content -Path $f -Value $keep -Encoding ascii } else { Remove-Item $f -Force }
  Write-Host "  Adal support key removed"
}
# The login log stays (sshd.log); this run is written down next to it.
try {
  $logDir = "$env:ProgramData\ssh\logs"
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Add-Content -Path "$logDir\adal-support.log" -Encoding ascii -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') DISCONNECT by $env:USERNAME"
  Write-Host "  login log kept in $logDir"
} catch {}
netsh advfirewall firewall delete rule name="Adal Remote Support (SSH)" | Out-Null
Write-Host "  SSH firewall rule removed"
Write-Host ""
Write-Host "Remote support is OFF on this PC." -ForegroundColor Green
Read-Host 'Press Enter to close'
