@echo off
REM LocWarp — one-shot build: backend exe + tunnel exe + electron installer.
REM Prereqs (install once):
REM   - Python 3.12  + pip install -r backend/requirements.txt pyinstaller
REM   - Python 3.13  + pip install pymobiledevice3 pyinstaller
REM   - Node.js 18+  + cd frontend && npm install && npm install -D electron-builder

setlocal enabledelayedexpansion
cd /d "%~dp0"
set ROOT=%cd%

echo.
echo ============================================================
echo  [1/4] Build backend (Python 3.12) with PyInstaller
echo ============================================================
cd /d "%ROOT%\backend"
py -3.12 -m PyInstaller locwarp-backend.spec --noconfirm --distpath "%ROOT%\dist-py" --workpath "%ROOT%\build-py\backend"
if errorlevel 1 (echo backend build failed & exit /b 1)

echo.
echo ============================================================
echo  [2/4] Build wifi-tunnel (Python 3.13) with PyInstaller
echo ============================================================
cd /d "%ROOT%"
py -3.13 -m PyInstaller wifi-tunnel.spec --noconfirm --distpath "%ROOT%\dist-py" --workpath "%ROOT%\build-py\tunnel"
if errorlevel 1 (echo tunnel build failed & exit /b 1)

echo.
echo ============================================================
echo  [3/4] Build frontend (Vite)
echo ============================================================
cd /d "%ROOT%\frontend"
call npm run build
if errorlevel 1 (echo frontend build failed & exit /b 1)

echo.
echo ============================================================
echo  [4/4] Package Electron installer (electron-builder)
echo ============================================================
call npx electron-builder --win nsis
if errorlevel 1 (echo installer build failed & exit /b 1)

echo.
echo ============================================================
echo  DONE — installer is in frontend\release\
echo ============================================================
dir /b "%ROOT%\frontend\release\*.exe"
endlocal
