@echo off
REM Adal Keep - prepare this USB once (needs internet).
REM Downloads Node.js, the server packages for Windows and the Brave
REM installer into this USB's deps folder. Takes about 5 minutes.
title Adal Keep - preparing the USB
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deps\prepare-deps.ps1"
echo.
echo Press any key to close this window.
pause >nul
