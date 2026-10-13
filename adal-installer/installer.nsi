; =====================================================================
;  Adal Keep - single installer for two roles
;    Server PC    : full stack (Node runtime, backend, web UI, agent)
;    Employee PC  : Adal Keep Companion (scans -> Server PC)
;  Build with:  bash adal-installer/build-installer.sh
;  Silent usage: AdalKeep-Setup.exe /S                  (Server PC)
;                AdalKeep-Setup.exe /S /COMPANION       (Employee PC)
; =====================================================================
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!define APP_NAME    "Adal Keep"
!define APP_PUBLISH "Adal Software PLC"
!define APP_VER     "1.0.0"
!define APP_KEY     "AdalKeep"
!define SERVER_PORT 4000
!define DISCO_PORT  45454

Name "${APP_NAME}"
OutFile "AdalKeep-Setup.exe"
InstallDir "C:\AdalKeep"
InstallDirRegKey HKLM "Software\${APP_KEY}" "InstallDir"
RequestExecutionLevel admin
BrandingText "${APP_PUBLISH} 2026"
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "1.0.0.0"
VIAddVersionKey /LANG=1033 "ProductName"     "${APP_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName"     "${APP_PUBLISH}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey /LANG=1033 "FileVersion"     "${APP_VER}"
VIAddVersionKey /LANG=1033 "LegalCopyright"  "${APP_PUBLISH} 2026"

!define MUI_ICON   "..\adal.ico"
!define MUI_UNICON "..\adal.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE

!define MUI_WELCOMEPAGE_TITLE "${APP_NAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "This installs ${APP_NAME} - documents, AI extraction, verification and police-clearance for ${APP_PUBLISH}.$\r$\n$\r$\nNext you choose the role of THIS computer:$\r$\n  - Server PC: keeps the database and the web app (one per office)$\r$\n  - Employee PC: sends scanned documents to the Server PC$\r$\n$\r$\nAll computers talk over your local network (LAN) on port ${SERVER_PORT}; the Server PC is found automatically."

!insertmacro MUI_PAGE_WELCOME
Page custom RolePageCreate RolePageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "${APP_NAME} is installed"
!define MUI_FINISHPAGE_TEXT "Server PC: open the '${APP_NAME}' shortcut. The first-run wizard asks for the company details, the CEO phone number and the users.$\r$\n$\r$\nEmployee PC: the Companion starts automatically, finds the Server PC on the network and watches your Desktop + Downloads folders.$\r$\n$\r$\nPlease restart the computer once before training the staff."
!insertmacro MUI_PAGE_FINISH

!define MUI_UNTEXT_CONFIRM_TITLE "Uninstall ${APP_NAME}"
!define MUI_UNTEXT_CONFIRM_TEXT "This removes ${APP_NAME} from this computer.$\r$\n$\r$\nWARNING - on the Server PC this also deletes the Adal Keep database and all uploaded documents. Back them up first (Admin > Backups) before you continue."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var Role       ; 0 = Server PC, 1 = Employee PC
Var DoBrave    ; 1 = install Brave browser
Var RbServer
Var RbEmployee
Var CbBrave
Var Dialog

Function .onInit
    StrCpy $Role 0
    StrCpy $DoBrave 1

    ; silent installs can pick the employee role: /S /COMPANION
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "/COMPANION" $R1
    ${IfNot} ${Errors}
        StrCpy $Role 1
    ${EndIf}
FunctionEnd

Function RolePageCreate
    !insertmacro MUI_HEADER_TEXT "Choose the role of this computer" "Server PC for the main office computer, Employee PC for the other workstations."

    nsDialogs::Create 1018
    Pop $Dialog
    ${If} $Dialog == error
        Abort
    ${EndIf}

    ${NSD_CreateRadioButton} 0 0u 100% 12u "Server PC  -  main computer (database, web app, AI, automations)"
    Pop $RbServer
    ${NSD_CreateLabel} 10u 13u 88% 20u "Install this on the computer that stores the profiles. It serves every Employee PC over the LAN and should stay switched on during office hours. Needs about 1 GB of free disk space."
    Pop $0

    ${NSD_CreateRadioButton} 0 40u 100% 12u "Employee PC  -  sends scanned documents to the Server PC"
    Pop $RbEmployee
    ${NSD_CreateLabel} 10u 53u 88% 20u "Installs the small Adal Keep Companion (about 8 MB). It watches Desktop and Downloads, sends every new passport or clearance scan to the Server PC and starts with Windows."
    Pop $0

    ${NSD_CreateCheckBox} 0 82u 100% 12u "Also install the Brave browser (recommended, needs internet)"
    Pop $CbBrave

    ${If} $Role == 0
        ${NSD_SetState} $RbServer ${BST_CHECKED}
    ${Else}
        ${NSD_SetState} $RbEmployee ${BST_CHECKED}
    ${EndIf}
    ${If} $DoBrave == 1
        ${NSD_SetState} $CbBrave ${BST_CHECKED}
    ${EndIf}

    nsDialogs::Show
FunctionEnd

