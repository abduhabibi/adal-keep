# Adal Keep - install over the internet, without the USB.
# Fetched by:  irm '<link>' | iex   (the link comes from publish-install.mjs).
# Downloads the installers, Node.js and the server packages ready-made for
# Windows (nothing is built on this PC) and Tailscale, runs the installer (Adal
# Browser fetches itself at Adal Keep's first start), then removes the downloaded files: the installers
# hold the licence key, so they must not stay on the PC.
function Install-AdalKeep {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Url = '__BUNDLE_URL__'
    $Sha = '__BUNDLE_SHA__'
    $NodeUrl = '__NODE_URL__'
    $NodeSha = '__NODE_SHA__'
    $ModuleParts = @(__MODULE_URLS__)
    $ModulesSha = '__MODULES_SHA__'
    $TailscaleUrl = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
    $Dir = Join-Path $env:LOCALAPPDATA 'AdalKeepSetup'

    Write-Host ''
    Write-Host '  ADAL KEEP - install from the internet' -ForegroundColor Cyan
    Write-Host '    1 = Main PC (holds the data)'
    Write-Host '    2 = Companion PC (an employee PC)'
    $role = (Read-Host '  Type 1 or 2, then press Enter').Trim()
    if ($role -ne '1' -and $role -ne '2') { Write-Host '  Nothing was installed: type 1 or 2.' -ForegroundColor Red; return }

    $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    if (-not $curl) { Write-Host '  curl.exe is missing: Windows 10 version 1803 or newer is needed.' -ForegroundColor Red; return }
    function Get-File($from, $to) {
        & $curl -L --fail --progress-bar --retry 5 --retry-delay 3 -C - -o $to $from
        return ($LASTEXITCODE -eq 0)
    }
    function Test-Sha($file, $want) {
        if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $want) { throw "$(Split-Path $file -Leaf) is damaged. Run the line again." }
    }

    try {
        if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
        $deps = Join-Path $Dir 'deps'
        New-Item -ItemType Directory -Force -Path (Join-Path $deps 'tailscale') | Out-Null

        Write-Host '  [1/4] Adal Keep' -ForegroundColor Cyan
        $zip = Join-Path $Dir 'adal-keep.zip'
        if (-not (Get-File $Url $zip)) { throw 'The download failed. The link may have expired: ask for a new one.' }
        Test-Sha $zip $Sha
        Expand-Archive -Path $zip -DestinationPath $Dir -Force
        Remove-Item $zip -Force

        Write-Host '  [2/4] Node.js' -ForegroundColor Cyan
        $node = Join-Path $deps 'node-win-x64.zip'
        if (-not (Get-File $NodeUrl $node)) { throw 'Node.js did not download. Run the line again.' }
        Test-Sha $node $NodeSha

        Write-Host '  [3/4] Server packages' -ForegroundColor Cyan
        $modules = Join-Path $deps 'backend-modules.zip'
        $out = [IO.File]::Create($modules)
        try {
            foreach ($u in $ModuleParts) {
                $part = Join-Path $Dir 'part.bin'
                Remove-Item $part -Force -ErrorAction SilentlyContinue
                if (-not (Get-File $u $part)) { throw 'The server packages did not download. Run the line again.' }
                $in = [IO.File]::OpenRead($part)
                try { $in.CopyTo($out) } finally { $in.Close() }
                Remove-Item $part -Force
            }
        } finally { $out.Close() }
        Test-Sha $modules $ModulesSha

        Write-Host '  [4/4] Tailscale' -ForegroundColor Cyan
        if (-not (Get-File $TailscaleUrl (Join-Path $deps 'tailscale\tailscale-setup.msi'))) {
            Remove-Item (Join-Path $deps 'tailscale\tailscale-setup.msi') -Force -ErrorAction SilentlyContinue
        }
        Set-Content -Path (Join-Path $deps 'READY.txt') -Value 'Ready: downloaded by the internet install' -Encoding ASCII

        $exe = if ($role -eq '1') { '2 - Install Adal Main.exe' } else { '3 - Install Adal Companion.exe' }
        Write-Host '  Installing: press Yes when Windows asks.' -ForegroundColor Cyan
        Start-Process -FilePath (Join-Path $Dir $exe) -Verb RunAs -Wait
        Write-Host '  Done. Open Adal Keep from the Desktop.' -ForegroundColor Green
    } catch {
        Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Install-AdalKeep
