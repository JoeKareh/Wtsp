// Encrypted backup of the control database and every workspace. Usage: npm run backup:all -- [--dir /backups]
import path from 'node:path';
import { config } from '../server/config.js';
import { backupAll } from '../server/backup.js';
import { alertOperator } from '../server/platformmail.js';
const i = process.argv.indexOf('--dir'); const dir = path.resolve(i > 0 ? process.argv[i + 1] : path.join(config.root, 'backups'));
try { const r = await backupAll({ dir }); if (r.manifest.failed.length) { await alertOperator('backup', `Backup finished with ${r.manifest.failed.length} failures`, JSON.stringify(r.manifest.failed, null, 1)).catch(() => {}); process.exit(2); } }
catch (e) { console.error('Backup FAILED:', e.message); await alertOperator('backup', 'Backup failed', e.stack || e.message).catch(() => {}); process.exit(1); }
process.exit(0);
