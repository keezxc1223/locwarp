@echo off
REM LocWarp — one-shot build: backend exe + tunnel exe + electron installer.
REM 使用 backend/venv 內的 Python 環境進行打包

setlocal enabledelayedexpansion
cd /d "%~dp0"
set ROOT=%cd%

REM 設定 venv 的 Python 路徑
set VENV_PYTHON="%ROOT%\backend\venv\Scripts\python.exe"

echo.
echo ============================================================
echo  [0/4] Checking Virtual Environment
echo ============================================================
if not exist %VENV_PYTHON% (
    echo [ERROR] 找不到虛擬環境: %VENV_PYTHON%
    echo 請先建立環境並安裝套件:
    echo cd backend ^&^& python -m venv venv
    exit /b 1
)
echo Using Python from: %VENV_PYTHON%

echo.
echo ============================================================
echo  [1/4] Build backend (Python from venv) with PyInstaller
echo ============================================================
cd /d "%ROOT%\backend"
%VENV_PYTHON% -m PyInstaller locwarp-backend.spec --noconfirm --distpath "%ROOT%\dist-py" --workpath "%ROOT%\build-py\backend"
if errorlevel 1 (echo backend build failed & exit /b 1)

echo.
echo ============================================================
echo  [2/4] Build wifi-tunnel (Python from venv) with PyInstaller
echo ============================================================
cd /d "%ROOT%"
%VENV_PYTHON% -m PyInstaller wifi-tunnel.spec --noconfirm --distpath "%ROOT%\dist-py" --workpath "%ROOT%\build-py\tunnel"
if errorlevel 1 (echo tunnel build failed & exit /b 1)

echo.
echo ============================================================
echo  [3/4] Build frontend (Vite)
echo ============================================================
cd /d "%ROOT%\frontend"
call npm install
call npm run build
if errorlevel 1 (echo frontend build failed & exit /b 1)

echo.
echo ============================================================
echo  [4/4] Package Electron installer (electron-builder)
echo ============================================================
cd /d "%ROOT%\frontend"
call npx electron-builder --win nsis
if errorlevel 1 (echo installer build failed & exit /b 1)

echo.
echo ============================================================
echo  DONE — installer is in frontend\release\
echo ============================================================
dir /b "%ROOT%\frontend\release\*.exe"
endlocal