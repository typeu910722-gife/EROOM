// E·ROOM API — Cloudflare Pages Functions + D1 (binding: DB)
// 相容舊版：GET /api/ping、/api/config?p=、/api/records?p=&d=
// 資料表：records(prop,date,room,data,updated_at)、config(prop,data,updated_at)、docs(k,data,updated_at)、settings(k,v)
// 原則：只做 upsert，不刪除舊資料。

const PROPS = ['ersu', 'eryanglou', 'erlu'];
const PNAME = { ersu: '貳宿', eryanglou: '貳洋樓', erlu: '貳旅' };
const DOC_KEYS = ['handbook', 'stay', 'checkout', 'checklist', 'supplies', 'roominfo'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[0-9A-Za-z\-]{1,8}$/;

const ISSUE_TYPES = ['故障', '缺備品', '遺留物', '清潔', '其他'];
const twDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const issueOut = (r) => ({ ...r, items: JSON.parse(r.items || '[]'), photos: JSON.parse(r.photos || '[]') });

const txt = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

// 文字解析：「標記 房號 房號 標記 房號」
const WORDS = [
  [/退房?\s*(→|->|接|轉)\s*入住?|退入|退房入住|退房接入住/, { kind: '退入', status: 'todo' }],
  [/續住?要?掃|續住/, { kind: '續住', status: 'todo' }],
  [/續住不用掃|續不掃/, { kind: '續住', status: '' }],
  [/退房?/, { kind: '退房', status: 'todo' }],
  [/入住?/, { kind: '入住', status: '' }],
  [/不用掃|免掃/, { status: '' }],
  [/清空|清除|取消|空房/, { kind: '', status: '', note: '' }],
];
// 文字裡的日期：10/22、2026/10/22、2026-10-22（年份省略＝今年；比今天早超過半年就當明年）
function toDate(y, mo, da) {
  const now = new Date(Date.now() + 8 * 3600e3);
  let yy = y ? +y : now.getUTCFullYear();
  if (!y && +mo < now.getUTCMonth() + 1 - 6) yy++;
  const d = new Date(Date.UTC(yy, +mo - 1, +da));
  if (d.getUTCMonth() !== +mo - 1) return null;
  return d.toISOString().slice(0, 10);
}
const addDay = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
// 依「日期開頭的行」切段：10/22 退房 201 ⏎ 10/23 續住 201
function splitByDate(text, defaultDate) {
  const segs = []; let cur = { d: defaultDate, t: '' };
  for (const ln of String(text).split(/\n|；|;/)) {
    const m = ln.match(/^\s*(?:(\d{4})[\/\-.])?(\d{1,2})[\/\-.](\d{1,2})(?:\s*[（(][^）)]*[）)])?\s*[:：]?\s*(.*)$/);
    const d = m && toDate(m[1], m[2], m[3]);
    if (d) { if (cur.t.trim()) segs.push(cur); cur = { d, t: m[4] || '' }; }
    else cur.t += ' ' + ln;
  }
  if (cur.t.trim()) segs.push(cur);
  return segs;
}

