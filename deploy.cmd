@echo off
REM Quick deploy script — git push to GitHub (Vercel auto-deploys)
REM Run this from Command Prompt inside Stock_Count_App folder

echo.
echo === Stock Count — Quick Deploy ===
echo.

REM Check git installed
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not installed. Download from https://git-scm.com/download/win
    pause
    exit /b 1
)

REM Check git initialized
if not exist ".git" (
    echo [INFO] Initializing git repo...
    git init
    git branch -M main
    echo.
    echo [NEXT STEP] Run these commands manually:
    echo   git remote add origin https://github.com/YOUR_USERNAME/stock-count.git
    echo   then re-run deploy.cmd
    pause
    exit /b 0
)

REM Get commit message from arg or prompt
set MSG=%~1
if "%MSG%"=="" (
    set /p MSG="Commit message: "
)
if "%MSG%"=="" set MSG=Update Stock Count

echo.
echo [1/3] git add .
git add .

echo [2/3] git commit -m "%MSG%"
git commit -m "%MSG%"

echo [3/3] git push
git push

echo.
echo === Done! Vercel will deploy in ~30 seconds ===
pause
