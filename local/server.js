// E·ROOM 本機版
// 用法（Windows 直接點 啟動.bat）：
//   node local/server.js                 啟動網站（預設 http://localhost:8787）
//   node local/server.js import <網址> <管理員密碼>   從雲端版搬資料進來
// 同一份程式（functions/api/[[path]].js、public/）同時給雲端版和本機版用；
// 本機版用 Node 內建 SQLite 取代 Cloudflare D1，資料檔在 local/data/eroom.db。

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUBLIC = join(ROOT, 'public');
const DATA = join(HERE, 'data');
const BACKUP = join(HERE, 'backups');
mkdirSync(DATA, { recursive: true });
mkdirSync(BACKUP, { recursive: true });

// ---------- 設定 ----------
const CFG_PATH = join(HERE, 'config.json');
const CFG = { port: 8787, cfAccountId: '', cfApiToken: '', keepBackups: 30, ...(existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {}) };
const DB_PATH = join(DATA, 'eroom.db');

// ---------- SQLite（模擬 D1 介面）----------
const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
sqlite.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8').split('\n').filter((l) => !/^\s*ALTER TABLE/i.test(l)).join('\n'));
// schema.sql 裡的 ALTER（新增欄位）逐條試，已經有就略過
for (const l of readFileSync(join(ROOT, 'schema.sql'), 'utf8').split('\n')) if (/^\s*ALTER TABLE/i.test(l)) { try { sqlite.exec(l); } catch {} }
for (const sql of [
  'CREATE INDEX IF NOT EXISTS records_date ON records(date)',
]) sqlite.exec(sql);

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a.map(norm)); }
  _p() { return sqlite.prepare(this.sql); }
  async first(col) { const r = this._p().get(...this.args); return r === undefined ? null : col ? r[col] : { ...r }; }
  async all() { return { results: this._p().all(...this.args).map((r) => ({ ...r })), success: true, meta: {} }; }
  async run() { const r = this._p().run(...this.args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  _runSync() { const p = this._p(); return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: p.all(...this.args) } : (p.run(...this.args), { success: true }); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec('BEGIN');
    try { const out = stmts.map((s) => s._runSync()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
  async exec(sql) { sqlite.exec(sql); return { count: 1 }; },
};

// ---------- Workers AI（選用：config.json 填 cfAccountId、cfApiToken 才會用）----------
const AI = CFG.cfAccountId && CFG.cfApiToken ? {
  async run(model, input) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CFG.cfAccountId}/ai/run/${model}`, { method: 'POST', headers: { authorization: 'Bearer ' + CFG.cfApiToken, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const j = await r.json();
    if (!j.success) throw new Error('Workers AI：' + JSON.stringify(j.errors));
    return j.result;
  },
} : undefined;

const env = { DB, AI, LOCAL: true };

// ---------- 載入 API 程式（跟雲端同一份）----------
const apiSrc = join(ROOT, 'functions', 'api', '[[path]].js');
const apiCopy = join(DATA, '.api.mjs');
writeFileSync(apiCopy, readFileSync(apiSrc));
const { onRequest } = await import(pathToFileURL(apiCopy).href + '?v=' + Date.now());

async function callApi(request, path) {
  const pending = [];
  const ctx = { request, env, params: { path: path.split('/').filter(Boolean) }, waitUntil: (p) => pending.push(p), next: () => new Response('', { status: 404 }) };
  const res = await onRequest(ctx);
  Promise.allSettled(pending);
  return res;
}

// ---------- 匯入：從雲端版搬資料 ----------
if (process.argv[2] === 'import') {
  const base = (process.argv[3] || '').replace(/\/$/, ''), pw = process.argv[4] || '';
  if (!base || !pw) { console.log('用法：node local/server.js import https://eroom-app.pages.dev 管理員密碼'); process.exit(1); }
  const r = await fetch(base + '/api/dump', { headers: { 'x-admin': pw } });
  if (!r.ok) { console.log('匯出失敗：', r.status, await r.text()); process.exit(1); }
  const { tables } = await r.json();
  backup('before-import');
  sqlite.exec('BEGIN');
  let n = 0;
  for (const [t, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      sqlite.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => norm(row[c])));
      n++;
    }
    console.log(`  ${t}：${rows.length} 筆`);
  }
  sqlite.exec('COMMIT');
  console.log(`完成，共匯入 ${n} 筆。現在可以用 啟動.bat 啟動。`);
  process.exit(0);
}

// ---------- 靜態檔 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  let p = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (!p || p.endsWith('/') || p.endsWith('\\')) p = join(p, 'index.html');
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) {
    const idx = join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    return res.end(readFileSync(idx));
  }
  const ext = extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  res.end(readFileSync(file));
}

// ---------- HTTP ----------
const server = createServer(async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto'] || (req.headers['cf-visitor'] ? 'https' : 'http');
    const url = new URL(req.url, `${proto}://${host}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const r = await callApi(request, url.pathname.slice(5));
    const out = Buffer.from(await r.arrayBuffer());
    const h = {}; r.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(r.status, h);
    res.end(out);
  } catch (e) {
    console.error(new Date().toISOString(), e);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '本機伺服器錯誤：' + e.message }));
  }
});

// ---------- 排程：10:30 未登記提醒、10:50 傳今日打掃（台灣時間）----------
const twNow = () => new Date(Date.now() + 8 * 3600e3);
let lastFire = '';
async function tick() {
  const t = twNow(); const hm = t.toISOString().slice(11, 16); const day = t.toISOString().slice(0, 10);
  const job = hm === '10:30' ? 'check' : hm === '10:50' ? 'daily' : null;
  if (!job || lastFire === day + job) return;
  lastFire = day + job;
  const key = (await DB.prepare("SELECT v FROM settings WHERE k='cron_key'").first())?.v;
  if (!key) return console.log('排程略過：還沒有 cron_key（先匯入雲端資料）');
  const r = await callApi(new Request('http://localhost/api/line/' + job, { method: 'POST', headers: { 'x-cron-key': key } }), 'line/' + job);
  console.log(new Date().toISOString(), '排程', job, r.status, await r.text());
}
setInterval(() => tick().catch((e) => console.error('排程錯誤', e)), 20000);

// ---------- 每天自動備份（保留 keepBackups 份）----------
function backup(tag) {
  const name = `eroom-${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)}${tag ? '-' + tag : ''}.db`;
  try { sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  copyFileSync(DB_PATH, join(BACKUP, name));
  const files = readdirSync(BACKUP).filter((f) => /^eroom-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  while (files.length > CFG.keepBackups) unlinkSync(join(BACKUP, files.shift()));
}
let lastBackup = '';
setInterval(() => { const d = twNow().toISOString().slice(0, 10); if (d !== lastBackup && twNow().getUTCHours() >= 4) { lastBackup = d; try { backup(); console.log('已備份', d); } catch (e) { console.error('備份失敗', e); } } }, 60000);

server.listen(CFG.port, () => {
  console.log(`E·ROOM 本機版已啟動：http://localhost:${CFG.port}`);
  console.log(`資料檔：${DB_PATH}`);
  console.log(`AI 解析：${AI ? '開（Workers AI）' : '關（用關鍵字規則；要開請在 local/config.json 填 cfAccountId、cfApiToken）'}`);
  console.log('這個視窗不要關。');
});
