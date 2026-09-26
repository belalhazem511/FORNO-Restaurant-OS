@echo off
setlocal
set "SETUP=%~dp0SOLO-Setup-x64.exe"
if not exist "%SETUP%" (
  echo Place SOLO-Setup-x64.exe beside this script to repair or upgrade SOLO.
  exit /b 1
)
start "SOLO Setup" "%SETUP%"
