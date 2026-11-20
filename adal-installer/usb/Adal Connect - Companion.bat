@echo off
REM Adal Connect - Companion: lets Adal support reach this PC (SSH)
REM opens the Adal Keep ports on every network type, lets the office PCs share
REM updates, data and the server, and installs the newest Adal Keep. Asks once for admin.
title Adal Connect
set "USBROOT=%~dp0"
if "%USBROOT:~-1%"=="\" set "USBROOT=%USBROOT:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%USBROOT%\deps\adal-connect.ps1\" -Role Companion -UsbRoot \"%USBROOT%\" -User %USERNAME%'"
echo A blue window opens (click Yes when Windows asks). Wait for the final message.
timeout /t 8 >nul
