@echo off
chcp 65001 >nul
schtasks /create /tn "EROOM 本機版" /tr "\"%~dp0啟動.bat\"" /sc onlogon /rl highest /f
if errorlevel 1 (echo 設定失敗，請按右鍵「以系統管理員身分執行」這個檔案) else (echo 完成：以後這台電腦登入 Windows 就會自動啟動 E·ROOM。)
pause
