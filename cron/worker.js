// eroom-cron：Cloudflare Worker
// Cron「30 2 * * *」（台灣 10:30）→ /api/line/check：還沒登記就私訊提醒管理員
// Cron「50 2 * * *」（台灣 10:50）→ /api/line/daily：傳今日要掃到各館群組
// CRON_KEY 為 secret（同 D1 settings.cron_key）
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, event.cron === '30 2 * * *' ? 'check' : 'daily'));
  },
  async fetch() {
    return new Response('eroom-cron', { status: 200 });
  },
};
async function run(env, what) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://eroom-app.pages.dev/api/line/' + what, { method: 'POST', headers: { 'x-cron-key': env.CRON_KEY } });
    if (r.ok || r.status === 401) return;
    await new Promise((s) => setTimeout(s, 20000));
  }
}
