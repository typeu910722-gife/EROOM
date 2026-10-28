@echo off
cd /d "%~dp0.."
if not exist "local\server.js" (
  echo.
  echo ERROR: Please EXTRACT the ZIP first ^(right-click the ZIP ^> Extract All^), then run this file from the extracted folder.
  echo.
  pause
  exit /b
)
where node >nul 2>nul || (echo ERROR: Node.js not found. Install Node.js 24 LTS from https://nodejs.org & pause & exit /b)
:loop
node --no-warnings local\server.js
echo Server stopped. Restarting in 5 seconds... ^(close this window to stop^)
timeout /t 5 >nul
goto loop
