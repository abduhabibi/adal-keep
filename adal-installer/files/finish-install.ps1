# =====================================================================
#  Adal Keep - second half of "Install Adal Main.exe"
#  Unpacks the Windows dependencies that PREPARE put on the USB:
#     deps\node-win-x64.zip     -> <install>\runtime
#     deps\backend-modules.zip  -> <install>\backend\node_modules
#     deps\brave\BraveSetup.exe -> installs Brave (waited for) when the installer has not
#  and checks that the server's native modules load.
#  Exit code 0 = ready. A log is kept in <install>\install.log.
# =====================================================================
param(
    [Parameter(Mandatory = $true)][string]$InstDir,
    [Parameter(Mandatory = $true)][string]$Deps
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $InstDir 'install.log'
Start-Transcript -Path $log -Append | Out-Null

function Get-Brave {
    foreach ($p in @(
        (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe')
    )) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

$code = 0
try {
    Write-Host "Adal Keep install - $(Get-Date -Format 'yyyy-MM-dd HH:mm')  from $Deps"

    # --- Node.js runtime
    $tmp = Join-Path $InstDir '_unpack'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $tmp | Out-Null
    tar.exe -xf (Join-Path $Deps 'node-win-x64.zip') -C $tmp
    if ($LASTEXITCODE -ne 0) { throw 'could not unpack node-win-x64.zip' }
    $nodeDir = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $nodeDir) { throw 'node-win-x64.zip is empty' }
    $runtime = Join-Path $InstDir 'runtime'
    if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
    Move-Item $nodeDir.FullName $runtime
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'OK  Node.js runtime'

    # --- server packages (built for Windows by PREPARE)
    $backend = Join-Path $InstDir 'backend'
    $modules = Join-Path $backend 'node_modules'
    if (Test-Path $modules) { Remove-Item $modules -Recurse -Force }
    tar.exe -xf (Join-Path $Deps 'backend-modules.zip') -C $backend
    if ($LASTEXITCODE -ne 0) { throw 'could not unpack backend-modules.zip' }
    Write-Host 'OK  server packages'

    # --- the server cannot start without these, so check now, not at first use
    Push-Location $backend
    try {
        & (Join-Path $runtime 'node.exe') --input-type=module -e "await import('sqlite3'); await import('sharp'); console.log('native modules load')"
        if ($LASTEXITCODE -ne 0) { throw 'sqlite3/sharp do not load - run PREPARE again on a 64-bit Windows PC' }
    } finally { Pop-Location }
    Write-Host 'OK  native modules load'

    # --- Brave (the automations drive it). The installer installs it first;
    #     this is the fallback, and it waits too.
    if (Get-Brave) {
        Write-Host 'OK  Brave already installed'
    } else {
        $setup = Join-Path $Deps 'brave\BraveSetup.exe'
        if (Test-Path $setup) {
            # Copied off the USB first, so the USB can be removed meanwhile.
            $local = Join-Path $env:TEMP 'AdalKeep-BraveSetup.exe'
            Copy-Item $setup $local -Force
            # Waited for: Adal Keep must open in Brave from its first start.
            Start-Process -FilePath $local -ArgumentList '/silent', '/install' -WindowStyle Hidden -Wait
            for ($i = 0; $i -lt 180 -and -not (Get-Brave); $i++) { Start-Sleep -Seconds 2 }
            if (Get-Brave) { Write-Host 'OK  Brave installed' } else { Write-Host 'WARN Brave did not install - Adal Keep uses Chrome or Edge' }
        } else {
            Write-Host 'WARN no Brave installer on the USB - install Brave by hand'
        }
    }
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    $code = 1
} finally {
    Stop-Transcript | Out-Null
}
exit $code
