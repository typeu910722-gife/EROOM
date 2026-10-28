// E·ROOM 桌面版核心：本機網站伺服器 + SQLite（sql.js，模擬 Cloudflare D1）+ 排程 + 備份 + 搬資料
// 跟雲端版跑同一份 API（functions/api/[[path]].js → api.mjs）與網站（public → web）。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pick = (...ps) => ps.find((p) => existsSync(p));
const WEB = pick(join(here, 'web'), join(here, '..', 'public'));
const API = pick(join(here, 'api.mjs'), join(here, '..', 'functions', 'api', '[[path]].js'));
const SCHEMA = pick(join(here, 'schema.sql'), join(here, '..', 'schema.sql'));
export const VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
const TABLES = ['records', 'config', 'docs', 'settings', 'issues', 'photos', 'logs'];

// ---------- sql.js 包成 D1 的樣子 ----------
async function openDb(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => join(dirname(require.resolve('sql.js')), f) });
  const db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
  let timer = null, closed = false;
  const save = () => {
    clearTimeout(timer); timer = null;
    if (closed) return;
    const tmp = file + '.tmp';
    writeFileSync(tmp, Buffer.from(db.export()));
    renameSync(tmp, file);
  };
  const dirty = () => { if (!timer) timer = setTimeout(save, 1500); };
  const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, norm(a)); }
    _all() { const st = db.prepare(this.sql); st.bind(this.args); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; }
    _run() {
      db.run(this.sql, this.args);
      const changes = db.getRowsModified();
      const last = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] ?? 0;
      dirty();
      return { success: true, meta: { changes, last_row_id: last } };
    }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: this._all(), meta: {} } : { results: [], ...this._run() }; }
    async first(col) { const r = this._all()[0]; return r === undefined ? null : col ? r[col] : r; }
    async all() { return { results: this._all(), success: true, meta: {} }; }
    async run() { return this._run(); }
  }
  return {
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.run('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.run('COMMIT'); dirty(); return out; }
      catch (e) { db.run('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); dirty(); return { count: 1 }; },
    execSync(sql) { db.exec(sql); dirty(); },
    count(table) { try { return db.exec(`SELECT count(*) FROM ${table}`)[0].values[0][0]; } catch { return 0; } },
    insertRows(table, rows) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.run(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, norm(cols.map((c) => row[c])));
      }
      dirty();
    },
    save,
    close() { save(); closed = true; db.close(); },
  };
}

// ---------- 啟動 ----------
export async function startCore({ dataDir, port = 8787, log = console.log, onState = () => {} }) {
  mkdirSync(dataDir, { recursive: true });
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const dbFile = join(dataDir, 'eroom.db');
  const cfgFile = join(dataDir, 'config.json');
  const cfg = { keepBackups: 30, cfAccountId: '', cfApiToken: '', ...(existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {}) };

  const DB = await openDb(dbFile);
  const schema = readFileSync(SCHEMA, 'utf8').split('\n');
  DB.execSync(schema.filter((l) => !/^\s*ALTER TABLE/i.test(l)).join('\n'));
  for (const l of schema) if (/^\s*ALTER TABLE/i.test(l)) { try { DB.execSync(l); } catch {} }
  try { DB.execSync('CREATE INDEX IF NOT EXISTS records_date ON records(date)'); } catch {}

  const AI = cfg.cfAccountId && cfg.cfApiToken ? {
    async run(model, input) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/ai/run/${model}`, { method: 'POST', headers: { authorization: 'Bearer ' + cfg.cfApiToken, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const j = await r.json();
      if (!j.success) throw new Error('Workers AI：' + JSON.stringify(j.errors));
      return j.result;
    },
  } : undefined;
  const env = { DB, AI, LOCAL: true };
  const { onRequest } = await import(pathToFileURL(API).href);

  const callApi = async (request, path) => {
    const pending = [];
    const res = await onRequest({ request, env, params: { path: path.split('/').filter(Boolean) }, waitUntil: (p) => pending.push(p), next: () => new Response('', { status: 404 }) });
    Promise.allSettled(pending);
    return res;
  };

  // 靜態檔
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
  const serveStatic = (pathname, res) => {
    let p = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    if (!p) p = 'index.html';
    let file = join(WEB, p);
    if (!file.startsWith(WEB) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB, 'index.html');
    const ext = extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
    res.end(readFileSync(file));
  };

  let hits = 0;
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const proto = req.headers['x-forwarded-proto'] || (req.headers['cf-visitor'] ? 'https' : 'http');
      const url = new URL(req.url, `${proto}://${host}`);
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      hits++;
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const r = await callApi(request, url.pathname.slice(5));
      const out = Buffer.from(await r.arrayBuffer());
      const h = {}; r.headers.forEach((v, k) => (h[k] = v));
      res.writeHead(r.status, h); res.end(out);
    } catch (e) {
      log('錯誤 ' + (e && e.stack || e));
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '本機伺服器錯誤：' + e.message }));
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, ok); });
  log(`E·ROOM 已啟動 http://localhost:${port}（資料：${dbFile}）`);

  // 排程（台灣時間）
  const tw = () => new Date(Date.now() + 8 * 3600e3);
  let lastFire = '', lastBackup = '';
  const backup = (tag) => {
    DB.save();
    const name = `eroom-${tw().toISOString().slice(0, 10)}${tag ? '-' + tag : ''}.db`;
    copyFileSync(dbFile, join(backupDir, name));
    const files = readdirSync(backupDir).filter((f) => /^eroom-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (files.length > cfg.keepBackups) unlinkSync(join(backupDir, files.shift()));
    return name;
  };
  const timer = setInterval(async () => {
    try {
      const t = tw(), hm = t.toISOString().slice(11, 16), day = t.toISOString().slice(0, 10);
      if (day !== lastBackup && t.getUTCHours() >= 4) { lastBackup = day; backup(); log('已備份 ' + day); }
      const job = hm === '10:30' ? 'check' : hm === '10:50' ? 'daily' : null;
      if (!job || lastFire === day + job) return;
      lastFire = day + job;
      const key = (await DB.prepare("SELECT v FROM settings WHERE k='cron_key'").first())?.v;
      if (!key) return log('排程略過：還沒有資料（先搬資料）');
      const r = await callApi(new Request('http://localhost/api/line/' + job, { method: 'POST', headers: { 'x-cron-key': key } }), 'line/' + job);
      log(`排程 ${job}：${r.status} ${(await r.text()).slice(0, 200)}`);
    } catch (e) { log('排程錯誤 ' + e.message); }
  }, 20000);

  // 從別的 E·ROOM（舊的本機版或雲端版）搬資料
  const importFrom = async (base, pw) => {
    const r = await fetch(base.replace(/\/$/, '') + '/api/dump', { headers: { 'x-admin': pw } });
    if (r.status === 401) throw new Error('管理員密碼錯誤');
    if (!r.ok) throw new Error('讀取失敗：' + r.status);
    const { tables } = await r.json();
    try { backup('before-import'); } catch {}
    const counts = {};
    for (const t of TABLES) if (Array.isArray(tables[t])) { DB.insertRows(t, tables[t]); counts[t] = tables[t].length; }
    DB.save();
    onState();
    return counts;
  };

  return {
    port, dbFile, dataDir, backupDir,
    hasData: () => DB.count('records') > 0,
    stats: () => ({ records: DB.count('records'), logs: DB.count('logs'), hits }),
    importFrom,
    backupNow: () => backup('manual'),
    async stop() { clearInterval(timer); await new Promise((ok) => server.close(ok)); DB.close(); },
  };
}
