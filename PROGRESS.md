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

## 本機版（2026-10-27）
- 原因：Cloudflare 帳號 D1 每日 500 萬讀取被 OCTA（ebot DB，10/27 約 643 萬）吃光，E·ROOM 跟著停擺
- [x] local/server.js：Node 內建 SQLite 模擬 D1 介面，直接跑同一份 functions/api/[[path]].js 與 public/；排程 10:30 check、10:50 daily；每日備份；選用 Workers AI（REST）
- [x] /api/dump（管理員）+ `server.js import`：從雲端搬資料
- [x] Windows：start.bat（自動重啟）、import.bat、autostart.bat（bat 只用英文，中文 bat 在 cmd 會亂碼；必須先解壓縮）
- [x] 2026-10-28 切換完成：本機在使用者筆電 E:\哲\EROOM-main\EROOM-main\local；Tunnel eroom-local（ca22fb4e-…）路由 eroom.yzprojecttw.com、eroom-pc.yzprojecttw.com → http://localhost:8787；Pages eroom-app 已拿掉自訂網域（雲端版保留在 eroom-app.pages.dev，資料停在 10/28）
- [x] Apps Script 同步網址改成 eroom.yzprojecttw.com
- [ ] eroom-cron 的兩個 Cron 待使用者刪除（不刪的話雲端會用舊資料在 10:30／10:50 誤發提醒）

## 桌面版（2026-10-28）
- [x] desktop/：Electron 44 + sql.js（同 OCTA 做法），core.mjs 跑同一份 API/網站；YZ 進度條、系統匣、開機自動啟動（--hidden）、electron-updater（GitHub Releases）
- [x] 第一次開啟偵測舊本機版佔用 8787 → 輸入密碼從舊版 /api/dump 搬資料 → 等舊版關閉自動接手；自動嘗試刪除舊開機排程 EROOM
- [x] .github/workflows/desktop.yml：push main 改到 public/functions/desktop 就自動打包 v1.0.<run_number> 發布
- [x] 本機 xvfb 測試：搬資料 584 筆、舊版關閉後接手 8787、網站正常
- [ ] 使用者安裝 EROOM-Setup.exe、搬資料、關掉舊 start.bat

## 評論／早餐（2026-10-28）
- [x] 貳宿、貳洋樓拿掉「紀錄」分頁（資料保留）
- [x] /api/sheet?p=erlu&tab=評論|早餐：伺服器讀 Google 試算表 gviz CSV（快取 2 分鐘，fresh=1 強制），試算表網址用 docs.breakfast[p].url，沒設定用預設 1RxePc9d…（「旅宿不貳家 OCTA」表）
- [x] 貳侶分頁：清理／故障／早餐／評論／報表。資料在表上填，網站只讀；依欄位標題找欄（換表也能用）
- [x] 早餐：依日期切換、A／B／外帶分組、待確認（沒回覆/沒點）、需改餐/壽星標記、備料與飲料統計、+50 加價合計；清理頁上方今日早餐摘要
- [x] 評論：期間（近30天/本月/上個月/全部）、來源/好壞/問題篩選、平台平均、問題排行；報表加評論區（好評率圓餅、平均、負評、問題排行）
- 使用者決定：只放貳侶、表上填（可能換表）、先不做 LINE 自動登記、員工都能看

- [x] 貳宿也有「評論」分頁（試算表網址管理員在評論頁「換試算表」設定，存 docs.breakfast.ersu；報表下方加評論區）

## 細清（2026-10-29，貳宿、貳侶）
- [x] 提醒只算做過的房間（還沒做過的不提醒）；頻率選項：一個月／兩個月／三個月／半年；到期前提醒天數：貳侶 14 天、貳宿 7 天（另加當天要掃 < 11 間）
- [x] 表 deep_tasks、deep_logs；API /api/deep、/api/deep/task（管理員）、/api/deep/log（員工送出、管理員合格/需重做/刪除）
- [x] 預設細清項：乾濕分離濕區全細清（每月；10 項內容、6 條標準、5 張必拍）
- [x] 每間房：上次、到期（上次＋N 個月）、該做了/7 天內到期/已完成/需重做
- [x] 10:50 每日推播同一則 push 加第二則「細清提醒」：有該做/快到期，或當天要掃 < 11 間就發；列出今晚空房可做的房間＋連結 ?p=ersu&deep=ID
- [x] 貳侶「清理」分頁改成細清（預設「冷氣濾網清潔」每月、4 張必拍）；貳侶每日推播關閉時細清提醒仍單獨傳（line_deep_<p> 一天一次），貳侶不判斷「少於 11 間」與空房
- [x] 前端「細清」分頁（貳宿、貳侶）：房間表、內容/標準、細清內容只顯示不用打勾、分項拍照可從相簿選（自動壓縮）、細清人員、紀錄與管理員檢查

## 待辦
- 每天早上把要掃的房間推送到 LINE
