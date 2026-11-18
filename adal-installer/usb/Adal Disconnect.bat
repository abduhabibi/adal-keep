@echo off
REM Adal Disconnect: turns Adal remote support (SSH) off on this PC. Asks once for admin.
title Adal Disconnect
set "USBROOT=%~dp0"
if "%USBROOT:~-1%"=="\" set "USBROOT=%USBROOT:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%USBROOT%\deps\adal-disconnect.ps1\"'"
