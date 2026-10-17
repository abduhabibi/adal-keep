; =====================================================================
;  Adal Keep - one-click USB installers (no questions asked)
;
;    makensis usb-installer.nsi               -> "2 - Install Adal Main.exe"
;    makensis -DCOMPANION usb-installer.nsi   -> "3 - Install Adal Companion.exe"
;
;  Main (server PC): app files are inside the .exe; the Windows Node runtime,
;  the server packages and Brave come from the USB's deps\ folder, which
;  "1 - PREPARE (once, needs internet).bat" fills once.
;  Companion (employee PC): fully self-contained, needs nothing else.
;
;  Built by build-installer.sh from the stage\ folder it assembles.
;  Silent use (IT): add /S.
; =====================================================================
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define APP_NAME    "Adal Keep"
!define APP_PUBLISH "Adal Software PLC"
!define APP_VER     "1.1.0"
!define SERVER_PORT 4000
!define DISCO_PORT  45454

!ifdef COMPANION
  !define PRODUCT  "Adal Keep Companion"
  !define APP_KEY  "AdalKeepCompanion"
  OutFile "3 - Install Adal Companion.exe"
  InstallDir "C:\AdalKeepCompanion"
!else
  !define PRODUCT  "Adal Keep"
  !define APP_KEY  "AdalKeep"
  OutFile "2 - Install Adal Main.exe"
  InstallDir "C:\AdalKeep"
!endif

Name "${PRODUCT}"
RequestExecutionLevel admin
BrandingText "${APP_PUBLISH} 2026"
SetCompressor /SOLID lzma
ShowInstDetails hide
ShowUninstDetails hide

VIProductVersion "1.1.0.0"
VIAddVersionKey /LANG=1033 "ProductName"     "${PRODUCT}"
VIAddVersionKey /LANG=1033 "CompanyName"     "${APP_PUBLISH}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey /LANG=1033 "FileVersion"     "${APP_VER}"
VIAddVersionKey /LANG=1033 "LegalCopyright"  "${APP_PUBLISH} 2026"

!define MUI_ICON   "..\adal.ico"
!define MUI_UNICON "..\adal.ico"
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "${PRODUCT} is installed"

; No questions: a progress bar with plain steps, then "installed".
!define MUI_FINISHPAGE_TITLE "${PRODUCT} is installed"
!ifdef COMPANION
  !define MUI_FINISHPAGE_TEXT "The Companion is running. It starts by itself with Windows and finds the main Adal Keep PC on the network.$\r$\n$\r$\nYou can remove the USB."
!else
  !define MUI_FINISHPAGE_TEXT "Adal Keep is running and starts by itself with Windows.$\r$\n$\r$\nOn this PC:  http://localhost:${SERVER_PORT}$\r$\n$\r$\nYou can remove the USB."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Open Adal Keep now"
  !define MUI_FINISHPAGE_RUN_FUNCTION OpenApp
!endif
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext all
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "${PRODUCT} needs 64-bit Windows 10 or 11." /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}
!ifndef COMPANION
  ; The server needs the dependencies PREPARE downloaded onto the USB.
  ${IfNot} ${FileExists} "$EXEDIR\deps\READY.txt"
    MessageBox MB_ICONSTOP|MB_OK "This USB is not prepared yet.$\r$\n$\r$\nOn a Windows PC with internet, double-click$\r$\n   1 - PREPARE (once, needs internet).bat$\r$\nat the top of the USB, wait for DONE, then run this installer again." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!endif
FunctionEnd

Section "Install"
  SetShellVarContext all

  ; --- stop a running copy so its files can be replaced
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "stage\stop-adal.ps1"
  ${If} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "Stopping the running ${PRODUCT}..."
    nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-adal.ps1" -InstDir "$INSTDIR"'
    Pop $0
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on

