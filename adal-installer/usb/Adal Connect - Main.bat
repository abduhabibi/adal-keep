@echo off
REM Adal Connect - Main: lets Adal support reach this PC (SSH)
REM and opens the Adal Keep ports on every network type. Asks once for admin.
title Adal Connect
set "USBROOT=%~dp0"
if "%USBROOT:~-1%"=="\" set "USBROOT=%USBROOT:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%USBROOT%\deps\adal-connect.ps1\" -Role Main -UsbRoot \"%USBROOT%\" -User %USERNAME%'"
echo A blue window opens (click Yes when Windows asks). Wait for the final message.
timeout /t 8 >nul
