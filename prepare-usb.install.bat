@echo off
setlocal enabledelayedexpansion
title Adal Keep - Offline Install

echo ================================================================
echo   ADAL KEEP - one-click offline install
echo ================================================================

set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"

set "DEFAULT_ROOT=%LOCALAPPDATA%\AdalKeep"
echo Default location: %DEFAULT_ROOT%
set "ROOT="
set /p "ROOT=Install location [Enter for default]: "
if "!ROOT!"=="" set "ROOT=%DEFAULT_ROOT%"
set ROOT=!ROOT:"=!
if "!ROOT:~-1!"=="\" set "ROOT=!ROOT:~0,-1!"
mkdir "!ROOT!" 2>nul
echo. > "!ROOT!\.wtest" 2>nul
if not exist "!ROOT!\.wtest" (
  echo [WARN] not writable, falling back to %USERPROFILE%\AdalKeep
  set "ROOT=%USERPROFILE%\AdalKeep"
  mkdir "!ROOT!" 2>nul
) else ( del "!ROOT!\.wtest" >nul 2>nul )
echo [OK] %ROOT%
echo.

echo [1/6] Copying application files...
robocopy "%SRC%\adal-keep-backend"  "!ROOT!\adal-keep-backend"  /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%SRC%\adal-keep-frontend" "!ROOT!\adal-keep-frontend" /E /NFL /NDL /NJH /NJS /NP >nul
if exist "%SRC%\node" robocopy "%SRC%\node" "!ROOT!\node" /E /NFL /NDL /NJH /NJS /NP >nul

echo [2/6] Preparing inbox folder...
mkdir "!ROOT!\inbox" 2>nul

echo [3/6] Writing .env (no secrets here)...
> "!ROOT!\adal-keep-backend\.env" (
  echo PORT=3000
  echo HOST=0.0.0.0
  echo NODE_ENV=production
  echo WATCH_DIR=!ROOT!\inbox
  echo DEV_MASTER_PASSWORD=759126348
  echo CODE_SECRET=adal-keep-code-signing-secret-v1
  echo TENANT_SECRET=adal-keep-local-secret
)

echo [4/6] DeepSeek API key (stored encrypted on this PC, machine-bound).
echo       Press Enter to skip (you can set it later with set-key.cjs).
set "KEY="
set /p "KEY=DeepSeek key: "
if not "!KEY!"=="" (
  set "NODE_EXE=node"
  if exist "!ROOT!\node\node.exe" set "NODE_EXE=!ROOT!\node\node.exe"
  pushd "!ROOT!\adal-keep-backend"
  "!NODE_EXE!" "!ROOT!\set-key.cjs" "!KEY!"
  popd
)

echo [5/6] Creating launcher...
> "!ROOT!\start-adal-keep.bat" (
  echo @echo off
  echo cd /d "!ROOT!\adal-keep-backend"
  echo start "" /b cmd /c "timeout /t 3 /nobreak ^>nul ^& start http://localhost:3000"
  echo "!ROOT!\node\node.exe" server.js
  echo pause
)

echo [6/6] Creating desktop shortcut...
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Adal Keep.lnk'); $s.TargetPath='!ROOT!\start-adal-keep.bat'; $s.WorkingDirectory='!ROOT!'; $s.Save()" >nul

echo.
echo ================================================================
echo   INSTALL COMPLETE
echo   Master PC:  http://localhost:3000
echo   LAN:        http://THIS-PC-IP:3000
echo   Inbox:      !ROOT!\inbox  (drop scans here)
echo ================================================================
pause
