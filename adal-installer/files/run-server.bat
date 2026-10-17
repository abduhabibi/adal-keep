@echo off
REM ============================================================
REM  Adal Keep - server starter (used by the Run-at-login entry)
REM  Relaunches itself minimized, then keeps the node server alive.
REM ============================================================
if not "%~1"=="min" (
  start "Adal Keep Server" /min cmd /c ""%~f0" min"
  exit /b
)
title Adal Keep Server
cd /d "%~dp0backend"
if not exist "%~dp0backend\data" mkdir "%~dp0backend\data"

:loop
REM Do not start a second server if something already listens on 4000
netstat -ano | findstr /r /c:":4000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [%date% %time%] port 4000 already in use - waiting >> "%~dp0backend\data\server.log"
  timeout /t 30 /nobreak >nul
  goto loop
)

echo [%date% %time%] starting Adal Keep backend >> "%~dp0backend\data\server.log"
"%~dp0runtime\node.exe" server.js >> "%~dp0backend\data\server.log" 2>&1
echo [%date% %time%] backend exited (%errorlevel%) - restarting in 5s >> "%~dp0backend\data\server.log"
timeout /t 5 /nobreak >nul
goto loop
