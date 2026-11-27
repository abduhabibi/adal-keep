# pc-check.ps1 — is this PC equipped well enough for Adal Keep? (the owner, 2026-11-27)
#
# Main PC:      8 GB RAM or more, an SSD, a network cable (not Wi-Fi), 20 GB free disk, 4 cores or more.
# Companion PC: 4 GB RAM or more, an SSD preferred.
# Both: a network link under 20 Mbit/s is weak (Main's old USB-1.1 Wi-Fi stick, 2026-11-26: ~4-5 Mbit/s).
#
#   -Json             the measurements as one JSON line (Adal Keep's Settings -> This PC: services/pcCheck.js,
#                     which applies the same rules — keep the numbers below and there the same)
#   -Role Main|Companion  (without -Json) the plain check list, one line a check: "OK  ..." / "WEAK ... -> fix"
#   -Out <file>       the check list also written there (the installer shows it)
# Exit code: 0 = all OK, 3 = something is weak (the installer warns; it NEVER blocks), 10 = switched off.
# Off: ADAL_PC_CHECK=0 (this PC's environment).
param([switch]$Json, [string]$Role = 'Main', [string]$InstDir = '', [string]$Out = '', [string]$Log = '')
$ErrorActionPreference = 'SilentlyContinue'
if ($env:ADAL_PC_CHECK -eq '0') { exit 10 }

# ---------------------------------------------------------------- measure --
$cs = Get-CimInstance Win32_ComputerSystem
$cores = [int]$cs.NumberOfLogicalProcessors
if (-not $cores) { $cores = [Environment]::ProcessorCount }
$ram = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)

# The disk Adal Keep lives on (its install folder's drive, else Windows' drive).
$drive = $env:SystemDrive
if ($InstDir) { try { $q = Split-Path -Qualifier $InstDir; if ($q) { $drive = $q } } catch {} }
$letter = $drive.TrimEnd(':')
$free = $null
$ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($letter):'"
if ($ld) { $free = [math]::Round($ld.FreeSpace / 1GB, 1) }
$media = 'unknown'; $bus = ''
try {
  $part = Get-Partition -DriveLetter $letter | Select-Object -First 1
  $pd = Get-PhysicalDisk | Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
  if ($pd) {
    $bus = [string]$pd.BusType
    switch ([string]$pd.MediaType) { 'SSD' { $media = 'SSD' } 'HDD' { $media = 'HDD' } 'SCM' { $media = 'SSD' } }
    if ($media -eq 'unknown' -and $bus -eq 'NVMe') { $media = 'SSD' }   # NVMe is always solid state
  }
} catch {}

# The link the PC goes out on: the default route with the lowest metric.
$kind = 'none'; $name = ''; $desc = ''; $mbps = $null; $usb = $false
try {
  $routes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 | ForEach-Object {
    $ifm = (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4).InterfaceMetric
    [pscustomobject]@{ ifIndex = $_.ifIndex; m = $_.RouteMetric + $ifm }
  } | Sort-Object m
  foreach ($r in $routes) {
    $a = Get-NetAdapter -InterfaceIndex $r.ifIndex
    if (-not $a -or $a.Status -ne 'Up') { continue }
    $name = [string]$a.Name; $desc = [string]$a.InterfaceDescription
    $pm = [string]$a.PhysicalMediaType
    if ($pm -match '802\.11|Wireless' -or $a.NdisPhysicalMedium -eq 9) { $kind = 'wifi' }
    elseif ($pm -match '802\.3' -or $a.NdisPhysicalMedium -eq 14) { $kind = 'cable' }
    else { $kind = 'other' }
    $bps = [double]$a.ReceiveLinkSpeed
    if (-not $bps) { $bps = [double]$a.Speed }
    if ($bps) { $mbps = [math]::Round($bps / 1e6, 1) }
    $usb = ([string]$a.PnPDeviceID -like 'USB\*') -or ($desc -match 'USB')
    break
  }
} catch {}
# Network ports with no cable in them (the cable fix says where to plug it).
$freePorts = 0
try { $freePorts = @(Get-NetAdapter -Physical | Where-Object { $_.Status -ne 'Up' -and ([string]$_.PhysicalMediaType -match '802\.3') -and ([string]$_.PnPDeviceID -notlike 'USB\*') }).Count } catch {}

