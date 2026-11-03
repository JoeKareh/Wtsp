// Restore the database from a backup file. STOP THE APP FIRST.
// Usage: npm run restore -- --file backups/bizcontrol-2025-01-01-02-00-00.sqlite [--uploads backups/uploads-...] [--yes]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const file = arg('file'); if (!file || !fs.existsSync(file)) { console.error('Usage: npm run restore -- --file <backup.sqlite> [--uploads <dir>] --yes'); process.exit(1); }
if (!process.argv.includes('--yes')) { console.error(`This will REPLACE ${config.dbPath} with ${file}.\nStop the app first, then re-run with --yes to confirm.`); process.exit(1); }
let ic; let tables;
try {
  const chk = new DatabaseSync(file, { readOnly: true });
  ic = chk.prepare('PRAGMA integrity_check').get().integrity_check;
  tables = chk.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('orders','customers','payments','business_settings')").get().c; chk.close();
} catch (e) { ic = e.message; tables = 0; }
if (ic !== 'ok' || tables !== 4) { console.error('That file is not a healthy BizControl backup (integrity: ' + ic + ', core tables: ' + tables + '/4). Nothing was changed.'); process.exit(2); }
fs.mkdirSync(config.dataDir, { recursive: true });
if (fs.existsSync(config.dbPath)) { const safety = config.dbPath + '.before-restore-' + Date.now(); fs.copyFileSync(config.dbPath, safety); console.log('Current database saved as ' + safety); }
for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
fs.copyFileSync(file, config.dbPath);
const up = arg('uploads'); if (up && fs.existsSync(up)) { fs.rmSync(config.uploadsDir, { recursive: true, force: true }); fs.cpSync(up, config.uploadsDir, { recursive: true }); console.log('Attachments restored.'); }
console.log('Restore complete. Start the app again.');
