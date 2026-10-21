// eroom-cron：每天台灣時間 10:50（UTC 02:50）呼叫 E·ROOM 傳送今日要掃到 LINE 群組
// Cloudflare Worker，Cron Trigger「50 2 * * *」；CRON_KEY 為 secret（同 D1 settings.cron_key）
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch() {
    return new Response('eroom-cron', { status: 200 });
  },
};
async function run(env) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://eroom-app.pages.dev/api/line/daily', { method: 'POST', headers: { 'x-cron-key': env.CRON_KEY } });
    if (r.ok || r.status === 401) return;
    await new Promise((s) => setTimeout(s, 20000));
  }
}