$facts = [ordered]@{ ram_gb = $ram; cores = $cores; disk = [ordered]@{ drive = "$($letter):"; media = $media; bus = $bus; free_gb = $free }
  net = [ordered]@{ kind = $kind; name = $name; desc = $desc; mbps = $mbps; usb = $usb; free_ports = $freePorts } }
if ($Json) { $facts | ConvertTo-Json -Compress -Depth 4; exit 0 }

# ------------------------------------------------------------------ rules --
# (services/pcCheck.js has the same rules for Settings -> This PC.)
# An "8 GB" PC reports ~7.4 GB (the graphics chip keeps some), a "4 GB" one ~3.7.
$lines = New-Object System.Collections.Generic.List[string]
$weak = $false
function Add-Ok($t) { $lines.Add("OK    $t") }
function Add-Weak($t, $fix) { $script:weak = $true; $lines.Add("WEAK  $t -> $fix") }
function Add-Tip($t, $fix) { $lines.Add("TIP   $t -> $fix") }
$main = $Role -ne 'Companion'
$needRam = if ($main) { 8 } else { 4 }
$slack = if ($main) { 7 } else { 3.5 }
if ($ram -ge $slack) { Add-Ok "Memory: $ram GB" } else { Add-Weak "Memory: $ram GB (needs $needRam GB)" "Add RAM (to $needRam GB or more)" }
if ($media -eq 'SSD') { Add-Ok "Disk: SSD ($($letter):)" }
elseif ($media -eq 'HDD') {
  if ($main) { Add-Weak "Disk: a hard disk, not an SSD ($($letter):)" "Replace the disk with an SSD" }
  else { Add-Tip "Disk: a hard disk, not an SSD ($($letter):)" "An SSD makes this PC faster" }
} else { $lines.Add("?     Disk: could not tell SSD or hard disk ($($letter):)") }
if ($main) {
  if ($null -eq $free) { $lines.Add("?     Free disk: could not tell") }
  elseif ($free -ge 20) { Add-Ok "Free disk: $free GB" } else { Add-Weak "Free disk: $free GB (needs 20 GB)" "Free some space: empty the Recycle Bin, delete old downloads" }
  if ($cores -ge 4) { Add-Ok "Processor: $cores cores" } else { Add-Weak "Processor: $cores cores (needs 4)" "Use a PC with 4 cores or more as the Main PC" }
}
$speed = if ($null -ne $mbps) { " $mbps Mbit/s" } else { '' }
$plug = if ($freePorts -gt 0) { 'Plug a network cable into the port at the back' } else { 'Add a network cable (this PC has no free network port: a USB network adapter)' }
if ($kind -eq 'none') { Add-Weak "Network: no link" $plug }
elseif ($null -ne $mbps -and $mbps -lt 20) {
  $what = if ($kind -eq 'wifi') { if ($usb) { 'a slow USB Wi-Fi stick' } else { 'slow Wi-Fi' } } else { 'a slow link' }
  Add-Weak "Network: $what,$speed (needs 20 Mbit/s or more)" $plug
}
elseif ($main -and $kind -eq 'wifi') { Add-Weak "Network: Wi-Fi$speed, not a cable" $plug }
else { Add-Ok ("Network: " + $(if ($kind -eq 'cable') { 'cable' } elseif ($kind -eq 'wifi') { 'Wi-Fi' } else { 'connected' }) + $speed) }

$text = $lines -join "`r`n"
Write-Output $text
if ($Out) { try { Set-Content -Path $Out -Value $text -Encoding ASCII } catch {} }
if ($Log) { try { Add-Content -Path $Log -Value ("[{0}] pc check ({1}):`r`n{2}" -f (Get-Date -Format s), $Role, $text) } catch {} }
if ($weak) { exit 3 } else { exit 0 }
