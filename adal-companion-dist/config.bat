@echo off
cd /d "%~dp0"
REM ============================================
REM   ADAL COMPANION CONFIGURATION
REM   Edit these values before running
REM ============================================

REM IP address of the machine running Adal Keep AI Server
set "ADAL_HOST_URL=http://192.168.1.100:4000"

REM Name for this client (shows up in the AI server)
set "ADAL_CLIENT_NAME=%COMPUTERNAME%"

REM Encryption key (must match the AI server's key)
set "ADAL_ENCRYPT_KEY=adal-keep-default-key-change-me!!!!"

REM Start the companion
start "" "%~dp0adal-companion.exe"
