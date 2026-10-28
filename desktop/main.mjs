// E·ROOM 桌面版（Electron）
// 這台電腦當主機：跑本機網站（localhost:8787，Cloudflare Tunnel 接到 eroom.yzprojecttw.com）、
// 資料庫、LINE 推播排程、每日備份。關掉視窗會縮到右下角繼續跑。
import { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage, ipcMain, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { startCore, VERSION } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = createRequire(import.meta.url)('electron-updater');
const PORT = 8787;
const SITE = 'https://eroom.yzprojecttw.com';
const CLOUD = 'https://eroom-app.pages.dev';
const LOCAL = `http://localhost:${PORT}`;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('tw.yzproject.eroom');
const LOGIN_ARGS = ['--hidden'];
const hiddenStart = process.argv.includes('--hidden');
const dataDir = join(app.getPath('userData'), 'data');
mkdirSync(dataDir, { recursive: true });
const logFile = join(dataDir, 'eroom.log');
const log = (s) => { const line = `${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')} ${s}\n`; try { appendFileSync(logFile, line); } catch {} console.log(line.trim()); };
const cfgFile = join(dataDir, 'desktop.json');
let cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
const saveCfg = () => writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

let win = null, tray = null, core = null, quitting = false;
let state = { phase: 'starting', error: '', tunnel: null, update: '' };

// ---------- 視窗 ----------
const icon = () => nativeImage.createFromPath(join(here, 'icon.png'));
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 820, minWidth: 380, minHeight: 600, show: !hiddenStart, backgroundColor: '#12110e', icon: icon(), title: 'E·ROOM 房務',
    autoHideMenuBar: true, webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: false },
  });
  win.loadFile(join(here, 'splash.html'));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!cfg.toldTray) {
      cfg.toldTray = true; saveCfg();
      new Notification({ title: 'E·ROOM 還在背景執行', body: '網站、LINE 推播和備份會繼續運作。要完全關閉請在右下角圖示按右鍵 →「結束」。', icon: icon() }).show();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
const splash = (p, t) => win && !win.isDestroyed() && win.webContents.executeJavaScript(`window.setP && setP(${p}, ${JSON.stringify(t || '')})`).catch(() => {});
const showWin = () => { if (!win) return; win.show(); win.focus(); };
const goSite = () => win && win.loadURL(LOCAL + '/');
const goImport = (mode) => win && win.loadFile(join(here, 'import.html'), { query: { mode } });

// ---------- 啟動核心 ----------
const portBusy = async () => { try { const r = await fetch(LOCAL + '/api/ping', { signal: AbortSignal.timeout(1500) }); return r.ok ? (await r.json()) : { other: true }; } catch { return null; } };
async function boot() {
  splash(15, '準備資料庫⋯');
  const busy = await portBusy();
  if (busy) {
    // 舊的本機版（start.bat）還開著 → 先把資料搬過來
    state.phase = 'old-running'; refreshTray();
    log('8787 已被佔用' + (busy.local ? '（舊的本機版）' : ''));
    return goImport(busy.local ? 'old' : 'busy');
  }
  try {
    splash(45, '啟動本機網站⋯');
    core = await startCore({ dataDir, port: PORT, log, onState: refreshTray });
    state.phase = 'running'; state.error = '';
    splash(85, '檢查連線⋯');
    removeOldTask();
    refreshTray();
    if (!core.hasData() && !cfg.skipImport) return goImport('empty');
    splash(100, '完成');
    setTimeout(goSite, 300);
    checkTunnel();
  } catch (e) {
    state.phase = 'error'; state.error = e.message; refreshTray();
    log('啟動失敗 ' + e.stack);
    win && win.webContents.executeJavaScript(`window.fail && fail(${JSON.stringify('啟動失敗：' + e.message)})`).catch(() => {});
  }
}
// 等舊版關掉後自動接手
let waitTimer = null;
function waitForPortFree() {
  clearInterval(waitTimer);
  waitTimer = setInterval(async () => { if (!(await portBusy())) { clearInterval(waitTimer); win && win.loadFile(join(here, 'splash.html')); setTimeout(boot, 500); } }, 2000);
}
// 舊版 autostart.bat 建的開機排程（不移除的話開機時會跟桌面版搶 8787）
function removeOldTask() {
  if (process.platform !== 'win32' || cfg.oldTaskRemoved) return;
  execFile('schtasks', ['/delete', '/tn', 'EROOM', '/f'], (err, out, errOut) => {
    if (!err || /cannot find|找不到|does not exist|不存在/i.test(String(errOut))) { cfg.oldTaskRemoved = true; saveCfg(); log('舊的開機排程已移除或不存在'); }
    else { log('舊的開機排程移除失敗：' + String(errOut).trim()); state.oldTask = true; refreshTray(); }
  });
}
// 正式網址有沒有連到這台電腦
async function checkTunnel() {
  try { const r = await fetch(SITE + '/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(8000) }); const j = await r.json(); state.tunnel = !!j.local; }
  catch { state.tunnel = false; }
  refreshTray();
}
setInterval(checkTunnel, 10 * 60e3);

// ---------- 給 import.html / splash.html 用 ----------
ipcMain.handle('eroom:import', async (_e, { source, pw }) => {
  const base = source === 'cloud' ? CLOUD : LOCAL;
  if (core) { const counts = await core.importFrom(base, pw); return { ok: true, counts }; }
  // 核心還沒啟動（舊版佔著 8787）：先開一個暫時的核心在別的 port 收資料，搬完關掉
  const tmp = await startCore({ dataDir, port: 18787, log });
  try { const counts = await tmp.importFrom(base, pw); return { ok: true, counts }; } finally { await tmp.stop(); }
});
ipcMain.handle('eroom:wait-old', () => { waitForPortFree(); return true; });
ipcMain.handle('eroom:skip', () => { cfg.skipImport = true; saveCfg(); splash(100, '完成'); goSite(); checkTunnel(); return true; });
ipcMain.handle('eroom:go', () => { goSite(); checkTunnel(); return true; });
ipcMain.handle('eroom:retry', () => { win.loadFile(join(here, 'splash.html')); setTimeout(boot, 500); return true; });
ipcMain.handle('eroom:info', () => ({ version: VERSION, dataDir, phase: state.phase }));

// ---------- 右下角選單 ----------
function refreshTray() {
  if (!tray) return;
  const run = state.phase === 'running';
  const st = core ? core.stats() : null;
  const autostart = app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
  tray.setToolTip(`E·ROOM ${run ? '執行中' : state.phase === 'old-running' ? '等待舊版關閉' : '未啟動'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `E·ROOM 房務　v${VERSION}`, enabled: false },
    { label: run ? `● 本機網站執行中（${st.records} 筆房況）` : state.phase === 'old-running' ? '○ 等待舊版本機版關閉' : '○ 本機網站未啟動' + (state.error ? '：' + state.error : ''), enabled: false },
    { label: state.tunnel == null ? '　正式網址：檢查中' : state.tunnel ? '● eroom.yzprojecttw.com 已連到這台電腦' : '○ eroom.yzprojecttw.com 沒有連到這台電腦', enabled: false },
    ...(state.oldTask ? [{ label: '⚠️ 舊的開機排程還在：請在「工作排程器」刪除 EROOM', enabled: false }] : []),
    { type: 'separator' },
    { label: '打開 E·ROOM', click: showWin },
    { label: '用瀏覽器打開正式網址', click: () => shell.openExternal(SITE) },
    { type: 'separator' },
    { label: '開機自動啟動', type: 'checkbox', checked: autostart, click: (m) => { app.setLoginItemSettings({ openAtLogin: m.checked, args: LOGIN_ARGS }); refreshTray(); } },
    { label: '立即備份', enabled: run, click: () => { try { const n = core.backupNow(); new Notification({ title: '已備份', body: n, icon: icon() }).show(); } catch (e) { dialog.showErrorBox('備份失敗', e.message); } } },
    { label: '打開資料夾（資料、備份）', click: () => shell.openPath(dataDir) },
    { label: '從其他地方搬資料⋯', click: () => { showWin(); goImport('manual'); } },
    { type: 'separator' },
    { label: state.update || '檢查更新', enabled: !/下載中/.test(state.update), click: () => (state.update.startsWith('重新啟動') ? (quitting = true, autoUpdater.quitAndInstall(true, true)) : checkUpdates(true)) },
    { label: '結束（網站和 LINE 推播會停止）', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- 自動更新（GitHub Releases）----------
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let manualCheck = false;
autoUpdater.on('update-available', (i) => { state.update = `下載中：v${i.version}`; refreshTray(); });
autoUpdater.on('update-not-available', () => { state.update = ''; refreshTray(); if (manualCheck) dialog.showMessageBox({ message: `已經是最新版（v${VERSION}）` }); manualCheck = false; });
autoUpdater.on('update-downloaded', (i) => {
  state.update = `重新啟動以更新到 v${i.version}`; refreshTray();
  new Notification({ title: 'E·ROOM 有新版本', body: `v${i.version} 已下載。右下角選單按「重新啟動以更新」，或下次開機自動更新。`, icon: icon() }).show();
});
autoUpdater.on('error', (e) => { log('更新失敗 ' + e.message); state.update = ''; refreshTray(); if (manualCheck) dialog.showErrorBox('檢查更新失敗', e.message); manualCheck = false; });
function checkUpdates(manual) { if (!app.isPackaged) return; manualCheck = !!manual; autoUpdater.checkForUpdates().catch(() => {}); }

// ---------- 開始 ----------
app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async (e) => { if (core) { e.preventDefault(); const c = core; core = null; try { await c.stop(); } catch {} app.exit(0); } });
app.whenReady().then(() => {
  if (!cfg.autostartChosen) { try { app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS }); } catch {} cfg.autostartChosen = true; saveCfg(); }
  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.on('click', showWin);
  refreshTray();
  createWindow();
  win.webContents.once('did-finish-load', boot);
  setTimeout(() => checkUpdates(false), 15000);
  setInterval(() => checkUpdates(false), 6 * 3600e3);
});
app.on('window-all-closed', (e) => e.preventDefault());