Function RolePageLeave
    ${NSD_GetState} $RbServer $0
    ${If} $0 == ${BST_CHECKED}
        StrCpy $Role 0
    ${Else}
        StrCpy $Role 1
    ${EndIf}
    ${NSD_GetState} $CbBrave $DoBrave
FunctionEnd

Section "Adal Keep" SEC_MAIN
    SectionIn RO
    SetShellVarContext all
    SetOutPath "$INSTDIR"
    SetOverwrite on

    WriteRegStr HKLM "Software\${APP_KEY}" "InstallDir" "$INSTDIR"
    WriteRegStr HKLM "Software\${APP_KEY}" "Role" "$Role"
    WriteRegStr HKLM "Software\${APP_KEY}" "Port" "${SERVER_PORT}"

    ${If} $Role == 0
        ; ------------------------- SERVER PC -------------------------
        DetailPrint "Installing the Adal Keep server stack..."
        File /r "bundle\*"

        CreateDirectory "$INSTDIR\backend\data"
        CreateDirectory "$INSTDIR\backend\data\SafeStorage"
        CreateDirectory "$INSTDIR\backend\uploads"

        DetailPrint "Granting write access to the Adal Keep folders..."
        nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'

        DetailPrint "Opening the firewall for Adal Keep (TCP ${SERVER_PORT} + UDP ${DISCO_PORT})..."
        nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Adal Keep"'
        nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Adal Keep" dir=in action=allow protocol=TCP localport=${SERVER_PORT}'
        nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Adal Keep Discovery"'
        nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Adal Keep Discovery" dir=in action=allow protocol=UDP localport=${DISCO_PORT}'

        ; --- shortcuts
        CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\AdalKeep.exe" "" "$INSTDIR\AdalKeep.exe" 0
        CreateDirectory "$SMPROGRAMS\${APP_NAME}"
        CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} Server.lnk" "$INSTDIR\AdalKeep.exe" "" "$INSTDIR\AdalKeep.exe" 0
        WriteINIStr "$INSTDIR\Open Adal Keep.url" "InternetShortcut" "URL" "http://localhost:${SERVER_PORT}"
        CreateShortcut "$SMPROGRAMS\${APP_NAME}\Open ${APP_NAME}.lnk" "$INSTDIR\Open Adal Keep.url"
        CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

        ; --- start with Windows (minimized, self-restarting)
        WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}" '"$INSTDIR\run-server.bat"'
    ${Else}
        ; ------------------------ EMPLOYEE PC ------------------------
        DetailPrint "Installing the Adal Keep Companion..."
        File "bundle\adal-companion.exe"
        File "bundle\start-companion.bat"

        ; let the Companion save the discovered server into companion.conf
        nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'

        CreateDirectory "$SMPROGRAMS\${APP_NAME}"
        CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} Companion.lnk" "$INSTDIR\start-companion.bat" "" "$INSTDIR" 0 SW_SHOWMINIMIZED
        CreateShortcut "$DESKTOP\${APP_NAME} Companion.lnk" "$INSTDIR\start-companion.bat" "" "$INSTDIR" 0 SW_SHOWMINIMIZED
        CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

        WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}Companion" '"$INSTDIR\start-companion.bat"'
    ${EndIf}

    WriteUninstaller "$INSTDIR\uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "DisplayName" "${APP_NAME}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "Publisher" "${APP_PUBLISH}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "DisplayVersion" "${APP_VER}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "NoModify" "1"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "NoRepair" "1"

    ; --- start right away (never during a silent install)
    IfSilent skipLaunch
    ${If} $Role == 0
        DetailPrint "Starting Adal Keep..."
        ExecShell "open" "$INSTDIR\AdalKeep.exe"
    ${Else}
        DetailPrint "Starting the Adal Keep Companion..."
        Exec '"$INSTDIR\start-companion.bat"'
    ${EndIf}
    skipLaunch:
SectionEnd

Section "Brave browser" SEC_BRAVE
    ${If} $DoBrave != 1
        DetailPrint "Skipping the Brave browser."
    ${Else}
        InitPluginsDir
        SetOutPath "$PLUGINSDIR"
        File "bundle\install-brave.ps1"
        DetailPrint "Installing the Brave browser (best effort - needs internet)..."
        nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-brave.ps1"'
        Pop $0
        SetOutPath "$INSTDIR"
    ${EndIf}
SectionEnd

Section "Uninstall"
    SetShellVarContext all

    nsExec::ExecToLog 'taskkill /f /im AdalKeep.exe'
    nsExec::ExecToLog 'taskkill /f /im adal-companion.exe'
    nsExec::ExecToLog 'taskkill /f /im adal-agent.exe'
    nsExec::ExecToLog 'taskkill /f /im node.exe'

    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Adal Keep"'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Adal Keep Discovery"'

    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}"
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_KEY}Companion"

    Delete "$DESKTOP\${APP_NAME}.lnk"
    Delete "$DESKTOP\${APP_NAME} Companion.lnk"
    RMDir /r "$SMPROGRAMS\${APP_NAME}"

    RMDir /r "$INSTDIR"

    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}"
    DeleteRegKey HKLM "Software\${APP_KEY}"
SectionEnd
