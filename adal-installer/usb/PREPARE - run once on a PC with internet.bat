@echo off
REM ============================================================
REM  Adal Keep - prepare this USB once (needs internet).
REM  Downloads Node.js, the server packages for Windows and the
REM  Brave installer into the deps folder of this USB.
REM ============================================================
title Adal Keep - preparing the USB
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deps\prepare-deps.ps1"
echo.
pause
