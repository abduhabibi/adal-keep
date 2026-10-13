@echo off
title Adal Keep AI Server
color 0A

REM Force the script to run from the USB folder
cd /d "%~dp0"

echo ============================================
echo    ADAL KEEP - Starting System...
echo ============================================
echo.

REM Check if Node.js exists
if not exist "runtime\node.exe" (
    echo [ERROR] node.exe is missing!
    pause
    exit /b 1
)

REM Check if backend exists
if not exist "backend\server.js" (
    echo [ERROR] server.js is missing!
    pause
    exit /b 1
)

REM Install dependencies if missing
if not exist "backend\node_modules\express\package.json" (
    echo [1/3] First run: Installing dependencies...
    echo       (This requires internet and takes 2-5 mins)
    echo.
    runtime\node.exe runtime\npm\bin\npm-cli.js install --production --prefix backend
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Installation failed. Check internet.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed.
) else (
    echo [1/3] Dependencies verified.
)

REM Start Server
echo [2/3] Starting server...
start "" /B runtime\node.exe backend\server.js

echo [3/3] Waiting 10 seconds...
timeout /t 10 /nobreak >nul

REM Open Browser
echo Opening browser...
start http://localhost:4000

echo.
echo ============================================
echo    SUCCESS! Server is running.
echo    Keep this window open.
echo ============================================
pause
