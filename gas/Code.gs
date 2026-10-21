/**
 * E·ROOM → Google 試算表同步
 * 裝在「旅宿不貳家」試算表的 Apps Script。
 * 第一次：執行 setup()，授權後會每 15 分鐘自動同步一次。
 * 試算表上方選單「E·ROOM → 立即同步」可手動同步。
 *
 * 同步金鑰存在「專案設定 → 指令碼屬性」的 SYNC_KEY，不寫在程式碼裡。
 */
const BASE = 'https://eroom-app.pages.dev';
const DAYS_BACK = 35;   // 每次同步最近幾天
const DAYS_AHEAD = 7;
const PROP_NAME = { ersu: '貳宿', eryanglou: '貳洋樓' };
const KIND_NAME = { '退房': '退房', '退入': '退房→入住', '續住': '續住', '入住': '入住', '': '' };
const STATUS_NAME = { todo: '要掃', done: '掃好了', '': '不用掃' };

function onOpen() {
  SpreadsheetApp.getUi().createMenu('E·ROOM').addItem('立即同步', 'sync').addToUi();
}

function setup() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'sync').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(15).create();
  sync();
}

function ymd(d) { return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd'); }
function ts(ms) { return ms ? Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'yyyy-MM-dd HH:mm') : ''; }

function sync() {
  const key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!key) throw new Error('請到「專案設定 → 指令碼屬性」新增 SYNC_KEY');
  const now = new Date();
  const from = ymd(new Date(now.getTime() - DAYS_BACK * 864e5));
  const to = ymd(new Date(now.getTime() + DAYS_AHEAD * 864e5));
  const res = UrlFetchApp.fetch(BASE + '/api/export?from=' + from + '&to=' + to, { headers: { 'x-sync-key': key }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('E·ROOM 回應 ' + res.getResponseCode() + '：' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.getActive();

  // ---- 房務紀錄：以「日期|館別|房號」為鍵，更新或新增，舊資料保留 ----
  const RH = ['日期', '館別', '房號', '狀況', '打掃', '備註', '延後退房', '提早入住', '檢核完成', '完成時間', '最後更新'];
  const rs = sheet(ss, '房務紀錄', RH);
  const old = rs.getLastRow() > 1 ? rs.getRange(2, 1, rs.getLastRow() - 1, RH.length).getDisplayValues() : [];
  const map = new Map(old.map((r) => [r[0] + '|' + r[1] + '|' + r[2], r]));
  for (const r of data.records) {
    if (!r.kind && !r.status && !r.note) { map.delete(r.date + '|' + PROP_NAME[r.prop] + '|' + r.room); continue; }
    const row = [r.date, PROP_NAME[r.prop] || r.prop, String(r.room), KIND_NAME[r.kind || ''] || r.kind, r.kind === '入住' && !r.status ? '' : (STATUS_NAME[r.status || ''] || r.status),
      r.note || '', r.lateOut || '', r.earlyIn || '', (r.checks || []).length || '', ts(r.doneAt), ts(r.updatedAt || r.updated_at)];
    map.set(row[0] + '|' + row[1] + '|' + row[2], row);
  }
  const rows = [...map.values()].sort((a, b) => b[0].localeCompare(a[0]) || a[1].localeCompare(b[1]) || String(a[2]).localeCompare(String(b[2])));
  write(rs, RH, rows);

  // ---- 回報：以編號為鍵 ----
  const IH = ['編號', '回報時間', '館別', '房號', '類型', '說明', '缺品', '照片', '回報人', '狀態', '處理時間', '處理人'];
  const is = sheet(ss, '回報', IH);
  const oldI = is.getLastRow() > 1 ? is.getRange(2, 1, is.getLastRow() - 1, IH.length).getDisplayValues() : [];
  const imap = new Map(oldI.map((r) => [String(r[0]), r]));
  for (const i of data.issues) {
    imap.set(String(i.id), [i.id, ts(i.created_at), PROP_NAME[i.prop] || i.prop, i.room === 'PUBLIC' ? '公共' : i.room, i.type, i.text || '',
      (i.items || []).map((t) => t.name + '×' + t.qty).join('、'), (i.photoUrls || []).join('\n'), i.by || '',
      i.status === 'done' ? '處理好了' : '未處理', ts(i.resolved_at), i.resolved_by || '']);
  }
  write(is, IH, [...imap.values()].sort((a, b) => Number(b[0]) - Number(a[0])));

  // ---- 補貨清單：未處理的缺備品加總 ----
  const SH = ['品項', '數量', '房間'];
  const need = {};
  for (const i of data.issues.filter((x) => x.status === 'open' && x.type === '缺備品')) {
    for (const t of i.items || []) {
      const n = (need[t.name] = need[t.name] || { qty: 0, rooms: [] });
      n.qty += t.qty; n.rooms.push((PROP_NAME[i.prop] || i.prop) + ' ' + i.room);
    }
  }
  write(sheet(ss, '補貨清單', SH), SH, Object.keys(need).map((k) => [k, need[k].qty, [...new Set(need[k].rooms)].join('、')]));

  ss.getSheetByName('房務紀錄').getRange('M1').setValue('最後同步 ' + ts(Date.now()));
}

function sheet(ss, name, header) {
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    const first = ss.getSheets()[0];
    if (first.getName() === '工作表1' && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  s.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  s.setFrozenRows(1);
  return s;
}

function write(s, header, rows) {
  const n = s.getLastRow();
  if (n > 1) s.getRange(2, 1, n - 1, header.length).clearContent();
  if (rows.length) {
    s.getRange(2, 1, rows.length, header.length).setNumberFormat('@').setValues(rows.map((r) => r.map((v) => (v == null ? '' : String(v)))));
  }
}
