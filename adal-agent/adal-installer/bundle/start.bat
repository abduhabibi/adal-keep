@echo off
title Adal Keep - Starting...
color 0A

echo ============================================
echo    ADAL KEEP - Document Management System
echo ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js not found. Using bundled runtime...
    set NODE_PATH=%~dp0runtime\node.exe
) else (
    set NODE_PATH=node
)

:: Install dependencies if needed
if not exist "%~dp0backend\node_modules" (
    echo [*] Installing dependencies (first run only)...
    cd /d "%~dp0backend"
    call npm install --production
    cd /d "%~dp0"
)

:: Run migrations
echo [*] Checking database...
cd /d "%~dp0backend"
call npx knex migrate:latest 2>nul
cd /d "%~dp0"

:: Start background agent
echo [*] Starting background agent...
start /min "" "%~dp0adal-agent.exe"

:: Start backend
echo [*] Starting server...
start /min "" %NODE_PATH% "%~dp0backend\server.js"

:: Wait for server
timeout /t 3 /nobreak >nul

:: Open browser
echo [*] Opening Adal Keep...
start http://localhost:3000

echo.
echo ============================================
echo   Adal Keep is running!
echo   Browser should open automatically.
echo   Close this window to stop everything.
echo ============================================
echo.
echo Press any key to STOP Adal Keep...
pause >nul

:: Cleanup
taskkill /f /im adal-agent.exe 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4000 ^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
echo [*] Adal Keep stopped.