// 備註：房號後面加括號「502（12:00 退房）」；只改備註用「備註 502（…）」；「502（）」清掉備註
function parseText(text, rooms) {
  const set = new Map(rooms.map((r) => [r.toUpperCase(), r]));
  const notes = {};
  let i = 0;
  const src = String(text).replace(/([0-9A-Za-z]+)\s*[（(]([^）)]*)[）)]/g, (_, r, n) => { const k = '§' + i++; notes[k] = { r, n: n.trim() }; return ' ' + k + ' '; });
  const tokens = src.replace(/[，,、；;：:\n\/.。+＋]+/g, ' ').split(/\s+/).filter(Boolean);
  const items = [], unknown = [];
  let cur = null;
  for (const tk of tokens) {
    let num, note;
    if (/^§\d+$/.test(tk)) { num = notes[tk].r; note = notes[tk].n; }
    else {
      const mm = tk.match(/^([^\dA-Za-z]+)?([\dA-Za-z]+)?$/);
      const word = mm ? mm[1] : tk; num = mm ? mm[2] : null;
      if (word) {
        if (/備註|註記|備注/.test(word)) cur = { __noteOnly: true };
        else { const order = [WORDS[2], WORDS[0], WORDS[1], WORDS[3], WORDS[4], WORDS[5], WORDS[6]]; const w = order.find(([re]) => re.test(word)); if (w) cur = w[1]; }
      }
    }
    if (!num || (!cur && note === undefined)) continue;
    const r = set.get(num.toUpperCase());
    if (!r) { unknown.push(num); continue; }
    const data = cur && !cur.__noteOnly ? { ...cur } : {};
    if (note !== undefined) data.note = note;
    if (!Object.keys(data).length) continue;
    items.push({ room: r, data });
  }
  return { items, unknown };
}

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

    // ---- 純文字寫入（給 Grok 用網址登記房況）----
    // GET/POST /api/text/set?k=金鑰&p=ersu&d=2026-10-21&t=退房 201 203 退入 305 續住 501 入住 306
    // mode=replace：先把那天那館清空再寫；預設只改有寫到的房間
    if (path === 'text/set' && (m === 'GET' || m === 'POST')) {
      const key = await env.DB.prepare("SELECT v FROM settings WHERE k='bot_key'").first();
      if (!key || url.searchParams.get('k') !== key.v) return txt('金鑰錯誤', 401);
      const pp = url.searchParams.get('p');
      const d0 = url.searchParams.get('d') || twDate(Date.now());
      let t = url.searchParams.get('t') || '';
      if (m === 'POST') t = (await request.text()) || t;
      if (!PROPS.includes(pp)) return txt('p 要填 ersu（貳宿）、eryanglou（貳洋樓）或 erlu（貳旅）', 400);
      if (!DATE_RE.test(d0)) return txt('d 日期格式要像 2026-10-21', 400);
      const cfg = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(pp).first();
      const rooms = cfg ? JSON.parse(cfg.data).rooms || [] : [];
      const replace = url.searchParams.get('mode') === 'replace';
      const segs = splitByDate(t, d0);
      if (segs.length > 31) return txt('一次最多登記 31 天', 400);
      const now = Date.now();
      const stmts = [], out = [], allUnknown = [];
      for (const sg of segs) {
        const { items, unknown } = parseText(sg.t, rooms);
        allUnknown.push(...unknown);
        if (!items.length && !replace) continue;
        if (replace) { const touched = new Set(items.map((i) => i.room)); for (const r of rooms) if (!touched.has(r)) stmts.push(await upsertRecord(env, pp, sg.d, r, { kind: '', status: '', note: '' }, now)); }
        for (const it of items) stmts.push(await upsertRecord(env, pp, sg.d, it.room, it.data, now));
        const lbl = (d) => d.kind === '續住' ? (d.status ? '續住要掃' : '續住不用掃') : d.kind ? ({ '退入': '退房→入住' })[d.kind] || d.kind : 'kind' in d ? '清空' : 'status' in d ? '不用掃' : '';
        out.push(`${sg.d}：${items.map((i) => [i.room, lbl(i.data)].filter(Boolean).join(' ') + ('note' in i.data && !('kind' in i.data && !i.data.kind) ? (i.data.note ? `（備註：${i.data.note}）` : '（清掉備註）') : '')).join('、') || '（清空）'}`);
      }
      if (!out.length) return txt('沒有辨識到房號。寫法例如：退房 201 203 退入 305 續住 501 入住 306\n多天：每一行用日期開頭，例如「10/22 退房 201」\n備註：房號後加括號，例如「退房 502（12:00 退房）」，只改備註用「備註 502（…）」' + (allUnknown.length ? `\n不認得的房號：${allUnknown.join('、')}` : ''), 400);
      if (stmts.length) await env.DB.batch(stmts);
      const name = PNAME[pp];
      return txt(`已登記 ${name}\n${out.join('\n')}` + (allUnknown.length ? `\n不認得的房號（沒寫入）：${[...new Set(allUnknown)].join('、')}` : '') + `\n網站：https://eroom.yzprojecttw.com/?p=${pp}&d=${segs[0].d}`);
    }

    // ---- 訂房自動拆成每天房況（給 Grok 用）----
    // /api/text/book?k=金鑰&p=ersu&t=201 10/22-24 ⏎ 305 10/22 ⏎ 201/501 10/25-26
    // 每行：房號（可用 / 連多間）＋入住日期，「10/22-24」＝住 22、23、24 三晚，25 退房；只寫「10/22」＝住一晚
    // 入住當天＝入住，中間＝續住（不用掃），退房當天＝退房（要掃）；同一天又退又入＝退房→入住
    // preview=1 只預覽不寫入
    if (path === 'text/book' && (m === 'GET' || m === 'POST')) {
      const key = await env.DB.prepare("SELECT v FROM settings WHERE k='bot_key'").first();
      if (!key || url.searchParams.get('k') !== key.v) return txt('金鑰錯誤', 401);
      const pp = url.searchParams.get('p');
      if (!PROPS.includes(pp)) return txt('p 要填 ersu（貳宿）、eryanglou（貳洋樓）或 erlu（貳旅）', 400);
      let t = url.searchParams.get('t') || '';
      if (m === 'POST') t = (await request.text()) || t;
      const cfg = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(pp).first();
      const rooms = cfg ? JSON.parse(cfg.data).rooms || [] : [];
      const roomSet = new Map(rooms.map((r) => [r.toUpperCase(), r]));
      const ev = {}; // date -> room -> {in, stay, out}
      const add = (d, r, k) => { ((ev[d] ||= {})[r] ||= {})[k] = true; };
      const bad2 = [], books = [];
      for (const raw of String(t).split(/\n|；|;/)) {
        const ln = raw.trim(); if (!ln) continue;
        const dm = ln.match(/(?<![0-9A-Za-z])(?:(\d{4})[\/.\-])?(\d{1,2})[\/.](\d{1,2})(?![0-9])(?:\s*[-~～到至]\s*(?:(\d{1,2})[\/.])?(\d{1,2})(?![0-9]))?/);
        if (!dm) { bad2.push(ln + '（找不到日期）'); continue; }
        const start = toDate(dm[1], dm[2], dm[3]);
        let end = start;
        if (dm[5]) {
          const endMo = dm[4] || dm[2]; end = toDate(dm[1], endMo, dm[5]);
          if (end && end < start) {
            if (!dm[4]) { const x = new Date(start + 'T00:00:00Z'); end = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, +dm[5])).toISOString().slice(0, 10); }
            else { const y = +start.slice(0, 4) + 1; end = toDate(String(y), endMo, dm[5]); }
          }
        }
        if (!start || !end || end < start) { bad2.push(ln + '（日期不對）'); continue; }
        if ((Date.parse(end) - Date.parse(start)) / 864e5 > 30) { bad2.push(ln + '（超過 31 晚）'); continue; }
        const rest = ln.replace(dm[0], ' ');
        const rs = [...new Set((rest.match(/[0-9A-Za-z]+/g) || []).map((x) => roomSet.get(x.toUpperCase())).filter(Boolean))];
        if (!rs.length) { bad2.push(ln + '（找不到房號）'); continue; }
        for (const r of rs) {
          add(start, r, 'in');
          for (let d = addDay(start, 1); d <= end; d = addDay(d, 1)) add(d, r, 'stay');
          add(addDay(end, 1), r, 'out');
          books.push(`${r} ${start.slice(5).replace('-', '/')}～${end.slice(5).replace('-', '/')}（${(Date.parse(end) - Date.parse(start)) / 864e5 + 1} 晚）`);
        }
      }
      const dates = Object.keys(ev).sort();
      if (!dates.length) return txt('沒有可登記的訂房。每行寫「房號 入住日期」，例如：\n201 10/22-24\n305 10/22\n201/501 10/25-26' + (bad2.length ? '\n\n看不懂的行：\n' + bad2.join('\n') : ''), 400);
      const { results } = await env.DB.prepare('SELECT date,room,data FROM records WHERE prop=? AND date BETWEEN ? AND ?').bind(pp, dates[0], dates[dates.length - 1]).all();
      const old = {}; for (const r of results) (old[r.date] ||= {})[r.room] = JSON.parse(r.data);
      const KL = { '退入': '退房→入住', '退房': '退房', '入住': '入住', '續住': '續住' };
      const now = Date.now(); const stmts = [], lines = [], warn = [];
      for (const d of dates) {
        const parts = [];
        for (const r of Object.keys(ev[d]).sort((a, b) => rooms.indexOf(a) - rooms.indexOf(b))) {
          const e = ev[d][r]; const o = (old[d] || {})[r] || {};
          let data;
          if (e.stay) {
            if (e.in || e.out) warn.push(`${d} ${r}：訂房重疊（同一天又續住又入住／退房），已當續住`);
            data = { kind: '續住', status: o.kind === '續住' ? (o.status || '') : '' };
            if (o.kind && o.kind !== '續住') warn.push(`${d} ${r}：原本是${KL[o.kind] || o.kind}，改成續住`);
          } else {
            const hasIn = e.in || o.kind === '入住' || o.kind === '退入';
            const hasOut = e.out || o.kind === '退房' || o.kind === '退入';
            data = hasIn && hasOut ? { kind: '退入', status: 'todo' } : hasIn ? { kind: '入住', status: '' } : { kind: '退房', status: 'todo' };
            if (o.kind === '續住') warn.push(`${d} ${r}：原本是續住，改成${KL[data.kind]}`);
          }
          parts.push(`${r} ${KL[data.kind]}`);
          stmts.push(await upsertRecord(env, pp, d, r, data, now));
        }
        lines.push(`${d}：${parts.join('、')}`);
      }
      const preview = url.searchParams.get('preview') === '1';
      if (!preview) await env.DB.batch(stmts);
      const name = PNAME[pp];
      return txt(`${preview ? '預覽（還沒寫入）' : '已登記'} ${name} 訂房 ${books.length} 筆\n${books.join('\n')}\n\n每天房況：\n${lines.join('\n')}` +
        (warn.length ? `\n\n注意：\n${warn.join('\n')}` : '') + (bad2.length ? `\n\n看不懂的行（沒寫入）：\n${bad2.join('\n')}` : '') +
        `\n\n網站：https://eroom.yzprojecttw.com/?p=${pp}&d=${dates[0]}`);
    }

    // ---- 純文字查詢（給 Grok 等讀取用，一次拿多天，不用操作網頁）----
    if (path === 'text' && m === 'GET') {
      const from = url.searchParams.get('from') || url.searchParams.get('d') || twDate(Date.now());
      const to = url.searchParams.get('to') || from;
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return bad('參數錯誤，例如 /api/text?p=ersu&from=2026-10-01&to=2026-10-20');
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) return bad('一次最多查 93 天');
      const ps = PROPS.includes(p) ? [p] : PROPS;
      const LBL = { '退房': '退房', '退入': '退房→入住', '續住': '續住', '入住': '入住' };
      const { results } = await env.DB.prepare('SELECT prop,date,room,data FROM records WHERE date BETWEEN ? AND ? ORDER BY date').bind(from, to).all();
      const cfgs = {};
      for (const pp of ps) { const c = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(pp).first(); cfgs[pp] = c ? JSON.parse(c.data).rooms || [] : []; }
      const map = {};
      for (const r of results) { if (!ps.includes(r.prop)) continue; const x = JSON.parse(r.data); if (!x.kind) continue; ((map[r.date] ||= {})[r.prop] ||= []).push([r.room, x]); }
      const out = [`E·ROOM 房況 ${from} ～ ${to}（${ps.map((x) => PNAME[x]).join('、')}）`, ''];
      for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 864e5) {
        const d = new Date(t).toISOString().slice(0, 10);
        for (const pp of ps) {
          const rows = (map[d]?.[pp] || []).sort((a, b) => cfgs[pp].indexOf(a[0]) - cfgs[pp].indexOf(b[0]));
          const name = PNAME[pp];
          if (!rows.length) { out.push(`${d} ${name}：沒有登記`); continue; }
          const need = rows.filter(([, x]) => x.status === 'todo' || x.status === 'done').length;
          out.push(`${d} ${name}：要掃 ${need} 間｜` + rows.map(([r, x]) => `${r} ${LBL[x.kind] || x.kind}${x.kind === '續住' ? (x.status ? '要掃' : '不用掃') : ''}${x.note ? `（${x.note}）` : ''}`).join('、'));
        }
      }
      return new Response(out.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }

    // ---- 維護／房況紀錄（大家都能新增、編輯、刪除）----
    if (path === 'logs') return logsApi(request, env, url, m);
    // 管理員測試：這段回報會被登記成什麼（不寫入）
    if (path === 'logs/parse' && m === 'GET') {
      if (!(await isAdmin(env, request))) return bad('需要管理員密碼', 401);
      if (!PROPS.includes(p)) return bad('館別錯誤');
      return json(await parseReport(env, p, url.searchParams.get('t') || ''));
    }

    // ---- LINE 官方帳號 ----
    if (path.startsWith('line/')) return line(path.slice(5), m, request, env, url, ctx);

    // ---- 月報表 ----
    if (path === 'report' && m === 'GET') {
      const mo = url.searchParams.get('month') || '';
      const rg = url.searchParams.get('range') || '';
      let from, to;
      if (/^\d{4}-\d{2}$/.test(mo)) { from = mo + '-01'; to = mo + '-31'; }
      else if (/^\d{4}(-H[12])?$/.test(rg)) { const y = rg.slice(0, 4); from = y + (rg.endsWith('H2') ? '-07-01' : '-01-01'); to = y + (rg.endsWith('H1') ? '-06-30' : '-12-31'); }
      else return bad('參數錯誤');
      const { results: recs } = await env.DB.prepare('SELECT prop,date,room,data FROM records WHERE date BETWEEN ? AND ?').bind(from, to).all();
      const props = {};
      const daily = {};
      const monthly = {};
      for (const r of recs) {
        const d = JSON.parse(r.data);
        const P = (props[r.prop] ||= { rooms: {}, tot: { checkout: 0, turnover: 0, stay: 0, stayClean: 0, checkin: 0, need: 0, done: 0, occ: 0, doneMins: [] }, days: new Set() });
        const R = (P.rooms[r.room] ||= { checkout: 0, turnover: 0, stay: 0, stayClean: 0, checkin: 0, need: 0, done: 0, occ: 0, doneMins: [] });
        const day = (daily[r.date] ||= {});
        const D = (day[r.prop] ||= { need: 0, done: 0, checkin: 0, occ: 0 });
        const MM = ((monthly[r.date.slice(0, 7)] ||= {})[r.prop] ||= { checkin: 0 });
        if (d.kind === '入住' || d.kind === '退入') MM.checkin++;
        // 入住率：當晚有客人住（入住、退房→入住、續住）
        P.days.add(r.date);
        (MM.days ||= {})[r.date] = 1;
        if (d.kind === '入住' || d.kind === '退入' || d.kind === '續住') { R.occ++; P.tot.occ++; D.occ++; MM.occ = (MM.occ || 0) + 1; }
        const add = (k) => { R[k]++; P.tot[k]++; };
        if (d.kind === '退房') add('checkout');
        if (d.kind === '退入') { add('turnover'); add('checkin'); D.checkin++; }
        if (d.kind === '入住') { add('checkin'); D.checkin++; }
        if (d.kind === '續住') { add('stay'); if (d.status === 'todo' || d.status === 'done') add('stayClean'); }
        if (d.kind && d.kind !== '入住' && (d.status === 'todo' || d.status === 'done')) { add('need'); D.need++; }
        if (d.status === 'done') {
          add('done'); D.done++;
          if (d.doneAt) { const t = new Date(d.doneAt + 8 * 3600e3); const mins = t.getUTCHours() * 60 + t.getUTCMinutes(); R.doneMins.push(mins); P.tot.doneMins.push(mins); }
        }
      }
      for (const mo2 in monthly) for (const pp in monthly[mo2]) monthly[mo2][pp].days = Object.keys(monthly[mo2][pp].days || {}).length;
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      for (const p in props) {
        props[p].tot.avgDone = avg(props[p].tot.doneMins); delete props[p].tot.doneMins;
        props[p].tot.days = props[p].days.size; delete props[p].days;
        for (const r in props[p].rooms) { const R = props[p].rooms[r]; R.avgDone = avg(R.doneMins); delete R.doneMins; }
      }
      const { results: iss } = await env.DB.prepare('SELECT prop,room,type,status,created_at,resolved_at FROM issues WHERE date BETWEEN ? AND ?').bind(from, to).all();
      const byType = {}, byRoom = {}; let open = 0; const hrs = [];
      for (const i of iss) {
        byType[i.type] = (byType[i.type] || 0) + 1;
        const k = i.prop + ':' + i.room; byRoom[k] = (byRoom[k] || 0) + 1;
        if (i.status === 'open') open++; else if (i.resolved_at) hrs.push((i.resolved_at - i.created_at) / 3600e3);
      }
      return json({
        month: mo, range: rg, from, to, props, daily, monthly,
        issues: { total: iss.length, open, byType, byRoom, avgResolveHours: hrs.length ? Math.round((hrs.reduce((a, b) => a + b, 0) / hrs.length) * 10) / 10 : null },
      });
    }

    // ---- 問題回報（含照片、缺備品）----
    if (path === 'issues') {
      if (m === 'GET') {
        const st = url.searchParams.get('status') || 'open';
        const limit = Math.min(+url.searchParams.get('limit') || 100, 300);
        const q = st === 'all'
          ? env.DB.prepare('SELECT * FROM issues ORDER BY created_at DESC LIMIT ?').bind(limit)
          : env.DB.prepare('SELECT * FROM issues WHERE status=? ORDER BY created_at DESC LIMIT ?').bind(st, limit);
        const { results } = await q.all();
        return json({ issues: results.map(issueOut) });
      }
      if (m === 'POST') {
        const b = await body(request);
        if (!b || !PROPS.includes(b.p) || !ROOM_RE.test(String(b.room || '')) || !ISSUE_TYPES.includes(b.type)) return bad('參數錯誤');
        const now = Date.now();
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40)
          .map((i) => ({ name: String(i.name || '').slice(0, 30), qty: Math.max(1, Math.min(99, parseInt(i.qty) || 1)) }))
          .filter((i) => i.name);
        const photoIds = [];
        const stmts = [];
        for (const du of (Array.isArray(b.photos) ? b.photos : []).slice(0, 3)) {
          const mm = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(du));
          if (!mm || mm[3].length > 1_400_000) continue;
          const id = crypto.randomUUID().replace(/-/g, '');
          photoIds.push(id);
          stmts.push(env.DB.prepare('INSERT INTO photos (id,mime,data,created_at) VALUES (?,?,?,?)').bind(id, mm[1], mm[3], now));
        }
        stmts.push(env.DB.prepare('INSERT INTO issues (prop,room,date,type,text,items,photos,by,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(b.p, b.room, DATE_RE.test(b.d || '') ? b.d : twDate(now), b.type, String(b.text || '').slice(0, 500),
            JSON.stringify(items), JSON.stringify(photoIds), String(b.by || '').slice(0, 20), 'open', now));
        await env.DB.batch(stmts);
        return json({ ok: true });
      }
      if (m === 'PATCH' || m === 'PUT') {
        const b = await body(request);
        if (!b || !Number.isInteger(b.id) || !['open', 'done'].includes(b.status)) return bad('參數錯誤');
        const now = Date.now();
        await env.DB.prepare('UPDATE issues SET status=?, resolved_at=?, resolved_by=? WHERE id=?')
          .bind(b.status, b.status === 'done' ? now : null, b.status === 'done' ? String(b.by || '').slice(0, 20) : null, b.id).run();
        return json({ ok: true });
      }
    }

    if (path.startsWith('photo/') && m === 'GET') {
      const id = path.slice(6);
      if (!/^[0-9a-f]{32}$/.test(id)) return bad('找不到', 404);
      const row = await env.DB.prepare('SELECT mime,data FROM photos WHERE id=?').bind(id).first();
      if (!row) return bad('找不到', 404);
      const bin = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { 'content-type': row.mime, 'cache-control': 'public, max-age=31536000, immutable' } });
    }

    // ---- 給 Google 試算表同步用（需要同步金鑰）----
    if (path === 'export' && m === 'GET') {
      const k = request.headers.get('x-sync-key') || url.searchParams.get('key') || '';
      const row = await env.DB.prepare("SELECT v FROM settings WHERE k='sync_key'").first();
      if (!row || !k || k !== row.v) return bad('同步金鑰錯誤', 401);
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return bad('參數錯誤');
      const recs = await env.DB.prepare('SELECT prop,date,room,data,updated_at FROM records WHERE date BETWEEN ? AND ? ORDER BY date,prop,room').bind(from, to).all();
      const iss = await env.DB.prepare('SELECT * FROM issues WHERE date BETWEEN ? AND ? OR status=\'open\' ORDER BY created_at').bind(from, to).all();
      const origin = url.origin;
      return json({
        records: recs.results.map((r) => ({ prop: r.prop, date: r.date, room: r.room, ...JSON.parse(r.data), updated_at: r.updated_at })),
        issues: iss.results.map((r) => ({ ...issueOut(r), photoUrls: JSON.parse(r.photos || '[]').map((id) => origin + '/api/photo/' + id) })),
      });
    }

    return bad('找不到', 404);
  } catch (e) {
    return bad('伺服器錯誤：' + (e && e.message ? e.message : e), 500);
  }
}

