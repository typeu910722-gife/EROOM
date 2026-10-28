// 打包前把網站、API、資料表定義從專案根目錄複製進來（雲端版和桌面版用同一份）
import { cpSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(join(root, 'public'), join(here, 'web'), { recursive: true });
copyFileSync(join(root, 'functions', 'api', '[[path]].js'), join(here, 'api.mjs'));
copyFileSync(join(root, 'schema.sql'), join(here, 'schema.sql'));
console.log('web、api.mjs、schema.sql 已更新');
