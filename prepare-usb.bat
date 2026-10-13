@echo off
setlocal enabledelayedexpansion
title Adal Keep - Prepare USB payload (run ONCE on your Windows test PC)

set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"
set "OUT=%SRC%\USB-PAYLOAD"

echo ================================================================
echo   Preparing USB-PAYLOAD (this takes a few minutes)
echo   Output: %OUT%
echo ================================================================

if exist "%OUT%" rmdir /S /Q "%OUT%"
mkdir "%OUT%"

echo.
echo [1/5] Backend npm install
pushd "%SRC%\adal-keep-backend"
call npm install --no-audit --no-fund
if errorlevel 1 ( echo BACKEND INSTALL FAILED & popd & pause & exit /b 1 )
popd

echo.
echo [2/5] Frontend npm install
pushd "%SRC%\adal-keep-frontend"
call npm install --no-audit --no-fund
if errorlevel 1 ( echo FRONTEND INSTALL FAILED & popd & pause & exit /b 1 )

echo.
echo [3/5] Frontend build
call npm run build
if errorlevel 1 ( echo FRONTEND BUILD FAILED & popd & pause & exit /b 1 )
popd

echo.
echo [4/5] Copying backend WITH node_modules into payload
robocopy "%SRC%\adal-keep-backend" "%OUT%\adal-keep-backend" /E /NFL /NDL /NJH /NJS /NP ^
  /XD data logs uploads .git node_modules\.cache ^
  /XF *.sqlite *.sqlite-shm *.sqlite-wal >nul
if errorlevel 8 ( echo COPY FAILED & pause & exit /b 1 )

echo.
echo [5/5] Copying built frontend + installer + key tool
mkdir "%OUT%\adal-keep-frontend" 2>nul
robocopy "%SRC%\adal-keep-frontend\dist" "%OUT%\adal-keep-frontend\dist" /E /NFL /NDL /NJH /NJS /NP >nul
copy /Y "%SRC%\prepare-usb.install.bat" "%OUT%\install.bat" >nul
copy /Y "%SRC%\prepare-usb.set-key.cjs"  "%OUT%\set-key.cjs" >nul

echo.
echo ================================================================
echo   DONE. USB-PAYLOAD ready at: %OUT%
echo.
echo   Next:
echo     1. Copy the "USB-PAYLOAD" folder onto your USB drive.
echo     2. On the client PC: open USB-PAYLOAD\ and double-click install.bat.
echo     3. Paste the DeepSeek key when prompted (encrypted on their PC).
echo.
echo   You may now DELETE prepare-usb.bat from this folder.
echo ================================================================
pause
