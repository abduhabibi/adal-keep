@echo off
title Adal Companion v2.0 - Setup
color 0B
echo ============================================
echo    ADAL COMPANION v2.0 (Encrypted)
echo ============================================
echo.
set /p HOST_IP="Enter Host PC IP address: "
if "%HOST_IP%"=="" (echo [ERROR] IP required! & pause & exit /b 1)
set /p CLIENT_NAME="Enter your name/PC ID: "
if "%CLIENT_NAME%"=="" set CLIENT_NAME=%COMPUTERNAME%
set INSTALL_DIR=%LOCALAPPDATA%\AdalCompanion
mkdir "%INSTALL_DIR%" 2>nul
copy /Y "%~dp0adal-companion.exe" "%INSTALL_DIR%\" >nul
(
echo @echo off
echo set ADAL_HOST_URL=http://%HOST_IP%:4000
echo set ADAL_CLIENT_NAME=%CLIENT_NAME%
echo set ADAL_ENCRYPT_KEY=adal-keep-default-key-change-me!!!!
echo start /min "" "%INSTALL_DIR%\adal-companion.exe"
) > "%INSTALL_DIR%\start-companion.bat"
copy /Y "%INSTALL_DIR%\start-companion.bat" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\" >nul
set ADAL_HOST_URL=http://%HOST_IP%:4000
set ADAL_CLIENT_NAME=%CLIENT_NAME%
set ADAL_ENCRYPT_KEY=adal-keep-default-key-change-me!!!!
start /min "" "%INSTALL_DIR%\adal-companion.exe"
echo.
echo ✅ Companion v2.0 installed (Encrypted)
echo    Host: http://%HOST_IP%:4000
echo    Client: %CLIENT_NAME%
echo    Watches: Desktop, Downloads
echo    Auto-starts on login
echo ============================================
pause
