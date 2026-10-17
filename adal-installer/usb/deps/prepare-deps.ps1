# =====================================================================
#  Adal Keep - download the Windows dependencies ONCE, onto the USB stick
#
#  Started by "1 - PREPARE (once, needs internet).bat" at the top of the USB,
#  on any Windows 10/11 64-bit PC with internet. Everything lands in the USB's
#  deps\ folder; afterwards every install from this USB works offline.
#
#  Produces (in deps\):
#     node-win-x64.zip        Node.js runtime for Windows
#     backend-modules.zip     the server's node_modules, built FOR WINDOWS
#     brave\BraveSetup.exe    Brave browser installer (used by the automations)
#     prepare.log             full output, for when something fails
#     READY.txt               written last - the installer checks for it
#
#  Fast: downloads with curl.exe into the PC's temp folder (not straight onto
#  the USB), Brave downloads in the background while the packages build, and
#  Node / Brave already on the USB from an earlier run are kept.
# =====================================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = '24.14.1'          # keep in step with the Node used for development
$BraveUrl    = 'https://github.com/brave/brave-browser/releases/latest/download/BraveBrowserStandaloneSilentSetup.exe'
$Deps   = $PSScriptRoot
$Work   = Join-Path $env:TEMP ('adal-deps-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Ready  = Join-Path $Deps 'READY.txt'
$Log    = Join-Path $Deps 'prepare.log'
$Curl   = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
$Start  = Get-Date

function Step($n, $msg) { Write-Host ''; Write-Host " [$n/4] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "       OK  $msg" -ForegroundColor Green }
function Note($msg)     { Write-Host "       $msg" -ForegroundColor DarkGray }
function Fail($msg) {
    Write-Host ''
    Write-Host "   FAILED: $msg" -ForegroundColor Red
    Write-Host "   Details: $Log"
    Write-Host '   The USB was NOT marked ready. Fix the problem and run PREPARE again.'
    exit 1
}
function MB($path) { [math]::Round((Get-Item $path).Length / 1MB) }

# Download $url to $out. curl.exe is many times faster than Invoke-WebRequest.
function Download($url, $out) {
    for ($i = 1; $i -le 3; $i++) {
        try {
            if ($Curl) {
                & $Curl -L --fail -s -S -o $out $url 2>>$Log
                if ($LASTEXITCODE -eq 0) { return $true }
            } else {
                (New-Object Net.WebClient).DownloadFile($url, $out); return $true
            }
        } catch { Add-Content $Log "download attempt $i failed: $($_.Exception.Message)" }
        Start-Sleep -Seconds 3
    }
    return $false
}

# Run a program quietly (output to prepare.log), showing elapsed time.
function RunQuiet($file, [string[]]$arguments, $cwd) {
    $out = Join-Path $Work 'out.txt'; $err = Join-Path $Work 'err.txt'
    $p = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $cwd `
        -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
    $null = $p.Handle   # PowerShell 5.1 needs this to report the exit code
    $t0 = Get-Date
    while (-not $p.HasExited) {
        Write-Host ("`r       working... {0:mm\:ss}" -f ((Get-Date) - $t0)) -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host "`r                          `r" -NoNewline
    Get-Content $out, $err -ErrorAction SilentlyContinue | Add-Content $Log
    return $p.ExitCode
}

Clear-Host
Write-Host ''
Write-Host '  ======================================================' -ForegroundColor White
Write-Host '    ADAL KEEP  -  preparing this USB  (needs internet)' -ForegroundColor White
Write-Host '  ======================================================' -ForegroundColor White
Write-Host '    Takes about 5 minutes. Leave this window open.' -ForegroundColor DarkGray

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'This PC is 32-bit. Use a 64-bit Windows 10/11 PC.' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'tar.exe is missing (Windows 10 version 1803 or newer is needed).' }
if (-not (Test-Path (Join-Path $Deps 'source\package.json'))) { Fail 'deps\source\package.json is missing - copy the whole USB folder again.' }

if (Test-Path $Ready) { Remove-Item $Ready -Force }
Set-Content -Path $Log -Value "Adal Keep PREPARE $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $env:COMPUTERNAME" -Encoding ASCII
New-Item -ItemType Directory -Force -Path $Work | Out-Null

$braveDir = Join-Path $Deps 'brave'
$braveExe = Join-Path $braveDir 'BraveSetup.exe'
$braveTmp = Join-Path $Work 'BraveSetup.exe'
$braveJob = $null

try {
    # Brave (167 MB) downloads in the background while the packages build.
    # Already on the USB from an earlier PREPARE: kept.
    $haveBrave = (Test-Path $braveExe) -and ((Get-Item $braveExe).Length -gt 100MB)
    if (-not $haveBrave -and $Curl) {
        $braveJob = Start-Process -FilePath $Curl -ArgumentList @('-L', '--fail', '-s', '-S', '--retry', '3', '-o', "`"$braveTmp`"", $BraveUrl) `
            -WindowStyle Hidden -PassThru
        $null = $braveJob.Handle
    }

    # ------------------------------------------------------------------
    Step 1 "Node.js $NodeVersion"
    $nodeZip  = Join-Path $Deps 'node-win-x64.zip'
    $nodeMark = Join-Path $Deps 'node-version.txt'
    $haveNode = (Test-Path $nodeZip) -and (Test-Path $nodeMark) -and ((Get-Content $nodeMark -Raw).Trim() -eq $NodeVersion)
    $nodeTmp  = Join-Path $Work 'node.zip'
    if ($haveNode) {
        Copy-Item $nodeZip $nodeTmp
        Note 'already on the USB - kept'
    } else {
        if (-not (Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $nodeTmp)) { Fail 'could not download Node.js (no internet?)' }
    }
    tar.exe -xf $nodeTmp -C $Work
    if ($LASTEXITCODE -ne 0) { Fail 'could not unpack Node.js' }
    $nodeDir = Join-Path $Work "node-v$NodeVersion-win-x64"
    $node    = Join-Path $nodeDir 'node.exe'
    $npmCli  = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path $npmCli)) { Fail 'node.exe / npm not found after unpacking' }
    if (-not $haveNode) {
        Copy-Item $nodeTmp $nodeZip -Force
        Set-Content -Path $nodeMark -Value $NodeVersion -Encoding ASCII
    }
    Ok ("node " + (& $node --version))

    # ------------------------------------------------------------------
    Step 2 'Server packages, built for Windows (the slow part)'
    $build = Join-Path $Work 'backend'
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    Copy-Item (Join-Path $Deps 'source\package.json') $build
    if (Test-Path (Join-Path $Deps 'source\package-lock.json')) { Copy-Item (Join-Path $Deps 'source\package-lock.json') $build }
    $env:Path = "$nodeDir;$env:Path"
    $env:PUPPETEER_SKIP_DOWNLOAD = '1'      # the automations use the installed Brave
    $code = RunQuiet $node @("`"$npmCli`"", 'ci', '--omit=dev', '--no-audit', '--no-fund') $build
    if ($code -ne 0) {
        Note 'npm ci failed - trying npm install'
        $code = RunQuiet $node @("`"$npmCli`"", 'install', '--omit=dev', '--no-audit', '--no-fund') $build
        if ($code -ne 0) { Fail 'npm could not install the server packages' }
    }
    # The native parts must load on Windows, or the server cannot start.
    $code = RunQuiet $node @('--input-type=module', '-e', '"await import(''sqlite3''); await import(''sharp'')"') $build
    if ($code -ne 0) { Fail 'sqlite3 or sharp does not load on Windows' }

    $modTmp = Join-Path $Work 'backend-modules.zip'
    Push-Location $build
    try { tar.exe -a -cf $modTmp node_modules } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail 'could not pack the server packages' }
    Note 'copying to the USB...'
    Copy-Item $modTmp (Join-Path $Deps 'backend-modules.zip') -Force
    Ok ("server packages  ($(MB $modTmp) MB)")

    # ------------------------------------------------------------------
    Step 3 'Brave browser (offline installer)'
    New-Item -ItemType Directory -Force -Path $braveDir | Out-Null
    $gotBrave = $haveBrave
    if ($haveBrave) {
        Note 'already on the USB - kept'
    } else {
        if ($braveJob) {
            while (-not $braveJob.HasExited) {
                $sz = if (Test-Path $braveTmp) { [math]::Round((Get-Item $braveTmp).Length / 1MB) } else { 0 }
                Write-Host "`r       downloading... $sz of ~160 MB   " -NoNewline
                Start-Sleep -Seconds 1
            }
            Write-Host "`r                                          `r" -NoNewline
            $gotBrave = ($braveJob.ExitCode -eq 0) -and (Test-Path $braveTmp)
        }
        if (-not $gotBrave) { $gotBrave = Download $BraveUrl $braveTmp }
        if ($gotBrave) {
            Note 'copying to the USB...'
            Copy-Item $braveTmp $braveExe -Force
        }
    }
    if ($gotBrave) { Ok ("BraveSetup.exe  ($(MB $braveExe) MB)") }
    else { Write-Host '       WARN  Brave could not be downloaded. Installs still work; install Brave by hand.' -ForegroundColor Yellow }

    # ------------------------------------------------------------------
    Step 4 'Marking the USB ready'
    Set-Content -Path $Ready -Encoding ASCII -Value @(
        'Adal Keep USB dependencies - ready',
        "prepared:  $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $env:COMPUTERNAME",
        "node:      $NodeVersion",
        "brave:     $(if ($gotBrave) { 'included' } else { 'missing' })"
    )
    Ok 'ready'
}
finally {
    if ($braveJob -and -not $braveJob.HasExited) { try { $braveJob.Kill() } catch {} }
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}

$took = (Get-Date) - $Start
Write-Host ''
Write-Host '  ======================================================' -ForegroundColor Green
Write-Host ("    DONE in {0:mm\:ss}. Safely eject the USB." -f $took) -ForegroundColor Green
Write-Host '    Then, on each PC (no internet needed):' -ForegroundColor Green
Write-Host '      2 - Install Adal Main.exe       the main (server) PC' -ForegroundColor Green
Write-Host '      3 - Install Adal Companion.exe  every employee PC' -ForegroundColor Green
Write-Host '  ======================================================' -ForegroundColor Green
exit 0
