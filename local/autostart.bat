@echo off
if not exist "%~dp0server.js" (
  echo ERROR: Please EXTRACT the ZIP first, then run this file from the extracted folder.
  pause
  exit /b
)
schtasks /create /tn "EROOM" /tr "\"%~dp0start.bat\"" /sc onlogon /rl highest /f
if errorlevel 1 (echo FAILED: right-click this file and choose "Run as administrator".) else (echo OK: E-ROOM will start automatically when you log in to Windows.)
pause
