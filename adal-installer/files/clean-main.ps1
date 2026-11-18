# =====================================================================
#  Adal Keep - clean start for "Install Adal Main.exe" (run before the new
#  files are copied in, after Adal Keep was stopped).
#
#  KEPT, always:  backend\data.sqlite (the agency's database: profiles,
#                 company info, users, runs ...), backend\data\SafeStorage and
#                 backend\uploads (every document), the keys (account-vault.key,
#                 secrets.enc), the WhatsApp and portal sign-ins, the Trash,
#                 unclassified documents, settings files in backend\data.
#  REMOVED:       the old program (backend\src, frontend) so no old file is
#                 left behind; browser caches (they grow to hundreds of MB and
#                 slow a 4 GB PC); temporary and half-finished files; old logs.
#  A copy of the database is made first (backend\data\before-install.sqlite,
#  only the newest one is kept).
#  Everything it does is written to <install>\install.log.
# =====================================================================
param([Parameter(Mandatory = $true)][string]$InstDir)
$ErrorActionPreference = 'Continue'
$log = Join-Path $InstDir 'install.log'
Start-Transcript -Path $log -Append | Out-Null

function SizeOf($p) {
    try { (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } catch { 0 }
}
$freed = 0
function Drop($p) {
    if (-not (Test-Path -LiteralPath $p)) { return }
    $n = SizeOf $p
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $p)) { $script:freed += $n; Write-Host ("  removed {0} ({1:N0} MB)" -f $p, ($n / 1MB)) }
    else { Write-Host "  could not remove $p (in use?) - left as it is" }
}

try {
    Write-Host "Adal Keep clean start - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    $backend = Join-Path $InstDir 'backend'
    $data = Join-Path $backend 'data'
    if (-not (Test-Path $backend)) { Write-Host 'New install: nothing to clean.'; exit 0 }

    # --- 1. a copy of the database first
    $db = Join-Path $backend 'data.sqlite'
    if (Test-Path $db) {
        New-Item -ItemType Directory -Path $data -Force | Out-Null
        $copy = Join-Path $data 'before-install.sqlite'
        Copy-Item -LiteralPath $db -Destination $copy -Force
        if (Test-Path "$db-wal") { Copy-Item -LiteralPath "$db-wal" -Destination "$copy-wal" -Force } else { Remove-Item "$copy-wal" -Force -ErrorAction SilentlyContinue }
        Write-Host ("OK  database copied ({0:N0} MB) -> {1}" -f ((Get-Item $db).Length / 1MB), $copy)
    }

    # --- 2. the old program (the new one is copied in right after)
    Write-Host 'Old program files:'
    Drop (Join-Path $backend 'src')
    Drop (Join-Path $InstDir 'frontend')
    Drop (Join-Path $InstDir '_unpack')

    # --- 3. browser caches (the robots' Adal Browser and the WhatsApp browsers).
    # Only caches: cookies, sign-ins and saved site data stay.
    Write-Host 'Browser caches:'
    $caches = 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'component_crx_cache', 'Crashpad', 'BrowserMetrics', 'optimization_guide_model_store', 'OnDeviceHeadSuggestModel', 'Safe Browsing', 'extensions_crx_cache'
    foreach ($root in @((Join-Path $data 'browser-profile'), (Join-Path $data 'whatsapp'), (Join-Path $InstDir 'browser-profile'), (Join-Path $env:LOCALAPPDATA 'AdalKeep'))) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $caches -contains $_.Name } |
            Sort-Object { $_.FullName.Length } -Descending |
            ForEach-Object { Drop $_.FullName }
        # (the robots' browser only: pages' offline copies are fetched again; WhatsApp keeps its own)
        if ($root -notlike '*whatsapp*') {
            Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -in 'CacheStorage', 'ScriptCache' -and $_.Parent.Name -eq 'Service Worker' } |
                ForEach-Object { Drop $_.FullName }
        }
    }

    # --- 4. temporary and left-over files
    Write-Host 'Temporary files:'
    foreach ($p in 'tmp-templates', 'backup-tmp', 'tmp') { Drop (Join-Path $data $p) }
    Get-ChildItem -LiteralPath $data -File -Force -ErrorAction SilentlyContinue |
        Where-Object { ($_.Name -like '*.OLD-*') -or ($_.Name -like '*.sqlite' -and $_.Length -eq 0 -and $_.Name -ne 'data.sqlite') } |
        ForEach-Object { Drop $_.FullName }
    # older restore copies: only the newest is kept
    Get-ChildItem -LiteralPath $backend -File -Force -Filter 'data.sqlite.before-restore-*' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | ForEach-Object { Drop $_.FullName }
    foreach ($t in @($env:TEMP, (Join-Path $env:WINDIR 'Temp'))) {
        if (-not $t -or -not (Test-Path $t)) { continue }
        Get-ChildItem -LiteralPath $t -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(lmis-|adal-|cv-|mofa-|insurance-|passport-|puppeteer_dev_)' } |
            ForEach-Object { Drop $_.FullName }
    }

    # --- 5. logs older than 2 weeks
    Write-Host 'Old logs:'
    $logs = Join-Path $backend 'logs'
    if (Test-Path $logs) {
        Get-ChildItem -LiteralPath $logs -File -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | ForEach-Object { Drop $_.FullName }
    }

    Write-Host ("DONE clean start: {0:N0} MB freed. Database, company info and documents kept." -f ($freed / 1MB))
} catch {
    # A clean-up problem never stops the install: the new program still goes in.
    Write-Host "WARN clean start: $($_.Exception.Message)"
} finally {
    Stop-Transcript | Out-Null
}
exit 0
