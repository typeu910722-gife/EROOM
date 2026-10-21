// E·ROOM API — Cloudflare Pages Functions + D1 (binding: DB)
// 相容舊版：GET /api/ping、/api/config?p=、/api/records?p=&d=
// 資料表：records(prop,date,room,data,updated_at)、config(prop,data,updated_at)、docs(k,data,updated_at)、settings(k,v)
// 原則：只做 upsert，不刪除舊資料。

const PROPS = ['ersu', 'eryanglou'];
const DOC_KEYS = ['handbook', 'stay', 'checkout', 'checklist', 'supplies', 'roominfo'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[0-9A-Za-z\-]{1,8}$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isAdmin(env, request) {
  const pw = request.headers.get('x-admin') || '';
  if (!pw) return false;
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k='admin_hash'").first();
  if (!row) return false;
  const [salt, hash] = row.v.split(':');
  return (await sha256(salt + pw)) === hash;
}

async function body(request) {
  try { return await request.json(); } catch { return null; }
}

function cleanRecord(d) {
  // 只保留已知欄位，避免亂塞
  const out = {};
  if (typeof d.kind === 'string') out.kind = d.kind.slice(0, 10);
  if (typeof d.status === 'string') out.status = d.status.slice(0, 10);
  if (typeof d.note === 'string') out.note = d.note.slice(0, 300);
  if (typeof d.lateOut === 'string') out.lateOut = d.lateOut.slice(0, 5);
  if (typeof d.earlyIn === 'string') out.earlyIn = d.earlyIn.slice(0, 5);
  if (typeof d.by === 'string') out.by = d.by.slice(0, 20);
  if (Array.isArray(d.checks)) out.checks = d.checks.filter((n) => Number.isInteger(n)).slice(0, 60);
  if (typeof d.doneAt === 'number') out.doneAt = d.doneAt;
  return out;
}

async function upsertRecord(env, p, d, room, patch, now) {
  const old = await env.DB.prepare('SELECT data FROM records WHERE prop=? AND date=? AND room=?').bind(p, d, room).first();
  const prev = old ? JSON.parse(old.data) : {};
  const next = { ...prev, ...cleanRecord(patch) };
  if (next.status === 'done' && prev.status !== 'done') next.doneAt = now;
  if (next.status !== 'done') delete next.doneAt;
  next.updatedAt = now;
  return env.DB.prepare(
    'INSERT INTO records (prop,date,room,data,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(prop,date,room) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
  ).bind(p, d, room, JSON.stringify(next), now);
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const url = new URL(request.url);
  const path = (params.path || []).join('/');
  const m = request.method;
  const p = url.searchParams.get('p');

  try {
    if (path === 'ping') return json({ ok: true });

    if (path === 'admin' && m === 'POST') {
      return (await isAdmin(env, request)) ? json({ ok: true }) : bad('密碼錯誤', 401);
    }

    // ---- 房號設定 ----
    if (path === 'config') {
      if (m === 'GET') {
        if (!PROPS.includes(p)) return bad('館別錯誤');
        const row = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(p).first();
        return json({ config: row ? JSON.parse(row.data) : { rooms: [] } });
      }
      if (m === 'PUT' || m === 'POST') {
        if (!(await isAdmin(env, request))) return bad('需要管理員密碼', 401);
        const b = await body(request);
        if (!b || !PROPS.includes(b.p)) return bad('館別錯誤');
        const rooms = [...new Set((b.config?.rooms || []).map(String).filter((r) => ROOM_RE.test(r)))];
        await env.DB.prepare('INSERT INTO config (prop,data,updated_at) VALUES (?,?,?) ON CONFLICT(prop) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
          .bind(b.p, JSON.stringify({ rooms }), Date.now()).run();
        return json({ ok: true, config: { rooms } });
      }
    }

    // ---- 每日房務 ----
    if (path === 'records') {
      if (m === 'GET') {
        const d = url.searchParams.get('d');
        if (!PROPS.includes(p) || !DATE_RE.test(d || '')) return bad('參數錯誤');
        const { results } = await env.DB.prepare('SELECT room,data FROM records WHERE prop=? AND date=?').bind(p, d).all();
        const records = {};
        for (const r of results) records[r.room] = JSON.parse(r.data);
        return json({ records });
      }
      if (m === 'PUT' || m === 'POST') {
        // 單筆 {p,d,room,data} 或批次 {p,d,items:[{room,data}]}
        const b = await body(request);
        if (!b || !PROPS.includes(b.p) || !DATE_RE.test(b.d || '')) return bad('參數錯誤');
        const items = Array.isArray(b.items) ? b.items : [{ room: b.room, data: b.data }];
        const now = Date.now();
        const stmts = [];
        for (const it of items.slice(0, 80)) {
          const room = String(it.room || '');
          if (!ROOM_RE.test(room) || !it.data || typeof it.data !== 'object') continue;
          stmts.push(await upsertRecord(env, b.p, b.d, room, it.data, now));
        }
        if (!stmts.length) return bad('沒有可儲存的資料');
        await env.DB.batch(stmts);
        return json({ ok: true, saved: stmts.length, updatedAt: now });
      }
    }

    // 某日期區間的統計（給「紀錄」用）
    if (path === 'summary' && m === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return bad('參數錯誤');
      const { results } = await env.DB.prepare(
        "SELECT prop,date,json_extract(data,'$.kind') kind,json_extract(data,'$.status') status,count(*) n FROM records WHERE date BETWEEN ? AND ? GROUP BY prop,date,kind,status"
      ).bind(from, to).all();
      return json({ rows: results });
    }

    // ---- 手冊、備品、房間資料 ----
    if (path === 'docs') {
      if (m === 'GET') {
        const { results } = await env.DB.prepare('SELECT k,data,updated_at FROM docs').all();
        const docs = {};
        for (const r of results) docs[r.k] = { ...JSON.parse(r.data), updatedAt: r.updated_at };
        return json({ docs });
      }
      if (m === 'PUT' || m === 'POST') {
        if (!(await isAdmin(env, request))) return bad('需要管理員密碼', 401);
        const b = await body(request);
        if (!b || !DOC_KEYS.includes(b.k) || typeof b.data !== 'object') return bad('參數錯誤');
        const s = JSON.stringify(b.data);
        if (s.length > 60000) return bad('內容太長');
        await env.DB.prepare('INSERT INTO docs (k,data,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
          .bind(b.k, s, Date.now()).run();
        return json({ ok: true });
      }
    }

    return bad('找不到', 404);
  } catch (e) {
    return bad('伺服器錯誤：' + (e && e.message ? e.message : e), 500);
  }
}
