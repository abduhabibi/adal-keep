!include "MUI2.nsh"

Name "Adal Companion"
OutFile "AdalCompanion-Setup.exe"
InstallDir "$PROGRAMFILES\AdalCompanion"
RequestExecutionLevel admin
BrandingText "Adal Software PLC 2026"

!define MUI_WELCOMEPAGE_TITLE "Welcome to Adal Companion Setup"
!define MUI_WELCOMEPAGE_TEXT "Adal Companion watches your Downloads and Desktop folders.$\r$\n$\r$\nWhen you save a passport photo or document, it automatically:$\r$\n  1. Encrypts the file$\r$\n  2. Sends it to the Adal Keep AI Server$\r$\n  3. AI extracts the data and creates a draft profile$\r$\n$\r$\nClick Next to continue."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
    SetOutPath "$INSTDIR"
    File "adal-companion.exe"
    File "config.bat"

    CreateShortcut "$DESKTOP\Adal Companion.lnk" "$INSTDIR\config.bat" ""
    CreateDirectory "$SMPROGRAMS\Adal Companion"
    CreateShortcut "$SMPROGRAMS\Adal Companion\Adal Companion.lnk" "$INSTDIR\config.bat" ""
    CreateShortcut "$SMPROGRAMS\Adal Companion\Uninstall.lnk" "$INSTDIR\uninstall.exe"

    ; Add to startup
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AdalCompanion" "$\"$INSTDIR\adal-companion.exe$\""

    WriteUninstaller "$INSTDIR\uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalCompanion" "DisplayName" "Adal Companion"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalCompanion" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalCompanion" "Publisher" "Adal Software PLC"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalCompanion" "DisplayVersion" "1.0.0"
SectionEnd

Section "Uninstall"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AdalCompanion"
    RMDir /r "$INSTDIR"
    Delete "$DESKTOP\Adal Companion.lnk"
    RMDir /r "$SMPROGRAMS\Adal Companion"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalCompanion"
SectionEnd
