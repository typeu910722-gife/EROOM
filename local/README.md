# E·ROOM 本機版

資料庫放在這台電腦（SQLite），網站、Grok 網址、LINE 群組自動登記、每天 10:30／10:50 排程都由這台電腦處理，不再用 Cloudflare D1，也就不會被其他專案吃掉每日讀取額度。

程式和雲端版是同一份（`public/`、`functions/api/[[path]].js`），改功能時兩邊一起更新。

## 第一次安裝（約 10 分鐘）
1. 安裝 **Node.js 24 LTS**：https://nodejs.org （一直按下一步）
2. 下載 E·ROOM：https://github.com/typeu910722-gife/EROOM/archive/refs/heads/main.zip ，解壓縮到例如 `C:\EROOM`
3. 進 `local` 資料夾，點 **匯入雲端資料.bat**，輸入管理員密碼 → 把雲端的資料搬過來
4. 點 **啟動.bat** → 打開 http://localhost:8787 確認看得到房況
5. （建議）右鍵「以系統管理員身分執行」**開機自動啟動.bat** → 以後開機就自動跑

## 讓手機和 LINE 連得到（Cloudflare Tunnel）
員工手機和 LINE 要透過網址連到這台電腦，用 Cloudflare Tunnel（免費、不用開防火牆）：
- 跟 Claude 說「E·ROOM 本機版裝好了，幫我接 Tunnel」，Claude 會在 Cloudflare 建好通道，給你一行指令在這台電腦執行
- 接好後 `eroom.yzprojecttw.com` 會改連到這台電腦；雲端的 eroom-cron 排程要停用（避免重複推播），雲端資料保留當備援

## 其他
- 資料檔：`local\data\eroom.db`；每天自動備份到 `local\backups\`（保留 30 份）
- AI 解析群組回報（選用）：把 `config.example.json` 複製成 `config.json`，填 Cloudflare 帳號 ID 和 Workers AI 的 API Token；沒填就用關鍵字規則
- 這台電腦要一直開機、連網，`啟動.bat` 的視窗不要關（關掉就停了）；當機會自動重啟
- 更新程式：重新下載 zip 覆蓋（`local\data`、`local\backups`、`local\config.json` 不要刪）
