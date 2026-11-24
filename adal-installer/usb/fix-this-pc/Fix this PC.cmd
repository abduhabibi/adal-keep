@echo off
rem Fix this PC: stops every robot, frees the PC and installs Adal Keep's newest release from this USB.
rem Double-click it. Windows asks once for permission; nothing else is asked.
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-this-pc.ps1"
echo.
pause
