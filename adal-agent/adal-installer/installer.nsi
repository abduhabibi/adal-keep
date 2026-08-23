!include "MUI2.nsh"

Name "Adal Keep"
OutFile "AdalKeep-Setup.exe"
InstallDir "$PROGRAMFILES\AdalKeep"
RequestExecutionLevel admin
BrandingText "Adal Software © 2026"

!define MUI_ICON "icon.ico"
!define MUI_HEADERIMAGE
!define MUI_WELCOMEPAGE_TITLE "Welcome to Adal Keep Setup"
!define MUI_WELCOMEPAGE_TEXT "This will install Adal Keep Document Management System on your computer.$\r$\n$\r$\nClick Next to continue."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
    SetOutPath "$INSTDIR"
    
    ; Copy all bundled files
    File /r "bundle\*"
    
    ; Create desktop shortcut
    CreateShortcut "$DESKTOP\Adal Keep.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\icon.ico"
    
    ; Create start menu entry
    CreateDirectory "$SMPROGRAMS\Adal Keep"
    CreateShortcut "$SMPROGRAMS\Adal Keep\Adal Keep.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\icon.ico"
    CreateShortcut "$SMPROGRAMS\Adal Keep\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    
    ; Write uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"
    
    ; Registry for Add/Remove Programs
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalKeep" "DisplayName" "Adal Keep"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalKeep" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalKeep" "Publisher" "Adal Software"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalKeep" "DisplayVersion" "1.0.0"
SectionEnd

Section "Uninstall"
    RMDir /r "$INSTDIR"
    Delete "$DESKTOP\Adal Keep.lnk"
    RMDir /r "$SMPROGRAMS\Adal Keep"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AdalKeep"
SectionEnd