!ifdef COMPANION
  ; ============================ EMPLOYEE PC ============================
  DetailPrint "Copying the Companion..."
  File /r "stage\companion\*"
  ; the Companion saves the discovered server into companion.conf here
  nsExec::Exec 'icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /C /Q'
  Pop $0

  DetailPrint "Allowing it through the Windows firewall..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Companion"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Companion" dir=in action=allow program="$INSTDIR\adal-companion.exe"'
  Pop $0

  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\start-companion.bat" "" "$INSTDIR\adal-companion.exe" 0 SW_SHOWMINIMIZED
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\start-companion.bat" "" "$INSTDIR\adal-companion.exe" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Uninstall ${PRODUCT}.lnk" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}" '"$INSTDIR\start-companion.bat"'
!else
  ; ============================= SERVER PC =============================
  DetailPrint "Copying Adal Keep..."
  File /r "stage\main\*"
  CreateDirectory "$INSTDIR\backend\data"
  CreateDirectory "$INSTDIR\backend\data\SafeStorage"
  CreateDirectory "$INSTDIR\backend\uploads"
  CreateDirectory "$INSTDIR\inbox"

  DetailPrint "Unpacking the server from the USB (about a minute)..."
  nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\finish-install.ps1" -InstDir "$INSTDIR" -Deps "$EXEDIR\deps"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Adal Keep could not finish installing (step: dependencies).$\r$\n$\r$\nThe details are in $INSTDIR\install.log.$\r$\nRun PREPARE on the USB again, then run this installer again." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}

  Delete "$INSTDIR\finish-install.ps1"   ; only needed during the install

  DetailPrint "Setting folder permissions..."
  nsExec::Exec 'icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /C /Q'
  Pop $0

  DetailPrint "Allowing it through the Windows firewall..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep" dir=in action=allow protocol=TCP localport=${SERVER_PORT}'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Discovery"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Discovery" dir=in action=allow protocol=UDP localport=${DISCO_PORT}'
  Pop $0

  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\AdalKeep.exe" "" "$INSTDIR\AdalKeep.exe" 0
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\AdalKeep.exe" "" "$INSTDIR\AdalKeep.exe" 0
  WriteINIStr "$INSTDIR\Open Adal Keep.url" "InternetShortcut" "URL" "http://localhost:${SERVER_PORT}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Open ${APP_NAME} in the browser.lnk" "$INSTDIR\Open Adal Keep.url"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  ; start the server with Windows (minimised, restarts itself if it stops)
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}" '"$INSTDIR\run-server.bat"'
!endif

  WriteRegStr HKLM "Software\${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "DisplayIcon" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "Publisher" "${APP_PUBLISH}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "DisplayVersion" "${APP_VER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "NoRepair" 1

  ; --- start it now (a silent IT install leaves that to the next login)
  IfSilent done
!ifdef COMPANION
  DetailPrint "Starting the Adal Keep Companion..."
  Exec '"$INSTDIR\start-companion.bat"'
!else
  DetailPrint "Starting Adal Keep..."
  Exec '"$INSTDIR\run-server.bat"'
!endif
  DetailPrint "Done."
  done:
SectionEnd

!ifndef COMPANION
Function OpenApp
  ExecShell "open" "$INSTDIR\AdalKeep.exe"
FunctionEnd
!endif

Function un.onInit
  SetShellVarContext all
  SetRegView 64
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "stage\stop-adal.ps1"
  nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-adal.ps1" -InstDir "$INSTDIR"'
  Pop $0
  SetOutPath "$TEMP"

  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT}"

!ifdef COMPANION
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Companion"'
  Pop $0
  RMDir /r "$INSTDIR"
!else
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Discovery"'
  Pop $0
  ; Program files go; the database and uploaded documents STAY
  ; (backend\data.sqlite, backend\data\, backend\uploads\), so a reinstall
  ; picks up where it left off. Delete C:\AdalKeep by hand to wipe them.
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\frontend"
  RMDir /r "$INSTDIR\backend\src"
  RMDir /r "$INSTDIR\backend\node_modules"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.bat"
  Delete "$INSTDIR\*.ps1"
  Delete "$INSTDIR\*.url"
  Delete "$INSTDIR\backend\*.js"
  Delete "$INSTDIR\backend\*.json"
  Delete "$INSTDIR\backend\*.traineddata"
  Delete "$INSTDIR\backend\.env"
!endif

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}"
  DeleteRegKey HKLM "Software\${APP_KEY}"
SectionEnd
