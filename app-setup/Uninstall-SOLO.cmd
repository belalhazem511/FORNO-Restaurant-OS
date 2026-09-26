@echo off
setlocal
set "UNINSTALLER=%LOCALAPPDATA%\Programs\SOLO Restaurant OS\Uninstall SOLO Restaurant OS.exe"
if not exist "%UNINSTALLER%" (
  echo SOLO's per-user uninstaller was not found. Use Windows Settings, Apps, Installed apps.
  exit /b 1
)
start "Uninstall SOLO" "%UNINSTALLER%"
