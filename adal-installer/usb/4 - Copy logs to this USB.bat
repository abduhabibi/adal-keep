@echo off
REM ============================================================
REM  Adal Keep - copy this PC's logs onto the USB (for Adal)
REM  Nothing is changed on the PC. The logs land in
REM  logs\<PC name>\ next to this file.
REM ============================================================
setlocal
set "DEST=%~dp0logs\%COMPUTERNAME%"
if not exist "%DEST%" mkdir "%DEST%"

set "MAIN=C:\AdalKeep"
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\AdalKeep" /v InstallDir 2^>nul ^| find "InstallDir"') do set "MAIN=%%B"
set "COMP=C:\AdalKeepCompanion"
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\AdalKeepCompanion" /v InstallDir 2^>nul ^| find "InstallDir"') do set "COMP=%%B"

echo Copying the logs of %COMPUTERNAME% ...
for %%F in ("%MAIN%\install.log" "%MAIN%\backend\data\launcher.log" "%MAIN%\backend\data\server.log" "%COMP%\companion.log" "%COMP%\companion.log.old") do (
  if exist "%%~F" copy /y "%%~F" "%DEST%\" >nul && echo   %%~nxF
)
REM Where Brave is (the launcher opens Adal Keep in it)
(
  echo Brave:
  dir /b "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" 2^>nul
  dir /b "%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe" 2^>nul
  dir /b "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe" 2^>nul
  echo.
  echo Running:
  tasklist /fi "imagename eq AdalKeep.exe" /fi "status eq running" /nh
  tasklist /fi "imagename eq node.exe" /nh
  tasklist /fi "imagename eq adal-companion.exe" /nh
  tasklist /fi "imagename eq brave.exe" /nh
) > "%DEST%\pc-check.txt" 2>&1
echo.
echo Done. The logs are on the USB in: logs\%COMPUTERNAME%
echo Bring the USB back to Adal.
pause
