// Consistent online backup of the database (safe while the app is running) + uploaded attachments.
// Usage: npm run backup [-- --dir backups --keep 14]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const dir = path.resolve(arg('dir', path.join(config.root, 'backups'))); const keep = Number(arg('keep', 14));
if (!fs.existsSync(config.dbPath)) { console.error('Database not found: ' + config.dbPath); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = path.join(dir, `bizcontrol-${stamp}.sqlite`);
const db = new DatabaseSync(config.dbPath);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); db.close();
const chk = new DatabaseSync(out, { readOnly: true }); const r = chk.prepare('PRAGMA integrity_check').get(); chk.close();
if (r.integrity_check !== 'ok') { console.error('Backup failed integrity check: ' + r.integrity_check); process.exit(2); }
if (fs.existsSync(config.uploadsDir)) fs.cpSync(config.uploadsDir, path.join(dir, `uploads-${stamp}`), { recursive: true });
const olds = fs.readdirSync(dir).filter((f) => /^bizcontrol-.*\.sqlite$/.test(f)).sort().reverse().slice(keep);
for (const f of olds) { fs.rmSync(path.join(dir, f)); fs.rmSync(path.join(dir, f.replace('bizcontrol-', 'uploads-').replace('.sqlite', '')), { recursive: true, force: true }); }
console.log(`Backup written: ${out} (integrity ok). Kept the newest ${keep}.`);
