@echo off
REM Adal Keep phone app: puts "Adal Keep.apk" on an Android phone plugged in
REM with a USB cable. (Or send "Adal Keep.apk" with Xender and open it there.)
cd /d "%~dp0"
set ADB=%~dp0..\deps\platform-tools\adb.exe
if not exist "%ADB%" (
  echo The phone tools are missing on this USB. Send "Adal Keep.apk" with Xender instead.
  pause
  exit /b 1
)
echo.
echo  1. Plug the phone into this PC with a USB cable.
echo  2. On the phone: Settings ^> About phone ^> tap "Build number" 7 times,
echo     then Settings ^> Developer options ^> turn on "USB debugging".
echo  3. On the phone, press "Allow" when it asks about USB debugging.
echo.
echo Waiting for the phone...
"%ADB%" wait-for-device
echo Installing Adal Keep on the phone...
"%ADB%" install -r "Adal Keep.apk"
if errorlevel 1 (
  echo.
  echo Not installed. Check the phone screen, then try again - or send "Adal Keep.apk" with Xender.
) else (
  echo.
  echo Done. Open "Adal Keep" on the phone and type the PC's number
  echo ^(Adal Keep on the PC: Settings ^> Main PC^).
)
"%ADB%" kill-server >nul 2>&1
pause
