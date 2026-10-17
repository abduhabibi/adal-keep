# =====================================================================
#  Adal Keep - download the Windows dependencies ONCE, onto the USB stick
#
#  Run on any Windows 10/11 64-bit PC that has internet, by double-clicking
#  "PREPARE - run once on a PC with internet.bat" at the top of the USB.
#  Everything is written into the USB's deps\ folder. Afterwards every
#  install from this USB works without internet.
#
#  Produces (in deps\):
#     node-win-x64.zip        Node.js runtime for Windows
#     backend-modules.zip     the server's node_modules, built FOR WINDOWS
#     brave\BraveSetup.exe    Brave browser installer (used by the automations)
#     READY.txt               written last - the installer checks for it
# =====================================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = '24.14.1'          # keep in step with the Node used for development
$Deps   = $PSScriptRoot
$Work   = Join-Path $env:TEMP ('adal-deps-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Ready  = Join-Path $Deps 'READY.txt'

function Step($msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Fail($msg) {
    Write-Host ''
    Write-Host "   FAILED: $msg" -ForegroundColor Red
    Write-Host '   Nothing on the USB was marked ready. Fix the problem and run PREPARE again.'
    exit 1
}
function Download($url, $out) {
    for ($i = 1; $i -le 3; $i++) {
        try { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing; return $true }
        catch { Write-Host "   attempt $i failed: $($_.Exception.Message)"; Start-Sleep -Seconds 3 }
    }
    return $false
}

Write-Host '============================================================'
Write-Host '  ADAL KEEP - preparing the USB (needs internet, ~5-15 min)'
Write-Host '============================================================'
Write-Host "  USB deps folder: $Deps"

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'This PC is 32-bit. Use a 64-bit Windows 10/11 PC.' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'tar.exe is missing (Windows 10 version 1803 or newer is needed).' }
if (-not (Test-Path (Join-Path $Deps 'source\package.json'))) { Fail 'deps\source\package.json is missing - copy the whole USB folder again.' }

if (Test-Path $Ready) { Remove-Item $Ready -Force }
New-Item -ItemType Directory -Force -Path $Work | Out-Null

try {
    # ------------------------------------------------------------------
    Step "1/4  Node.js $NodeVersion for Windows"
    $nodeZip = Join-Path $Deps 'node-win-x64.zip'
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    if (-not (Download $nodeUrl $nodeZip)) { Fail "could not download $nodeUrl" }
    tar.exe -xf $nodeZip -C $Work
    if ($LASTEXITCODE -ne 0) { Fail 'could not unpack the Node.js zip' }
    $nodeDir = Join-Path $Work "node-v$NodeVersion-win-x64"
    $node = Join-Path $nodeDir 'node.exe'
    $npm  = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $node)) { Fail 'node.exe not found after unpacking' }
    Ok ("node " + (& $node --version))

    # ------------------------------------------------------------------
    Step '2/4  Server packages (built for Windows - this takes a few minutes)'
    $build = Join-Path $Work 'backend'
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    Copy-Item (Join-Path $Deps 'source\package.json') $build
    if (Test-Path (Join-Path $Deps 'source\package-lock.json')) { Copy-Item (Join-Path $Deps 'source\package-lock.json') $build }
    $env:Path = "$nodeDir;$env:Path"
    $env:PUPPETEER_SKIP_DOWNLOAD = '1'      # the automations use the installed Brave
    Push-Location $build
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Host '   npm ci failed - trying npm install instead'
            & $npm install --omit=dev --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { Fail 'npm could not install the server packages (see the messages above)' }
        }
        # The native parts must load on Windows, or the server cannot start.
        & $node --input-type=module -e "await import('sqlite3'); await import('sharp'); console.log('native modules load')"
        if ($LASTEXITCODE -ne 0) { Fail 'sqlite3 or sharp does not load on Windows (see the messages above)' }
    } finally { Pop-Location }
    Ok 'server packages installed and checked'

    $modZip = Join-Path $Deps 'backend-modules.zip'
    if (Test-Path $modZip) { Remove-Item $modZip -Force }
    Push-Location $build
    try { tar.exe -a -cf $modZip node_modules } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail 'could not pack node_modules' }
    Ok ("backend-modules.zip  " + [math]::Round((Get-Item $modZip).Length / 1MB) + ' MB')

    # ------------------------------------------------------------------
    Step '3/4  Brave browser installer (offline)'
    $braveDir = Join-Path $Deps 'brave'
    New-Item -ItemType Directory -Force -Path $braveDir | Out-Null
    $braveExe = Join-Path $braveDir 'BraveSetup.exe'
    $got = Download 'https://github.com/brave/brave-browser/releases/latest/download/BraveBrowserStandaloneSetup.exe' $braveExe
    if (-not $got) {
        Write-Host '   standalone installer unavailable - saving the small online installer instead'
        $got = Download 'https://laptop-updates.brave.com/latest/winx64' $braveExe
    }
    if ($got) { Ok ("BraveSetup.exe  " + [math]::Round((Get-Item $braveExe).Length / 1MB) + ' MB') }
    else { Write-Host '   WARN: Brave could not be downloaded. Installs still work; Brave must then be installed by hand.' -ForegroundColor Yellow }

    # ------------------------------------------------------------------
    Step '4/4  Marking the USB ready'
    $lines = @(
        'Adal Keep USB dependencies - ready',
        "prepared:  $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
        "on PC:     $env:COMPUTERNAME",
        "node:      $NodeVersion",
        "brave:     $(if ($got) { 'included' } else { 'missing' })"
    )
    Set-Content -Path $Ready -Value $lines -Encoding ASCII
    Ok 'READY.txt written'
}
finally {
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '  DONE. Safely eject the USB. Every PC can now be installed' -ForegroundColor Green
Write-Host '  from it without internet:' -ForegroundColor Green
Write-Host '     Install Adal Main.exe       - the main (server) PC' -ForegroundColor Green
Write-Host '     Install Adal Companion.exe  - every employee PC' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
exit 0
