// Restore one workspace from an encrypted backup. Usage: npm run restore:tenant -- --from backups/2026-11-03-02-00-00 --tenant t_0123456789abcdef [--force]
// 1) Suspend the workspace in the admin console first (so nobody writes while you restore).  2) Run this.  3) Reactivate.
import path from 'node:path';
import { restoreTenant } from '../server/backup.js';
const a = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };
if (!a('from') || !a('tenant')) { console.error('Usage: --from <backup folder> --tenant <t_...> [--force]'); process.exit(1); }
try { const f = await restoreTenant({ from: path.resolve(a('from')), tenant: a('tenant'), force: process.argv.includes('--force') }); console.log('Restored to', f); } catch (e) { console.error('Restore FAILED:', e.message); process.exit(1); }
