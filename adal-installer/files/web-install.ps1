# Adal Keep - install over the internet, without the USB.
# Fetched by:  irm '<link>' | iex   (the link comes from publish-install.mjs).
# Downloads the two installers, does what PREPARE does on a USB, runs the
# installer, then removes the downloaded files: the installers hold the
# licence key, so they must not stay on the PC.
function Install-AdalKeep {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Url = '__BUNDLE_URL__'
    $Sha = '__BUNDLE_SHA__'
    $Dir = Join-Path $env:LOCALAPPDATA 'AdalKeepSetup'

    Write-Host ''
    Write-Host '  ADAL KEEP - install from the internet' -ForegroundColor Cyan
    Write-Host '    1 = Main PC (holds the data)'
    Write-Host '    2 = Companion PC (an employee PC)'
    $role = (Read-Host '  Type 1 or 2, then press Enter').Trim()
    if ($role -ne '1' -and $role -ne '2') { Write-Host '  Nothing was installed: type 1 or 2.' -ForegroundColor Red; return }

    try {
        if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        $zip = Join-Path $Dir 'adal-keep.zip'

        Write-Host '  Downloading Adal Keep...' -ForegroundColor Cyan
        $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
        if ($curl) {
            & $curl -L --fail -s -S --retry 3 -o $zip $Url
            if ($LASTEXITCODE -ne 0) { throw 'The download failed. The link may have expired: ask for a new one.' }
        } else {
            (New-Object Net.WebClient).DownloadFile($Url, $zip)
        }
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $Sha) { throw 'The download is damaged. Run the line again.' }
        Expand-Archive -Path $zip -DestinationPath $Dir -Force
        Remove-Item $zip -Force

        Write-Host '  Preparing Node.js, the server packages and Brave (about 5 minutes)...' -ForegroundColor Cyan
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'deps\prepare-deps.ps1')
        if (-not (Test-Path (Join-Path $Dir 'deps\READY.txt'))) { throw 'Preparing did not finish. See prepare.log on the Desktop.' }

        $exe = if ($role -eq '1') { '2 - Install Adal Main.exe' } else { '3 - Install Adal Companion.exe' }
        Write-Host '  Installing: press Yes when Windows asks.' -ForegroundColor Cyan
        Start-Process -FilePath (Join-Path $Dir $exe) -Verb RunAs -Wait
        Write-Host '  Done. Open Adal Keep from the Desktop.' -ForegroundColor Green
    } catch {
        Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $log = Join-Path $Dir 'deps\prepare.log'
        if (Test-Path $log) { Copy-Item $log ([Environment]::GetFolderPath('Desktop')) -Force }
    } finally {
        Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Install-AdalKeep