// ======================= LINE =======================
// settings：line_secret、line_token、line_groups（{id:{name,at}}）、line_target、line_enabled、line_last、cron_key
const PROP_NAME = PNAME;
const KIND_LABEL = { '退房': '退房', '退入': '退房→入住', '續住': '續住' };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

async function getS(env, k) { const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(k).first(); return r ? r.v : null; }
async function setS(env, k, v) { return env.DB.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run(); }
async function groups(env) { try { return JSON.parse((await getS(env, 'line_groups')) || '{}'); } catch { return {}; } }

async function lineApi(token, path, init = {}) {
  const r = await fetch('https://api.line.me/v2/bot/' + path, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error('LINE ' + r.status + '：' + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}

async function verifySig(secret, body, sig) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

function floorOf(r) { return r.length >= 3 ? r.slice(0, -2) : r.slice(0, 1); }

// 同一層縮寫：201.3.5.6（第一間寫全，後面同樓層只寫尾號；非純數字房號照寫）
function compact(list, R) {
  const fl = {};
  for (const r of list) (fl[floorOf(r)] ||= []).push(r);
  return Object.keys(fl).map((f) => fl[f].map((r, i) => {
    let t = r;
    if (i > 0 && /^\d+$/.test(r) && /^\d+$/.test(fl[f][0]) && r.length === fl[f][0].length) t = String(parseInt(r.slice(f.length), 10));
    const x = R[r] || {};
    const extra = [x.lateOut && '延退' + x.lateOut, x.earlyIn && '早入' + x.earlyIn, x.note].filter(Boolean).join(' ');
    return t + (extra ? `（${extra}）` : '');
  }).join('.'));
}

async function dailyText(env, date, props = PROPS) {
  const d = new Date(date + 'T00:00:00Z');
  const lines = [`🧹${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`];
  for (const p of props) {
    const cfg = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(p).first();
    const rooms = cfg ? JSON.parse(cfg.data).rooms || [] : [];
    const { results } = await env.DB.prepare('SELECT room,data FROM records WHERE prop=? AND date=?').bind(p, date).all();
    const R = {}; for (const r of results) R[r.room] = JSON.parse(r.data);
    const byNo = (a, b) => rooms.indexOf(a) - rooms.indexOf(b);
    const list = rooms.filter((r) => R[r] && (R[r].status === 'todo' || R[r].status === 'done') && KIND_LABEL[R[r].kind]).sort(byNo);
    const prio = list.filter((r) => R[r].kind === '退入');
    lines.push(`【${PROP_NAME[p]}】${list.length ? list.length + ' 間' : '今天不用掃'}`);
    lines.push(...compact(list, R));
    if (prio.length) {
      lines.push(`⭐今日入住（優先 ${prio.length}）：`);
      lines.push(...compact(prio, {}));
    }
    const stay = rooms.filter((r) => R[r] && R[r].kind === '續住');
    if (stay.length) {
      lines.push('⚠️今日續住：');
      lines.push(...compact(stay, {}));
    }
  }
  return lines.join('\n').slice(0, 4900);
}

async function targets(env) {
  const t = {};
  for (const p of PROPS) t[p] = (await getS(env, 'line_target_' + p)) || '';
  return t;
}

// 每館開關：每日推播（預設 貳宿／貳洋樓 開、貳侶 關）、群組自動登記紀錄（預設 貳旅 開）
async function pushOn(env, p) { const v = await getS(env, 'line_push_' + p); return v == null || v === '' ? p !== 'erlu' : v === '1'; }
async function autologOn(env, p) { const v = await getS(env, 'line_autolog_' + p); return v == null || v === '' ? p === 'erlu' : v === '1'; }

async function unregistered(env, date) {
  const out = [];
  const tg = await targets(env);
  for (const p of PROPS) {
    if (!tg[p] || !(await pushOn(env, p))) continue;
    const r = await env.DB.prepare("SELECT count(*) n FROM records WHERE prop=? AND date=? AND json_extract(data,'$.kind') <> ''").bind(p, date).first();
    if (!r || !r.n) out.push(p);
  }
  return out;
}
async function alertAdmin(env, text) {
  const token = await getS(env, 'line_token'), admin = await getS(env, 'line_admin');
  if (!token || !admin) return false;
  await lineApi(token, 'message/push', { method: 'POST', body: JSON.stringify({ to: admin, messages: [{ type: 'text', text }] }) });
  return true;
}
const mdw = (date) => { const d = new Date(date + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`; };

async function pushDaily(env, { force = false, only = null } = {}) {
  const token = await getS(env, 'line_token');
  if (!token) throw new Error('還沒設定 LINE 金鑰');
  const tg = await targets(env);
  const date = twDate(Date.now());
  if (!force && (await getS(env, 'line_enabled')) !== '1') return { skipped: '每日推播已關閉' };
  const sent = [], skipped = [], unreg = [];
  for (const p of PROPS) {
    if (only && p !== only) continue;
    if (!tg[p]) { skipped.push(PROP_NAME[p] + '：沒有綁定群組'); continue; }
    if (!force && !(await pushOn(env, p))) { skipped.push(PROP_NAME[p] + '：每日推播關閉'); continue; }
    if (!force && (await getS(env, 'line_last_' + p)) === date) { skipped.push(PROP_NAME[p] + '：今天已經傳過'); continue; }
    if (!force && (await unregistered(env, date)).includes(p)) { skipped.push(PROP_NAME[p] + '：今天還沒登記'); unreg.push(PROP_NAME[p]); continue; }
    const text = await dailyText(env, date, [p]);
    await lineApi(token, 'message/push', { method: 'POST', body: JSON.stringify({ to: tg[p], messages: [{ type: 'text', text }] }) });
    if (!force) await setS(env, 'line_last_' + p, date);
    sent.push(PROP_NAME[p]);
  }
  if (unreg.length) { try { await alertAdmin(env, `⚠️ ${mdw(date)} 10:50 沒有傳送：${unreg.join('、')}今天還沒登記房況。\n登記好後到 E·ROOM「報表 → LINE 設定」按「傳一則今日打掃」補傳。`); } catch {} }
  if (!sent.length && force) throw new Error(skipped.join('；') || '沒有可傳送的群組');
  return { ok: true, date, sent, skipped };
}

async function line(sub, m, request, env, url, ctx) {
  // LINE 平台 webhook：記錄機器人被加入的群組
  if (sub === 'webhook' && m === 'POST') {
    const raw = await request.text();
    const secret = await getS(env, 'line_secret');
    if (!secret || !(await verifySig(secret, raw, request.headers.get('x-line-signature') || ''))) return bad('簽章錯誤', 401);
    const token = await getS(env, 'line_token');
    const body = JSON.parse(raw || '{}');
    const gs = await groups(env);
    let changed = false;
    for (const ev of body.events || []) {
      const gid = ev.source && ev.source.groupId;
      if (!gid) {
        // 一對一聊天：傳「綁定管理員」→ 之後未登記提醒會傳給這個人
        const uid = ev.source && ev.source.type === 'user' && ev.source.userId;
        const tx = ev.type === 'message' && ev.message?.type === 'text' ? (ev.message.text || '').trim() : '';
        if (uid && /綁定管理員/.test(tx)) {
          await setS(env, 'line_admin', uid);
          if (token && ev.replyToken) { try { await lineApi(token, 'message/reply', { method: 'POST', body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: '已綁定為 E·ROOM 管理員。每天 10:30 還沒登記房況會提醒你，10:50 沒傳出去也會通知你。' }] }) }); } catch {} }
        }
        continue;
      }
      if (ev.type === 'leave') { delete gs[gid]; changed = true; for (const p of PROPS) if ((await getS(env, 'line_target_' + p)) === gid) await setS(env, 'line_target_' + p, ''); continue; }
      if (ev.type === 'unsend' && ev.unsend?.messageId) { await env.DB.prepare('UPDATE logs SET deleted=1, updated_at=? WHERE line_msg=?').bind(Date.now(), ev.unsend.messageId).run(); continue; }
      const text = ev.type === 'message' && ev.message?.type === 'text' ? (ev.message.text || '').trim() : '';
      if (ev.type === 'message' && text && !/綁定/.test(text)) {
        const tg = await targets(env);
        const p = PROPS.find((x) => tg[x] === gid);
        if (p && (await autologOn(env, p))) {
          // AI 解析可能要幾秒，先回 LINE 200，背景處理完再回覆
          const job = (async () => {
            const res = await autoLog(env, p, text, ev, gid, token);
            if (res && token && ev.replyToken) { try { await lineApi(token, 'message/reply', { method: 'POST', body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: res }] }) }); } catch {} }
          })().catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
        }
        continue;
      }
      if (ev.type !== 'join' && !/綁定/.test(text)) continue;
      let name = gs[gid]?.name || '';
      if (token) { try { name = (await lineApi(token, 'group/' + gid + '/summary')).groupName || name; } catch {} }
      gs[gid] = { name, at: Date.now() }; changed = true;
      let msg;
      if (ev.type === 'join') {
        msg = '已連上 E·ROOM 房務。\n這個群組是哪一館，請傳「綁定貳宿」「綁定貳洋樓」或「綁定貳旅」。';
      } else if (/綁定/.test(text)) {
        const p = /洋樓/.test(text) ? 'eryanglou' : /貳宿|二宿/.test(text) ? 'ersu' : /貳旅|二旅|貳侶|二侶/.test(text) ? 'erlu' : null;
        if (!p) msg = '請傳「綁定貳宿」「綁定貳洋樓」或「綁定貳旅」。';
        else { await setS(env, 'line_target_' + p, gid); const lines = [`已綁定【${PROP_NAME[p]}】。`]; if (await pushOn(env, p)) lines.push('每天 10:50 會傳今日要掃的房間。'); if (await autologOn(env, p)) lines.push('群組裡回報冷氣清洗、維修、房況（要寫房號），會自動登記到 E·ROOM 紀錄。例如：「冷氣清洗 201 202」「203 馬桶修好了」。'); msg = lines.join('\n'); }
      }
      if (token && ev.replyToken) {
        try { await lineApi(token, 'message/reply', { method: 'POST', body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: msg }] }) }); } catch {}
      }
    }
    if (changed) await setS(env, 'line_groups', JSON.stringify(gs));
    return json({ ok: true });
  }

  // 排程（Cloudflare Worker cron 每天 10:50 呼叫）
  if (sub === 'daily' && m === 'POST') {
    const key = await getS(env, 'cron_key');
    if (!key || request.headers.get('x-cron-key') !== key) return bad('金鑰錯誤', 401);
    try { return json(await pushDaily(env)); } catch (e) { return bad(e.message, 500); }
  }

  // 排程 10:30：還沒登記就提醒管理員
  if (sub === 'check' && m === 'POST') {
    const key = await getS(env, 'cron_key');
    if (!key || request.headers.get('x-cron-key') !== key) return bad('金鑰錯誤', 401);
    if ((await getS(env, 'line_enabled')) !== '1') return json({ skipped: '每日推播已關閉' });
    const date = twDate(Date.now());
    const u = await unregistered(env, date);
    if (!u.length) return json({ ok: true, all: '都登記了' });
    try { const sent = await alertAdmin(env, `⚠️ ${mdw(date)} ${u.map((p) => PROP_NAME[p]).join('、')}還沒登記房況。\n10:50 會自動傳打掃清單到群組，請在這之前登記。`); return json({ ok: true, unreg: u, alerted: sent }); }
    catch (e) { return bad(e.message, 500); }
  }

  // 以下需要管理員
  if (!(await isAdmin(env, request))) return bad('需要管理員密碼', 401);

  if (sub === 'config' && m === 'GET') {
    return json({
      hasSecret: !!(await getS(env, 'line_secret')), hasToken: !!(await getS(env, 'line_token')),
      groups: await groups(env), targets: await targets(env),
      enabled: (await getS(env, 'line_enabled')) === '1', last: Object.fromEntries(await Promise.all(PROPS.map(async (p) => [p, (await getS(env, 'line_last_' + p)) || '']))),
      push: Object.fromEntries(await Promise.all(PROPS.map(async (p) => [p, await pushOn(env, p)]))), autolog: Object.fromEntries(await Promise.all(PROPS.map(async (p) => [p, await autologOn(env, p)]))),
      webhook: url.origin + '/api/line/webhook', adminBound: !!(await getS(env, 'line_admin')),
    });
  }
  if (sub === 'config' && (m === 'PUT' || m === 'POST')) {
    const b = await body(request);
    if (!b) return bad('參數錯誤');
    if (typeof b.secret === 'string' && b.secret.trim()) await setS(env, 'line_secret', b.secret.trim());
    if (typeof b.token === 'string' && b.token.trim()) {
      const t = b.token.trim();
      try { await lineApi(t, 'info'); } catch (e) { return bad('Channel access token 無效：' + e.message); }
      await setS(env, 'line_token', t);
    }
    if (b.targets && typeof b.targets === 'object') for (const p of PROPS) if (typeof b.targets[p] === 'string') await setS(env, 'line_target_' + p, b.targets[p]);
    if (typeof b.enabled === 'boolean') await setS(env, 'line_enabled', b.enabled ? '1' : '0');
    if (b.clearAdmin === true) await setS(env, 'line_admin', '');
    if (b.push && typeof b.push === 'object') for (const p of PROPS) if (typeof b.push[p] === 'boolean') await setS(env, 'line_push_' + p, b.push[p] ? '1' : '0');
    if (b.autolog && typeof b.autolog === 'object') for (const p of PROPS) if (typeof b.autolog[p] === 'boolean') await setS(env, 'line_autolog_' + p, b.autolog[p] ? '1' : '0');
    return json({ ok: true });
  }
  if (sub === 'preview' && m === 'GET') { const d = twDate(Date.now()); return json({ texts: Object.fromEntries(await Promise.all(PROPS.map(async (p) => [p, await dailyText(env, d, [p])]))) }); }
  if (sub === 'test' && m === 'POST') {
    const b = await body(request);
    try { return json(await pushDaily(env, { force: true, only: PROPS.includes(b?.p) ? b.p : null })); } catch (e) { return bad(e.message); }
  }
  return bad('找不到', 404);
}


// ======================= 維護／房況紀錄 =======================
// logs(id, prop, room, date, cat, content, by, source, line_msg, deleted, created_at, updated_at)
const LOG_CATS = ['冷氣清洗', '冷氣維修', '維修', '房況', '其他'];
function guessCat(t) {
  const ac = /冷氣|空調|AC|濾網/i.test(t);
  const fix = /修|壞|故障|報修|漏水|不冷|不涼|異音|換|更換|滴水|跳電/.test(t);
  if (ac && /洗|清/.test(t) && !/壞|故障|不冷|不涼/.test(t)) return '冷氣清洗';
  if (ac) return fix ? '冷氣維修' : '冷氣清洗';
  if (fix) return '維修';
  if (/房況|掃|髒|乾淨|整理|消毒|除濕|異味|蟲|床|毛巾|備品/.test(t)) return '房況';
  return null;
}
function findRooms(t, rooms) {
  const set = new Map(rooms.map((r) => [r.toUpperCase(), r]));
  const toks = String(t).replace(/(?<![0-9])(\d{1,2})[\/.](\d{1,2})(?![0-9])/g, ' ').match(/[0-9A-Za-z]+/g) || [];
  const out = [];
  for (const x of toks) {
    const r = rooms.length ? set.get(x.toUpperCase()) : (/^\d{3,4}[A-Za-z]?$/.test(x) ? x : null);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}
function msgDate(t) {
  const m = String(t).match(/(?<![0-9])(\d{1,2})[\/.](\d{1,2})(?![0-9])/);
  if (m) { const d = toDate(null, m[1], m[2]); if (d && d <= twDate(Date.now())) return d; }
  if (/昨天|昨日/.test(t)) return addDay(twDate(Date.now()), -1);
  return twDate(Date.now());
}
// 用 AI 讀懂比較亂的回報：多間、多件事、「2樓全部」、口語日期；AI 失敗就用關鍵字規則
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
async function aiParse(env, text, rooms) {
  if (!env.AI) return null;
  const today = twDate(Date.now());
  const sys = `你是民宿「房務紀錄」助手。員工在 LINE 群組回報，請找出需要登記的紀錄。
今天是 ${today}（台灣）。這一館的房號：${rooms.length ? rooms.join('、') : '（未設定，只能用訊息裡明確寫出的房號）'}。
類型只能是：冷氣清洗（冷氣/空調/濾網 清洗、保養）、冷氣維修（冷氣壞了、不冷、漏水、報修、修好、更換零件）、維修（冷氣以外的設備壞了、修理、更換：燈、馬桶、水龍頭、熱水器、門鎖、電視…）、房況（房間狀態：髒、異味、蟲、床、備品、消毒、客人損壞、需要注意的狀況）、其他（跟房間有關但不屬於上面）。
規則：
- 只登記「回報已經發生或已完成的事」。聊天、問句、打招呼、排班、請別人去做但還沒做的，回傳空陣列。
- 一則訊息可能有多間、多件事，每間每件事各一筆。
- 「2樓全部」「全部房間」要展開成房號清單裡對應的房間。
- 日期：訊息寫 M/D、昨天、前天就換算成 YYYY-MM-DD，沒寫就是今天。不能是未來。
- summary 用繁體中文，20 字內，保留重點（做了什麼、狀況、零件、師傅）。
- 房號一定要出現在房號清單（或訊息裡），不確定就不要寫。`;
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { room: { type: 'string' }, cat: { type: 'string', enum: LOG_CATS }, date: { type: 'string' }, summary: { type: 'string' } }, required: ['room', 'cat', 'date', 'summary'] } } }, required: ['items'] };
  try {
    const r = await env.AI.run(AI_MODEL, { messages: [{ role: 'system', content: sys }, { role: 'user', content: text.slice(0, 1500) }], response_format: { type: 'json_schema', json_schema: schema }, max_tokens: 900, temperature: 0 });
    let out = r && r.response;
    if (typeof out === 'string') { const m = out.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : null; }
    if (!out || !Array.isArray(out.items)) return null;
    const set = new Map(rooms.map((x) => [x.toUpperCase(), x]));
    const seen = new Set(), items = [];
    for (const it of out.items) {
      const rr = String(it.room || '').trim().toUpperCase();
      const room = rooms.length ? set.get(rr) : (/^\d{3,4}[A-Z]?$/.test(rr) && text.toUpperCase().includes(rr) ? rr : null);
      if (!room || !LOG_CATS.includes(it.cat)) continue;
      let date = DATE_RE.test(it.date || '') ? it.date : today;
      if (date > today || date < addDay(today, -60)) date = today;
      const k = room + '|' + it.cat; if (seen.has(k)) continue; seen.add(k);
      items.push({ room, cat: it.cat, date, summary: String(it.summary || '').slice(0, 80) });
    }
    return items;
  } catch (e) { return null; }
}
function ruleParse(text, rooms) {
  const cat = guessCat(text); if (!cat) return [];
  const date = msgDate(text);
  return findRooms(text, rooms).map((room) => ({ room, cat, date, summary: '' }));
}
async function parseReport(env, p, text) {
  const cfg = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(p).first();
  const rooms = cfg ? JSON.parse(cfg.data).rooms || [] : [];
  // 先篩：沒有像房號的字、也沒有「樓／全部」就不用問 AI
  if (!findRooms(text, rooms).length && !/樓|全部|每間|所有房/.test(text)) return { items: [], via: 'skip' };
  const ai = await aiParse(env, text, rooms);
  if (ai) return { items: ai, via: 'ai' };
  return { items: ruleParse(text, rooms), via: 'rule' };
}
async function autoLog(env, p, text, ev, gid, token) {
  const { items } = await parseReport(env, p, text);
  if (!items.length) return null;
  let by = '';
  const uid = ev.source && ev.source.userId;
  if (token && uid) { try { by = (await lineApi(token, 'group/' + gid + '/member/' + uid)).displayName || ''; } catch {} }
  const now = Date.now();
  await env.DB.batch(items.map((it) => env.DB.prepare('INSERT INTO logs (prop,room,date,cat,content,raw,by,source,line_msg,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)')
    .bind(p, it.room, it.date, it.cat, it.summary || text.slice(0, 500), text.slice(0, 1000), by.slice(0, 30), 'line', ev.message?.id || null, now, now)));
  const groups = {};
  for (const it of items) { const k = it.cat + '|' + it.date + '|' + (it.summary || ''); (groups[k] ||= []).push(it.room); }
  const lines = Object.keys(groups).map((k) => { const [c, d, sm] = k.split('|'); const x = new Date(d + 'T00:00:00Z'); return `・${c} ${x.getUTCMonth() + 1}/${x.getUTCDate()}｜${groups[k].join('、')}${sm ? '｜' + sm : ''}`; });
  return `✅ 已登記到 E·ROOM 紀錄\n${lines.join('\n')}\n記錯了：收回這則訊息就會刪掉，或到網站修改。`;
}

async function logsApi(request, env, url, m) {
  const p = url.searchParams.get('p');
  if (m === 'GET') {
    if (!PROPS.includes(p)) return bad('館別錯誤');
    const q = ['prop=?', 'deleted=0']; const args = [p];
    const cat = url.searchParams.get('cat'), room = url.searchParams.get('room');
    if (cat && LOG_CATS.includes(cat)) { q.push('cat=?'); args.push(cat); }
    if (room) { q.push('room=?'); args.push(room); }
    const { results } = await env.DB.prepare(`SELECT id,room,date,cat,content,raw,by,source,created_at,updated_at FROM logs WHERE ${q.join(' AND ')} ORDER BY date DESC, id DESC LIMIT 300`).bind(...args).all();
    const { results: last } = await env.DB.prepare("SELECT room, cat, max(date) d FROM logs WHERE prop=? AND deleted=0 AND cat IN ('冷氣清洗','冷氣維修') GROUP BY room, cat").bind(p).all();
    const ac = {};
    for (const r of last) (ac[r.room] ||= {})[r.cat === '冷氣清洗' ? 'clean' : 'fix'] = r.d;
    return json({ logs: results, ac, cats: LOG_CATS });
  }
  const b = await body(request);
  if (m === 'POST') {
    if (!b || !PROPS.includes(b.p) || !LOG_CATS.includes(b.cat) || !DATE_RE.test(b.date || '')) return bad('參數錯誤');
    const rooms = [...new Set((Array.isArray(b.rooms) ? b.rooms : [b.room]).map((x) => String(x || '').trim()).filter((x) => /^[0-9A-Za-z\-]{1,8}$/.test(x) || x === '公共'))].slice(0, 40);
    if (!rooms.length) return bad('請選房號');
    const now = Date.now();
    await env.DB.batch(rooms.map((r) => env.DB.prepare('INSERT INTO logs (prop,room,date,cat,content,by,source,line_msg,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,NULL,0,?,?)')
      .bind(b.p, r, b.date, b.cat, String(b.content || '').slice(0, 500), String(b.by || '').slice(0, 30), 'web', now, now)));
    return json({ ok: true, saved: rooms.length });
  }
  if (m === 'PUT' || m === 'PATCH') {
    if (!b || !Number.isInteger(b.id)) return bad('參數錯誤');
    const old = await env.DB.prepare('SELECT * FROM logs WHERE id=?').bind(b.id).first();
    if (!old) return bad('找不到這筆紀錄', 404);
    const room = typeof b.room === 'string' && b.room.trim() ? b.room.trim().slice(0, 8) : old.room;
    const date = DATE_RE.test(b.date || '') ? b.date : old.date;
    const cat = LOG_CATS.includes(b.cat) ? b.cat : old.cat;
    const content = typeof b.content === 'string' ? b.content.slice(0, 500) : old.content;
    const by = typeof b.by === 'string' ? b.by.slice(0, 30) : old.by;
    await env.DB.prepare('UPDATE logs SET room=?,date=?,cat=?,content=?,by=?,updated_at=? WHERE id=?').bind(room, date, cat, content, by, Date.now(), b.id).run();
    return json({ ok: true });
  }
  if (m === 'DELETE') {
    const id = parseInt(url.searchParams.get('id') || (b && b.id), 10);
    if (!id) return bad('參數錯誤');
    await env.DB.prepare('UPDATE logs SET deleted=1, updated_at=? WHERE id=?').bind(Date.now(), id).run();
    return json({ ok: true });
  }
  return bad('找不到', 404);
}
