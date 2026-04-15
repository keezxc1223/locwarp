@echo off
REM LocWarp, one-shot build: backend exe + electron installer.
REM Prereqs (install once):
REM   - Python 3.13  + pip install -r backend/requirements.txt pyinstaller
REM   - Node.js 18+  + cd frontend && npm install && npm install -D electron-builder

setlocal enabledelayedexpansion
cd /d "%~dp0"
set ROOT=%cd%

echo.
echo ============================================================
echo  [1/3] Build backend (Python 3.13) with PyInstaller
echo ============================================================
cd /d "%ROOT%\backend"
py -3.13 -m PyInstaller locwarp-backend.spec --noconfirm --distpath "%ROOT%\dist-py" --workpath "%ROOT%\build-py\backend"
if errorlevel 1 (echo backend build failed & exit /b 1)

echo.
echo ============================================================
echo  [2/3] Build frontend (Vite)
echo ============================================================
cd /d "%ROOT%\frontend"
call npm run build
if errorlevel 1 (echo frontend build failed & exit /b 1)

echo.
echo ============================================================
echo  [3/3] Package Electron installer (electron-builder)
echo ============================================================
call npx electron-builder --win nsis
if errorlevel 1 (echo installer build failed & exit /b 1)

echo.
echo ============================================================
echo  DONE, installer is in frontend\release\
echo ============================================================
dir /b "%ROOT%\frontend\release\*.exe"
endlocal
