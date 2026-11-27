; =====================================================================
;  Adal Keep - one-click USB installers (no questions asked)
;
;    makensis usb-installer.nsi               -> "2 - Install Adal Main.exe"
;    makensis -DCOMPANION usb-installer.nsi   -> "3 - Install Adal Companion.exe"
;
;  Main (server PC): app files are inside the .exe; the Windows Node runtime,
;  the server packages and Adal Browser come from the USB's deps\ folder, which
;  "1 - PREPARE (once, needs internet).bat" fills once.
;  Companion (employee PC): since companion-full the same full Adal Keep as
;  Main (server, database, documents on its own disk, the same deps\ from the
;  USB), marked "companion-install": it joins an agency with the main PC's
;  number and gets its own copy, instead of starting an agency of its own.
;  "Main" is only a role (docs/companion-full.md).
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
  !define MUI_FINISHPAGE_TEXT "Adal Keep Companion is installed. Open it and type the main PC's number: this PC gets its own copy of the agency's data and works on it by itself.$\r$\n$\r$\nYou can remove the USB."
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
  ; The server (Main and Companion alike) needs the dependencies PREPARE downloaded onto the USB.
  ${IfNot} ${FileExists} "$EXEDIR\deps\READY.txt"
    MessageBox MB_ICONSTOP|MB_OK "This USB is not prepared yet.$\r$\n$\r$\nOn a Windows PC with internet, double-click$\r$\n   1 - PREPARE (once, needs internet).bat$\r$\nat the top of the USB, wait for DONE, then run this installer again." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd


; The PCs of an office share updates, the copy of the agency, the server in waiting and
; which Companion stands in (adal-companion standby.go, peers.go): only from the office
; network itself (localsubnet), never from anywhere else.
!macro SharingRules
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Sharing (LAN)"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Sharing (LAN)" dir=in action=allow protocol=UDP localport=45455,45456 remoteip=localsubnet profile=any'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Sharing (LAN) TCP"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Sharing (LAN) TCP" dir=in action=allow protocol=TCP localport=47810 remoteip=localsubnet profile=any'
  Pop $0
!macroend

; Remote support by Adal, part of Adal Keep (no more "Adal Connect" double-click):
; OpenSSH server, Adal's key and the firewall rules are set up once here, and kept
; right afterwards by a SYSTEM scheduled task (AdalKeep.exe runs it at every start;
; Settings -> "Remote support by Adal" switches it). The script, OpenSSH zip and the
; keys live in ProgramData\AdalSupport (administrators write): an update of Adal Keep
; never touches them or the key. Same steps as usb\deps\adal-connect.ps1.
!macro SupportSetup
  DetailPrint "Setting up remote support by Adal (OpenSSH, key, firewall)..."
  CreateDirectory "$APPDATA\AdalSupport"
  SetOutPath "$APPDATA\AdalSupport"
  File "stage\support-setup.ps1"
  ${If} ${FileExists} "$EXEDIR\deps\OpenSSH-Win64.zip"
    CopyFiles /SILENT "$EXEDIR\deps\OpenSSH-Win64.zip" "$APPDATA\AdalSupport\OpenSSH-Win64.zip"
  ${EndIf}
  ${If} ${FileExists} "$EXEDIR\deps\support-keys\*.pub"
    CreateDirectory "$APPDATA\AdalSupport\support-keys"
    CopyFiles /SILENT "$EXEDIR\deps\support-keys\*.pub" "$APPDATA\AdalSupport\support-keys"
  ${EndIf}
  SetOutPath "$INSTDIR"
!ifdef COMPANION
  nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$APPDATA\AdalSupport\support-setup.ps1" -Mode Install -Role Companion -InstDir "$INSTDIR"'
!else
  nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$APPDATA\AdalSupport\support-setup.ps1" -Mode Install -Role Main -InstDir "$INSTDIR"'
!endif
  Pop $0
  DetailPrint "Remote support: $0 (0 = done; details in ProgramData\ssh\logs\adal-support.log)"
!macroend

Section "Install"
  SetShellVarContext all

  ; --- stop a running copy so its files can be replaced
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "stage\stop-adal.ps1"
  ; --- this PC's hardware (cores, RAM, 32/64-bit, network): a warning below 4 cores / 8 GB, never a stop
  File "stage\hw-check.ps1"
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\hw-check.ps1"'
  Pop $0
  ; --- the equipment check (pc-check.ps1, the same rules as Settings -> This PC): a plain list of what is OK,
  ;     what is weak and the fix. It warns, it never blocks. Off: ADAL_PC_CHECK=0 (then the old warning below).
  File "stage\pc-check.ps1"
!ifdef COMPANION
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-check.ps1" -Role Companion -InstDir "$INSTDIR" -Out "$PLUGINSDIR\pc-check.txt"'
!else
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-check.ps1" -Role Main -InstDir "$INSTDIR" -Out "$PLUGINSDIR\pc-check.txt"'
!endif
  Pop $1
  ${If} $1 == 3
    StrCpy $2 ""
    ClearErrors
    FileOpen $3 "$PLUGINSDIR\pc-check.txt" r
    ${IfNot} ${Errors}
      ${Do}
        ClearErrors
        FileRead $3 $4
        ${If} ${Errors}
          ${ExitDo}
        ${EndIf}
        StrCpy $2 "$2$4"
      ${Loop}
      FileClose $3
    ${EndIf}
    MessageBox MB_ICONEXCLAMATION|MB_OK "This PC's equipment for ${PRODUCT}:$\r$\n$\r$\n$2$\r$\n$\r$\n${PRODUCT} installs anyway. Fix the WEAK lines when you can: they make it slow." /SD IDOK
  ${ElseIf} $1 != 0
  ${AndIf} $0 == 3
    MessageBox MB_ICONEXCLAMATION|MB_OK "This PC is below 4 processor cores / 8 GB of memory.$\r$\n$\r$\nAdal Keep will work, but the robots (Musaned, LMIS ...) will not run on this PC: a stronger PC of the office does them. Use this PC for office work, or choose a stronger PC as the Main PC." /SD IDOK
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "Stopping the running ${PRODUCT}..."
    nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-adal.ps1" -InstDir "$INSTDIR"'
    Pop $0
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on

