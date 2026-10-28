# E·ROOM 桌面版（Windows）

這台電腦當 E·ROOM 的主機：網站（localhost:8787，經 Cloudflare Tunnel 接到 eroom.yzprojecttw.com）、資料庫、LINE 推播排程（10:30、10:50）、每日備份都在這台電腦。

- 安裝：https://github.com/typeu910722-gife/EROOM/releases/latest/download/EROOM-Setup.exe
- 第一次開：如果舊的本機版（start.bat）還開著，會自動帶你把資料搬過來，再關掉舊版就自動接手
- 關掉視窗＝縮到右下角繼續跑；右鍵圖示可看狀態、開機自動啟動、立即備份、打開資料夾、檢查更新、結束
- 資料：`%APPDATA%\EROOM\data\eroom.db`，備份在同資料夾的 `backups`（保留 30 份）
- 更新：網站或 API 改了推到 main，GitHub Actions 會自動打包發布（版本 1.0.<次數>），桌面版自動下載，右下角選單按「重新啟動以更新」
- AI 解析（選用）：在 data 資料夾放 `config.json`：`{"cfAccountId":"…","cfApiToken":"…"}`

開發：`npm install`、`npm start`（Electron）或 `npm run serve`（只跑核心，不開視窗）。
