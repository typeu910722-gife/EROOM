// 不開視窗、直接用 Node 跑桌面版核心（測試用）：node core-cli.mjs [資料夾]
import { startCore } from './core.mjs';
const c = await startCore({ dataDir: process.argv[2] || './.data', port: +(process.env.PORT || 8787) });
if (process.argv[3] === 'import') console.log(await c.importFrom(process.argv[4], process.argv[5]));
