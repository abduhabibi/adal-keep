# hw-check.ps1 — the installer's look at this PC: CPU cores, RAM, 32/64-bit, and whether the network link is there.
# Prints one line to the install log and sets the exit code: 0 = strong enough, 3 = below 4 cores / 8 GB (the
# installer then warns; it never blocks: a weak PC still works as an office PC, but its robots go to a stronger PC).
param([string]$Log = "")
$ErrorActionPreference = 'SilentlyContinue'
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if (-not $cores) { $cores = [Environment]::ProcessorCount }
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$bits = if ([Environment]::Is64BitOperatingSystem) { 64 } else { 32 }
$net = 'no link'
try { if (Test-Connection -ComputerName 1.1.1.1 -Count 1 -Quiet) { $net = 'online' } } catch {}
# 8 GB PCs report ~7.4 GB (the graphics chip keeps some), so "below 8 GB" means under 7.
$weak = ($cores -lt 4) -or ($ram -lt 7)
$line = "hardware: $cores cores, $ram GB RAM, $bits-bit Windows, network $net" + $(if ($weak) { ' — BELOW 4 cores / 8 GB' } else { '' })
Write-Output $line
if ($Log) { try { Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format s), $line) } catch {} }
if ($weak) { exit 3 } else { exit 0 }
