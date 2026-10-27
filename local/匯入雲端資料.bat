@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 從雲端版 E·ROOM 把資料搬到這台電腦（會先自動備份目前的本機資料）。
set /p PW=請輸入管理員密碼：
node --no-warnings local\server.js import https://eroom-app.pages.dev %PW%
pause
