@echo off
setlocal enabledelayedexpansion
title Adal Keep - Quick Setup
echo ================================================
echo   Adal Keep Setup - detecting system paths
echo ================================================

rem --- Detect a writable install root (avoids Program Files SQLite crash) ---
set "DEFAULT_ROOT=%LOCALAPPDATA%\AdalKeep"
echo Default install location: %LOCALAPPDATA%\AdalKeep (Avoids Program Files DB lock)
echo.
set "ROOT="
set /p "ROOT=Install to [%DEFAULT_ROOT%] ? (Enter = accept): "
if "!ROOT!"=="" set "ROOT=%DEFAULT_ROOT%"
set ROOT=!ROOT:"=!
if "!ROOT:~-1!"=="\" set "ROOT=!ROOT:~0,-1!"
mkdir "!ROOT!" 2>nul
echo. > "!ROOT!\.wtest" 2>nul
if not exist "!ROOT!\.wtest" (
  echo [WARN] Not writable. Falling back to %USERPROFILE%\AdalKeep
  set "ROOT=%USERPROFILE%\AdalKeep"
  mkdir "!ROOT!" 2>nul
) else ( del "!ROOT!\.wtest" >nul 2>nul )
echo [OK] Installing to: !ROOT!
echo.

echo [1/3] Copying files...
xcopy /E /I /Y /Q "%~dp0adal-master" "!ROOT!\adal-master" >nul
xcopy /E /I /Y /Q "%~dp0node" "!ROOT!\node" >nul

echo [2/3] Writing configuration (Watcher disabled for demo)...
> "!ROOT!\adal-master\adal-keep-backend\.env" (
  echo PORT=3000
  echo NODE_ENV=production
  echo WATCH_DIR=
  echo DEV_MASTER_PASSWORD=759126348
  echo CODE_SECRET=adal-keep-code-signing-secret-v1
  echo TENANT_SECRET=adal-keep-local-secret
)

echo [3/3] Creating Desktop Shortcut...
> "!ROOT!\start-adal-keep.bat" (
  echo @echo off
  echo cd /d "!ROOT!\adal-master\adal-keep-backend"
  echo start "" /b cmd /c "timeout /t 3 /nobreak ^>nul ^& start http://localhost:3000"
  echo "!ROOT!\node\node.exe" server.js
  echo pause
)

powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Adal Keep.lnk'); $s.TargetPath='!ROOT!\start-adal-keep.bat'; $s.WorkingDirectory='!ROOT!'; $s.Save()"

echo.
echo ================================================
echo   SETUP COMPLETE!
echo   Master PC:      http://localhost:3000
echo   Other PCs:      http://YOUR-IP:3000
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%a"
  echo                   http://!IP: :3000
)
echo ================================================
pause
