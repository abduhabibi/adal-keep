@echo off
REM ============================================================
REM  Adal Keep Companion - employee PC starter
REM  Relaunches itself minimized, then watches Desktop + Downloads.
REM  The server is found automatically on the LAN (UDP 45454).
REM  To pin a server manually, put its address in companion.conf
REM  next to this file, e.g.  ADAL_HOST_URL=http://192.168.1.20:4000
REM ============================================================
if not "%~1"=="min" (
  start "Adal Keep Companion" /min cmd /c ""%~f0" min"
  exit /b
)
title Adal Keep Companion
cd /d "%~dp0"
tasklist /fi "imagename eq adal-companion.exe" 2>nul | find /i "adal-companion.exe" >nul
if not errorlevel 1 (
  echo Adal Keep Companion is already running - closing this window.
  timeout /t 3 /nobreak >nul
  exit /b
)

:loop
"%~dp0adal-companion.exe"
echo [%date% %time%] companion exited (%errorlevel%) - restarting in 5s
timeout /t 5 /nobreak >nul
goto loop
