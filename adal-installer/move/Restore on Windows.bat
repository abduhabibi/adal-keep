@echo off
title Adal Keep - restore
set "HERE=%~dp0"
set "NODE=C:\AdalKeep\runtime\node.exe"
if not exist "%NODE%" (
  echo Install Adal Keep first: run "2 - Install Adal Main.exe" from the USB, then run this again.
  pause
  exit /b 1
)
rem Adal Keep must be closed: its database cannot be replaced while it runs.
taskkill /f /im AdalKeep.exe >nul 2>&1
taskkill /f /im adal-companion.exe >nul 2>&1
taskkill /f /im AdalBrowser.exe >nul 2>&1
taskkill /f /fi "IMAGENAME eq node.exe" >nul 2>&1
timeout /t 3 /nobreak >nul
"%NODE%" "%HERE%restore-adal.mjs"
echo.
echo Open Adal Keep from the Desktop.
pause
