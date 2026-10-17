# Adal Keep - stop a running copy before files are replaced (install,
# reinstall or uninstall). Only processes started from $InstDir are touched,
# plus the keep-alive windows (run-server.bat / start-companion.bat) that
# would otherwise restart them a few seconds later.
param([Parameter(Mandatory = $true)][string]$InstDir)
$ErrorActionPreference = 'SilentlyContinue'
$root = $InstDir.TrimEnd('\') + '\'

Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" |
    Where-Object { $_.CommandLine -like "*$root*" -and ($_.CommandLine -like '*run-server.bat*' -or $_.CommandLine -like '*start-companion.bat*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Get-Process node, AdalKeep, adal-companion, adal-agent |
    Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force

Start-Sleep -Seconds 1
exit 0
