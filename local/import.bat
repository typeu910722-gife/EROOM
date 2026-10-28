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
node --no-warnings local\server.js import https://eroom-app.pages.dev
pause
