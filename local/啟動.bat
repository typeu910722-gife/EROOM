@echo off
chcp 65001 >nul
title E·ROOM 本機版
cd /d "%~dp0.."
where node >nul 2>nul || (echo 找不到 Node.js，請先安裝 Node.js 24 LTS：https://nodejs.org & pause & exit /b)
node -e "process.exit(+process.versions.node.split('.')[0]>=22?0:1)" || (echo Node.js 版本太舊，請安裝 24 LTS：https://nodejs.org & pause & exit /b)
:loop
node --no-warnings local\server.js
echo 伺服器停止了，5 秒後自動重啟⋯（要關閉請直接關掉這個視窗）
timeout /t 5 >nul
goto loop
