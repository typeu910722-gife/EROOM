# 進度紀錄

## 第一輪（2026-10-21）
- [x] 舊站原始碼找不到（直接上傳部署、未連 GitHub），改為重寫；沿用同一個 D1，舊資料 560 筆不動
- [x] 動工前備份 records（存在工作環境，未放進公開 repo）
- [x] 新增 docs、settings 資料表；管理員密碼雜湊存 D1
- [x] 今日：快速標記（選標記連點房號）、貼上文字批次輸入、復原、檢核表、延後退房／提早入住、備註、離線排隊重送
- [x] 手冊（員工守則／續住整理／退房整理／檢核清單）、備品、房間資料；管理員可在網頁編輯
- [x] 拿掉 CSV 匯出
- [x] 新 Pages 專案 eroom-app（連 GitHub main 自動部署，D1 綁同一個 eroom），預覽 https://eroom-app.pages.dev 已讀到正式資料
- [ ] 等確認後把 eroom.yzprojecttw.com 從舊專案 eroom 轉到 eroom-app（舊專案保留當備援）

## 第二輪（2026-10-21）
- [x] 回報分頁：故障／缺備品／遺留物／清潔／其他，可附 3 張照片（前端壓縮，存 D1 photos 表；R2 未開通）
- [x] 缺備品依房型勾選數量，備品頁頂端自動彙整補貨清單；處理好了就扣掉
- [x] 房號門牌顯示 ⚠️、今日頁顯示待處理數、底部分頁紅點
- [x] /api/export（需 settings.sync_key）＋ gas/Code.gs：每 15 分鐘同步到「旅宿不貳家」試算表（房務紀錄、回報、補貨清單）
- [x] 試算表已裝 Apps Script（金鑰放在試算表那份程式裡，repo 版不含金鑰）
- [ ] 使用者在 Apps Script 按「執行 setup」並授權

## 待辦
- 推上線：eroom.yzprojecttw.com 轉到 eroom-app
- 每天早上把要掃的房間推送到 LINE
