# E·ROOM 房務

貳宿文旅、貳洋樓民宿共用的房務工作台。網址：https://eroom.yzprojecttw.com

- `public/`：前端（單一 index.html，手機優先，可加到主畫面）
- `functions/api/[[path]].js`：Cloudflare Pages Functions API
- D1 資料庫 `eroom`（binding `DB`），資料表見 `schema.sql`，**只新增、不刪除**

## API
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/ping` | 健康檢查 |
| GET | `/api/config?p=ersu\|eryanglou` | 房號 |
| PUT | `/api/config` | 修改房號（管理員） |
| GET | `/api/records?p=&d=YYYY-MM-DD` | 某天各房狀態 |
| POST | `/api/records` | `{p,d,room,data}` 或 `{p,d,items:[{room,data}]}`，合併更新 |
| GET | `/api/summary?from=&to=` | 區間統計 |
| GET/POST | `/api/text/set?k=金鑰&p=&d=&t=` | 純文字寫入（給 Grok）；可多天：每行用日期開頭「10/22 退房 201」；`mode=replace` 先清空那幾天該館；金鑰在 D1 settings.bot_key |
| GET/POST | `/api/text/book?k=金鑰&p=&t=` | 訂房自動拆成每天：每行「房號 10/22-24」（住 22–24 三晚、25 退房）；`preview=1` 只預覽 |
| GET | `/api/text?p=ersu\|eryanglou&from=&to=` | 純文字房況（給 Grok 讀，一次多天，最多 93 天；不帶 p 就兩館） |
| GET/PUT | `/api/docs` | 手冊、檢核、備品、房間資料（PUT 需管理員） |

管理員：header `x-admin: <密碼>`，雜湊存在 D1 `settings.admin_hash`，不放在程式碼裡。

## 資料格式
`records.data`：`kind`（退房／退入／續住／入住）、`status`（todo 要掃／done 掃好了／空字串 不用掃）、`note`、`lateOut`、`earlyIn`、`checks`、`doneAt`、`updatedAt`

網頁可直接開指定館別與日期：`/?p=ersu&d=2026-10-15`
