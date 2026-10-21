// E·ROOM API — Cloudflare Pages Functions + D1 (binding: DB)
// 相容舊版：GET /api/ping、/api/config?p=、/api/records?p=&d=
// 資料表：records(prop,date,room,data,updated_at)、config(prop,data,updated_at)、docs(k,data,updated_at)、settings(k,v)
// 原則：只做 upsert，不刪除舊資料。

const PROPS = ['ersu', 'eryanglou'];
const DOC_KEYS = ['handbook', 'stay', 'checkout', 'checklist', 'supplies', 'roominfo'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[0-9A-Za-z\-]{1,8}$/;

const ISSUE_TYPES = ['故障', '缺備品', '遺留物', '清潔', '其他'];
const twDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const issueOut = (r) => ({ ...r, items: JSON.parse(r.items || '[]'), photos: JSON.parse(r.photos || '[]') });

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

    // ---- LINE 官方帳號 ----
    if (path.startsWith('line/')) return line(path.slice(5), m, request, env, url);

    // ---- 月報表 ----
    if (path === 'report' && m === 'GET') {
      const mo = url.searchParams.get('month') || '';
      if (!/^\d{4}-\d{2}$/.test(mo)) return bad('參數錯誤');
      const from = mo + '-01', to = mo + '-31';
      const { results: recs } = await env.DB.prepare('SELECT prop,date,room,data FROM records WHERE date BETWEEN ? AND ?').bind(from, to).all();
      const props = {};
      const daily = {};
      for (const r of recs) {
        const d = JSON.parse(r.data);
        const P = (props[r.prop] ||= { rooms: {}, tot: { checkout: 0, turnover: 0, stay: 0, stayClean: 0, checkin: 0, need: 0, done: 0, doneMins: [] } });
        const R = (P.rooms[r.room] ||= { checkout: 0, turnover: 0, stay: 0, stayClean: 0, checkin: 0, need: 0, done: 0, doneMins: [] });
        const day = (daily[r.date] ||= {});
        const D = (day[r.prop] ||= { need: 0, done: 0, checkin: 0 });
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
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      for (const p in props) {
        props[p].tot.avgDone = avg(props[p].tot.doneMins); delete props[p].tot.doneMins;
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
        month: mo, props, daily,
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
const PROP_NAME = { ersu: '貳宿', eryanglou: '貳洋樓' };
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

async function dailyText(env, date, props = PROPS) {
  const d = new Date(date + 'T00:00:00Z');
  const lines = [`🧹 今日要掃｜${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`];
  for (const p of props) {
    const cfg = await env.DB.prepare('SELECT data FROM config WHERE prop=?').bind(p).first();
    const rooms = cfg ? JSON.parse(cfg.data).rooms || [] : [];
    const { results } = await env.DB.prepare('SELECT room,data FROM records WHERE prop=? AND date=?').bind(p, date).all();
    const R = {}; for (const r of results) R[r.room] = JSON.parse(r.data);
    const list = rooms.filter((r) => R[r] && (R[r].status === 'todo' || R[r].status === 'done') && KIND_LABEL[R[r].kind]);
    const prio = list.filter((r) => R[r].kind === '退入').length;
    lines.push('', `【${PROP_NAME[p]}】${list.length ? list.length + ' 間' + (prio ? `（優先 ${prio}）` : '') : '今天不用掃'}`);
    const fl = {};
    for (const r of list) (fl[floorOf(r)] ||= []).push(r);
    const order = { '退入': 0, '退房': 1, '續住': 2 };
    for (const f of Object.keys(fl)) {
      const items = fl[f].sort((a, b) => order[R[a].kind] - order[R[b].kind] || rooms.indexOf(a) - rooms.indexOf(b)).map((r) => {
        const x = R[r];
        const extra = [x.lateOut && '延退' + x.lateOut, x.earlyIn && '早入' + x.earlyIn, x.note].filter(Boolean).join(' ');
        return `${r} ${KIND_LABEL[x.kind]}${x.kind === '退入' ? '⭐' : ''}${extra ? `（${extra}）` : ''}`;
      });
      lines.push(`${f}F　${items.join('、')}`);
    }
  }
  lines.push('', '⭐ 優先：當天有客人入住', '出入房間請先敲門', 'https://eroom.yzprojecttw.com');
  return lines.join('\n').slice(0, 4900);
}

async function targets(env) {
  const t = {};
  for (const p of PROPS) t[p] = (await getS(env, 'line_target_' + p)) || '';
  return t;
}

async function pushDaily(env, { force = false, only = null } = {}) {
  const token = await getS(env, 'line_token');
  if (!token) throw new Error('還沒設定 LINE 金鑰');
  const tg = await targets(env);
  const date = twDate(Date.now());
  if (!force && (await getS(env, 'line_enabled')) !== '1') return { skipped: '每日推播已關閉' };
  const sent = [], skipped = [];
  for (const p of PROPS) {
    if (only && p !== only) continue;
    if (!tg[p]) { skipped.push(PROP_NAME[p] + '：沒有綁定群組'); continue; }
    if (!force && (await getS(env, 'line_last_' + p)) === date) { skipped.push(PROP_NAME[p] + '：今天已經傳過'); continue; }
    const text = await dailyText(env, date, [p]);
    await lineApi(token, 'message/push', { method: 'POST', body: JSON.stringify({ to: tg[p], messages: [{ type: 'text', text }] }) });
    if (!force) await setS(env, 'line_last_' + p, date);
    sent.push(PROP_NAME[p]);
  }
  if (!sent.length && force) throw new Error(skipped.join('；') || '沒有可傳送的群組');
  return { ok: true, date, sent, skipped };
}

async function line(sub, m, request, env, url) {
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
      if (!gid) continue;
      if (ev.type === 'leave') { delete gs[gid]; changed = true; for (const p of PROPS) if ((await getS(env, 'line_target_' + p)) === gid) await setS(env, 'line_target_' + p, ''); continue; }
      const text = ev.type === 'message' && ev.message?.type === 'text' ? (ev.message.text || '').trim() : '';
      if (ev.type !== 'join' && !/綁定|房務/.test(text)) continue;
      let name = gs[gid]?.name || '';
      if (token) { try { name = (await lineApi(token, 'group/' + gid + '/summary')).groupName || name; } catch {} }
      gs[gid] = { name, at: Date.now() }; changed = true;
      const tg = await targets(env);
      const boundTo = PROPS.filter((p) => tg[p] === gid);
      let msg;
      if (ev.type === 'join') {
        msg = '已連上 E·ROOM 房務。\n這個群組要收哪一館，請傳「綁定貳宿」或「綁定貳洋樓」。綁定後每天 10:50 會自動傳那一館今日要掃的房間。';
      } else if (/綁定/.test(text)) {
        const p = /洋樓/.test(text) ? 'eryanglou' : /貳宿|二宿/.test(text) ? 'ersu' : null;
        if (!p) msg = '請傳「綁定貳宿」或「綁定貳洋樓」。';
        else { await setS(env, 'line_target_' + p, gid); msg = `已綁定【${PROP_NAME[p]}】。每天 10:50 會傳${PROP_NAME[p]}今日要掃的房間，群組裡傳「房務」也可以隨時查。`; }
      } else {
        msg = await dailyText(env, twDate(Date.now()), boundTo.length ? boundTo : PROPS);
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

  // 以下需要管理員
  if (!(await isAdmin(env, request))) return bad('需要管理員密碼', 401);

  if (sub === 'config' && m === 'GET') {
    return json({
      hasSecret: !!(await getS(env, 'line_secret')), hasToken: !!(await getS(env, 'line_token')),
      groups: await groups(env), targets: await targets(env),
      enabled: (await getS(env, 'line_enabled')) === '1', last: { ersu: (await getS(env, 'line_last_ersu')) || '', eryanglou: (await getS(env, 'line_last_eryanglou')) || '' },
      webhook: url.origin + '/api/line/webhook',
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
    return json({ ok: true });
  }
  if (sub === 'preview' && m === 'GET') { const d = twDate(Date.now()); return json({ texts: { ersu: await dailyText(env, d, ['ersu']), eryanglou: await dailyText(env, d, ['eryanglou']) } }); }
  if (sub === 'test' && m === 'POST') {
    const b = await body(request);
    try { return json(await pushDaily(env, { force: true, only: PROPS.includes(b?.p) ? b.p : null })); } catch (e) { return bad(e.message); }
  }
  return bad('找不到', 404);
}
