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
- [x] ~~回報分頁~~（10/21 依需求移除；後端 /api/issues 與資料保留）
- [x] ~~缺備品勾選、補貨清單~~（10/21 依需求移除備品區，缺備品改用文字描述）
- [x] 房號門牌顯示 ⚠️、今日頁顯示待處理數、底部分頁紅點
- [x] /api/export（需 settings.sync_key）＋ gas/Code.gs：每 15 分鐘同步到「旅宿不貳家」試算表（房務紀錄、回報、補貨清單）
- [x] 試算表已裝 Apps Script（金鑰放在試算表那份程式裡，repo 版不含金鑰）
- [ ] 使用者在 Apps Script 按「執行 setup」並授權

## 第三輪（2026-10-21）
- [x] /api/report?month=：各館、各房的退房／退→入／續住掃／入住／要掃／掃好／平均掃好時間；每日要掃 vs 掃好；回報類型、未處理、平均處理時數
- [x] 底部「報表」分頁：月報表＋房間資料兩個子分頁

## 調整（2026-10-21）
- [x] 拿掉「掃好了」：網站以查看為主，員工照舊在 LINE 回報房況；房號只剩要掃／不用掃，檢核改成步驟清單；報表拿掉完成率與完成時間

## 上線（2026-10-21 11:25）
- [x] eroom.yzprojecttw.com 從舊專案 eroom 移到 eroom-app，DNS CNAME 改指 eroom-app.pages.dev；舊專案保留（eroom-7om.pages.dev）當備援
- 之後「推上線」＝ push 到 GitHub main，Cloudflare 自動部署

## LINE 推播（2026-10-21）
- [x] /api/line/webhook（驗簽；各館各自綁群組：群組傳「綁定貳宿」「綁定貳洋樓」，settings line_target_<館>；傳「房務」回該館清單）
- [x] /api/line/config、preview、test（管理員）；/api/line/daily（x-cron-key）
- [x] 報表 → LINE 設定（管理員才看得到）
- [x] cron/worker.js：Cloudflare Worker eroom-cron，每天 02:50 UTC 呼叫 daily
- [ ] 使用者建立新官方帳號、開 Messaging API、貼 secret／token、設 webhook、拉進群組

## 2026-10-22
- [x] /api/text/set 支援多天（每行日期開頭）
- [x] /api/text/book：訂房（房號＋入住日期區間）自動拆成每天入住／續住／退房，自動合併退房→入住，preview=1 預覽
- [x] 未登記提醒：私訊官方帳號「綁定管理員」→ settings.line_admin；10:30 /api/line/check 提醒；10:50 未登記的館不傳群組並通知管理員
- [x] eroom-cron 加 30 2 * * *
- 員工排班（第 7 項）不做在 E·ROOM，之後由「到班Go」做，並設計成可接各公司自有系統

## 2026-10-27
- [x] 文字 API 備註（房號後括號）
- [x] 新增第三館 貳侶（prop erlu；中間曾改名貳旅，10/27 確定叫貳侶），房號 101–115、201–217 共 28 間已設定
- [x] 「紀錄」分頁：冷氣清洗／冷氣維修／維修／房況／其他，大家可新增編輯刪除（軟刪除 deleted=1），冷氣總覽（每間最後清洗日，>90 天紅）
- [x] LINE：「綁定貳侶」；每館開關 line_push_<館>（預設 貳侶 關）、line_autolog_<館>（預設 貳侶 開）；群組訊息含維護關鍵字＋房號自動寫 logs 並回覆確認；收回訊息會刪除對應紀錄

- [x] 群組回報改用 Workers AI（llama-3.3-70b）解析：多間多件、2樓全部、口語日期，失敗退回關鍵字規則；logs.raw 存原文；/api/logs/parse 管理員測試

- [x] 貳侶只顯示：清理／故障（紀錄類別只有這兩種，AI 也只分這兩類）、早餐（嵌入 Google 試算表，管理員設定網址，docs.breakfast）、報表（紀錄報表：清理涵蓋率、清理／故障筆數、每天／每月、各房）
- [x] 奶油風主題：手機淺色模式自動套用（prefers-color-scheme: light），深色維持暗金
- [ ] 早餐試算表網址待使用者提供

## 本機版（2026-10-27）
- 原因：Cloudflare 帳號 D1 每日 500 萬讀取被 OCTA（ebot DB，10/27 約 643 萬）吃光，E·ROOM 跟著停擺
- [x] local/server.js：Node 內建 SQLite 模擬 D1 介面，直接跑同一份 functions/api/[[path]].js 與 public/；排程 10:30 check、10:50 daily；每日備份；選用 Workers AI（REST）
- [x] /api/dump（管理員）+ `server.js import`：從雲端搬資料
- [x] Windows：啟動.bat（自動重啟）、匯入雲端資料.bat、開機自動啟動.bat
- [ ] 使用者準備好電腦 → 建 Cloudflare Tunnel、eroom.yzprojecttw.com 改指 tunnel、停用 eroom-cron schedules、Grok/試算表網址確認

## 待辦
- 每天早上把要掃的房間推送到 LINE
