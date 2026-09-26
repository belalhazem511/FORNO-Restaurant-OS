@echo off
setlocal
set "PORTABLE=%~dp0SOLO-Portable-x64.exe"
if exist "%PORTABLE%" (
  start "SOLO Restaurant OS" "%PORTABLE%"
  exit /b 0
)
set "INSTALLED=%LOCALAPPDATA%\Programs\SOLO Restaurant OS\SOLO Restaurant OS.exe"
if exist "%INSTALLED%" (
  start "SOLO Restaurant OS" "%INSTALLED%"
  exit /b 0
)
echo SOLO is not installed and the portable executable is not beside this script.
echo Run SOLO-Setup-x64.exe or place SOLO-Portable-x64.exe in this folder.
exit /b 1
