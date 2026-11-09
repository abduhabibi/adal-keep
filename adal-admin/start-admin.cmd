@echo off
rem Adal Keep Admin on Windows: starts the panel when it is not running, then
rem opens it in its own window (Chrome / Edge app window, no browser bar).
cd /d "%~dp0"
curl -s -o nul http://localhost:4100/ 2>nul
if errorlevel 1 (
  start "Adal Keep Admin server" /min "C:\AdalKeep\runtime\node.exe" server.mjs
  timeout /t 4 /nobreak >nul
)
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://localhost:4100 --user-data-dir="%USERPROFILE%\.adal-keep\admin-window" --no-first-run
) else (
  start "" http://localhost:4100
)
