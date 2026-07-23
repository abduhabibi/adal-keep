@echo off
echo ===================================================
echo   Adal Keep - SSH Setup for Silent Updates
echo ===================================================
echo.
echo This script will set up SSH authentication so the
echo "Check for Updates" button works without passwords.
echo.
pause

:: 1. Check if Git is installed
where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Git is not installed. Please install Git for Windows first:
    echo    https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

:: 2. Generate SSH key if it doesn't exist
if not exist "%USERPROFILE%\.ssh\id_ed25519" (
    echo 🔑 Generating SSH key...
    ssh-keygen -t ed25519 -C "adal-keep-client" -N "" -f "%USERPROFILE%\.ssh\id_ed25519"
    echo.
) else (
    echo ✅ SSH key already exists.
)

:: 3. Show public key for manual GitHub addition
echo.
echo ===================================================
echo   📋 STEP 1: Copy the key below
echo ===================================================
type "%USERPROFILE%\.ssh\id_ed25519.pub"
echo.
echo ===================================================
echo   📋 STEP 2: Add it to GitHub
echo ===================================================
echo 1. Go to: https://github.com/settings/keys
echo 2. Click "New SSH key"
echo 3. Title: "Adal Keep - %COMPUTERNAME%"
echo 4. Paste the key above and click "Add SSH key"
echo.
pause

:: 4. Configure SSH for GitHub
echo 🔧 Configuring SSH for GitHub...
echo Host github.com> "%USERPROFILE%\.ssh\config"
echo   IdentityFile %USERPROFILE%\.ssh\id_ed25519>> "%USERPROFILE%\.ssh\config"
echo   IdentitiesOnly yes>> "%USERPROFILE%\.ssh\config"
icacls "%USERPROFILE%\.ssh\config" /inheritance:r /grant:r "%USERNAME%:R" /grant:r "%USERNAME%:W" >nul 2>nul

:: 5. Set remote to SSH format (if in a git repo)
if exist ".git" (
    echo 🔗 Updating Git remote to SSH...
    git remote set-url origin git@github.com:abduhabibi/adal-keep.git
    echo.
    echo 🧪 Testing connection...
    ssh -T git@github.com
    echo.
    echo 🔄 Testing git pull...
    git pull
) else (
    echo ⚠️  Not in a Git repository. Run this script from your adal-keep folder.
)

echo.
echo ===================================================
echo   ✅ Setup complete!
echo ===================================================
echo The "Check for Updates" button will now work silently.
echo You only need to run this script ONCE per computer.
echo.
pause