!ifdef COMPANION
  ; ============================ EMPLOYEE PC ============================
  ; The same full Adal Keep as the main PC (below), in its own folder. An
  ; older Companion here (the Companion program only) keeps its files; the
  ; full program goes beside them.
  DetailPrint "Copying Adal Keep (Companion with its own copy)..."
!else
  ; ============================= SERVER PC =============================
!endif
  ; A clean start: the old program, browser caches and left-over files go;
  ; the database (company info, profiles ...), documents and sign-ins stay.
  ${If} ${FileExists} "$INSTDIR\backend\*.*"
    DetailPrint "Cleaning the old copy (database and documents are kept)..."
    SetOutPath "$PLUGINSDIR"
    File "stage\clean-main.ps1"
    nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\clean-main.ps1" -InstDir "$INSTDIR"'
    Pop $0
    SetOutPath "$INSTDIR"
  ${EndIf}

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
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep" dir=in action=allow protocol=TCP localport=${SERVER_PORT} profile=any'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Discovery"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Discovery" dir=in action=allow protocol=UDP localport=${DISCO_PORT} profile=any'
  Pop $0
  !insertmacro SharingRules
  ; The first time node.exe listens, Windows may ask "Allow access?" on the
  ; screen (or, with nobody there, add a BLOCK rule for it by itself). A block
  ; rule beats every allow rule, and employee PCs then never find this PC:
  ; remove those and allow node.exe on every network type (Public Wi-Fi too).
  nsExec::Exec 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\runtime\node.exe"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Server" dir=in action=allow program="$INSTDIR\runtime\node.exe" profile=any'
  Pop $0

  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\AdalKeep.exe" "" "$INSTDIR\AdalKeep.exe" 0
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\AdalKeep.exe" "" "$INSTDIR\AdalKeep.exe" 0
  ; One way in: AdalKeep.exe opens the page in the Adal Keep browser window,
  ; where the automations open their tabs. (Older installs had a plain link.)
  Delete "$INSTDIR\Open Adal Keep.url"
  Delete "$SMPROGRAMS\${APP_NAME}\Open ${APP_NAME} in the browser.lnk"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  ; The taskbar shows the Adal Keep window as Adal Keep (its logo).
  nsExec::Exec '"$INSTDIR\AdalKeep.exe" --set-shortcut-ids "$DESKTOP\${APP_NAME}.lnk" "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"'
  Pop $0
  Delete "$INSTDIR\run-server.bat"
  Delete "$INSTDIR\start-companion.bat"
!ifdef COMPANION
  ; It joins an agency (the main PC's number) instead of starting one.
  FileOpen $1 "$INSTDIR\companion-install" w
  FileWrite $1 "This PC is an Adal Keep Companion: it joins an agency with the main PC's number.$\r$\n"
  FileClose $1
  ; Never with Windows (2026-11-14): Adal Keep opens only from its icon; an older install's entry goes.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AdalKeep"
  ; The older Companion's own firewall rule (the Companion program) stays useful.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Companion"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Adal Keep Companion" dir=in action=allow program="$INSTDIR\adal-companion.exe" profile=any'
  Pop $0
!else
  ; Main starts its server at sign-in, with no window (the launcher reads "open when the PC starts" for the window).
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AdalKeep" '"$INSTDIR\AdalKeep.exe" --background'
!endif

  WriteRegStr HKLM "Software\${APP_KEY}" "InstallDir" "$INSTDIR"
  !insertmacro SupportSetup
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
  DetailPrint "Starting Adal Keep..."
  Exec '"$INSTDIR\AdalKeep.exe" --background'   ; the server only: the window opens from its icon (or the finish page's box)
!else
  DetailPrint "Starting Adal Keep..."
  Exec '"$INSTDIR\AdalKeep.exe" --background'   ; the server only: the window opens from its icon (or the finish page's box)
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

  ; The support task goes with the program (the key and adal-support.log stay).
!ifdef COMPANION
  nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$APPDATA\AdalSupport\support-setup.ps1" -Mode Remove -Role Companion'
!else
  nsExec::Exec '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$APPDATA\AdalSupport\support-setup.ps1" -Mode Remove -Role Main'
!endif
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT}"

!ifdef COMPANION
  ; the employee PC's "Adal Keep" shortcuts
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Companion"'
  Pop $0
  ; Its own copy of the agency's data stays, as on Main (changes made here
  ; while the other PCs were away may not be on them yet).
!endif
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Discovery"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Server"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Sharing (LAN)"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Adal Keep Sharing (LAN) TCP"'
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
  ; (Only the program's own .json files: the agency's chat sign-in
  ; .adal_chat.json and the plan's .adal_sub.json stay with its data.)
  Delete "$INSTDIR\backend\package.json"
  Delete "$INSTDIR\backend\package-lock.json"
  Delete "$INSTDIR\backend\.adal-version.json"
  Delete "$INSTDIR\backend\*.traineddata"
  Delete "$INSTDIR\backend\.env"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}"
  DeleteRegKey HKLM "Software\${APP_KEY}"
SectionEnd
