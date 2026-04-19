@echo off
:: ============================================================
::  LocWarp — Windows one-shot build
::  Produces: frontend\release\LocWarp Setup *.exe
::
::  Prerequisites (install once, run as Administrator):
::    winget install Python.Python.3.12
::    winget install Python.Python.3.13
::    py -3.12 -m pip install -r backend\requirements.txt pyinstaller
::    py -3.13 -m pip install pymobiledevice3 pytun-pmd3 pyinstaller
::    winget install OpenJS.NodeJS
::    cd frontend && npm install
:: ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "ROOT=%cd%"
set "DIST_PY=%ROOT%\dist-py"
set "BUILD_PY=%ROOT%\build-py"

echo.
echo ============================================================
echo   LocWarp Build  —  %DATE% %TIME%
echo ============================================================

:: ── Check for Administrator privileges ────────────────────
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo [WARNING] Not running as Administrator.
  echo   iOS 17+ tunnel creation needs elevated privileges.
  echo   Right-click this .bat and choose "Run as administrator".
  echo.
)

:: ── Verify Python 3.12 ────────────────────────────────────
echo.
echo [CHECK] Python 3.12...
py -3.12 --version >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Python 3.12 not found.
  echo   Install: winget install Python.Python.3.12
  echo   Then:    py -3.12 -m pip install -r backend\requirements.txt pyinstaller
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('py -3.12 --version 2^>^&1') do echo   Found: %%v

:: ── Verify Python 3.13 ────────────────────────────────────
echo.
echo [CHECK] Python 3.13...
py -3.13 --version >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Python 3.13 not found.
  echo   Install: winget install Python.Python.3.13
  echo   Then:    py -3.13 -m pip install pymobiledevice3 pytun-pmd3 pyinstaller
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('py -3.13 --version 2^>^&1') do echo   Found: %%v

:: ── Verify Node.js ─────────────────────────────────────────
echo.
echo [CHECK] Node.js...
node --version >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js not found.
  echo   Install: winget install OpenJS.NodeJS
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Found: %%v

:: ── Verify PyInstaller is installed for both pythons ──────
py -3.12 -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] PyInstaller not found for Python 3.12.
  echo   Run: py -3.12 -m pip install pyinstaller
  pause & exit /b 1
)
py -3.13 -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] PyInstaller not found for Python 3.13.
  echo   Run: py -3.13 -m pip install pyinstaller
  pause & exit /b 1
)

mkdir "%DIST_PY%" 2>nul
mkdir "%BUILD_PY%" 2>nul

:: ──────────────────────────────────────────────────────────
echo.
echo ============================================================
echo  [1/4] Build backend  (Python 3.12  -^>  PyInstaller)
echo ============================================================
cd /d "%ROOT%\backend"
py -3.12 -m PyInstaller locwarp-backend.spec ^
  --noconfirm ^
  --distpath "%DIST_PY%" ^
  --workpath "%BUILD_PY%\backend"
if errorlevel 1 (
  echo.
  echo [ERROR] Backend build failed.
  echo   Check above for PyInstaller errors.
  echo   Common fix: py -3.12 -m pip install -r requirements.txt --upgrade
  pause & exit /b 1
)
echo   [OK] locwarp-backend ^-^> %DIST_PY%\locwarp-backend\

:: ──────────────────────────────────────────────────────────
echo.
echo ============================================================
echo  [2/4] Build WiFi tunnel  (Python 3.13  -^>  PyInstaller)
echo ============================================================
cd /d "%ROOT%"
py -3.13 -m PyInstaller wifi-tunnel.spec ^
  --noconfirm ^
  --distpath "%DIST_PY%" ^
  --workpath "%BUILD_PY%\tunnel"
if errorlevel 1 (
  echo.
  echo [ERROR] WiFi tunnel build failed.
  echo   Common fix: py -3.13 -m pip install pymobiledevice3 pytun-pmd3 --upgrade
  pause & exit /b 1
)
echo   [OK] wifi-tunnel ^-^> %DIST_PY%\wifi-tunnel\

:: ──────────────────────────────────────────────────────────
echo.
echo ============================================================
echo  [3/4] Build frontend  (Vite)
echo ============================================================
cd /d "%ROOT%\frontend"
if not exist node_modules (
  echo   Installing npm packages...
  call npm install
  if errorlevel 1 (echo [ERROR] npm install failed & pause & exit /b 1)
)
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Frontend Vite build failed.
  pause & exit /b 1
)
echo   [OK] frontend ^-^> frontend\dist\

:: ──────────────────────────────────────────────────────────
echo.
echo ============================================================
echo  [4/4] Package Electron installer  (NSIS)
echo ============================================================
call npx electron-builder --win nsis
if errorlevel 1 (
  echo.
  echo [ERROR] electron-builder failed.
  echo   Make sure electron-builder is installed: npm install -D electron-builder
  pause & exit /b 1
)

:: ──────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   DONE!  Installer is in frontend\release\
echo ============================================================
echo.
dir /b "%ROOT%\frontend\release\*.exe" 2>nul
echo.
echo   Double-click the .exe (Run as Administrator) to install.
echo.
pause
endlocal
