@echo off
:: Check admin
net session >nul 2>&1
if %errorlevel% == 0 (
    goto :RUN
)

:: Elevate using VBScript
echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\locwarp_elevate.vbs"
echo UAC.ShellExecute "%~f0", "", "%~dp0", "runas", 1 >> "%temp%\locwarp_elevate.vbs"
cscript //nologo "%temp%\locwarp_elevate.vbs"
del "%temp%\locwarp_elevate.vbs"
exit /b

:RUN
cd /d "%~dp0"
:: Use the full path to avoid the Windows Store python stub
"C:\Users\USER\AppData\Local\Programs\Python\Python313\python.exe" start.py
pause
