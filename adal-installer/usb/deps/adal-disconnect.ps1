# adal-disconnect.ps1 - ends Adal remote support on this PC (run by "Adal Disconnect.bat").
# The Adal Keep firewall rules stay (Main and Companion need them).
$KEY = 'adal-remote-support'
Write-Host "Stopping remote support on $env:COMPUTERNAME..."
try { Stop-Service sshd -Force -ErrorAction Stop } catch {}
try { Set-Service sshd -StartupType Disabled -ErrorAction Stop; Write-Host "  sshd stopped and disabled" } catch { Write-Host "  sshd: not installed" }
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
if (Test-Path $f) {
  $keep = @(Get-Content $f | Where-Object { $_ -notmatch $KEY })
  if ($keep.Count) { Set-Content -Path $f -Value $keep -Encoding ascii } else { Remove-Item $f -Force }
  Write-Host "  Adal support key removed"
}
netsh advfirewall firewall delete rule name="Adal Remote Support (SSH)" | Out-Null
Write-Host "  SSH firewall rule removed"
Write-Host ""
Write-Host "Remote support is OFF on this PC." -ForegroundColor Green
Read-Host 'Press Enter to close'
