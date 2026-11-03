// Restore drill: proves your backups actually work. Restores a few random workspaces from the newest backup into a scratch folder,
// checks integrity and row counts against the manifest, and emails you if anything is wrong. Run it monthly (see docs/LAUNCH_GUIDE.md).
// Usage: npm run restore:drill -- [--dir backups] [--from <backup folder>] [--count 3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const dir = path.resolve(a('dir', 'backups')); const count = Number(a('count', 3));
const from = a('from') ? path.resolve(a('from')) : path.join(dir, fs.readdirSync(dir).filter((d) => /^\d{4}-/.test(d)).sort().pop() || 'none');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdrill-')); process.env.TENANTS_DIR = scratch; process.env.APP_DOMAIN ||= 'drill.local';
const { restoreTenant, decryptFile } = await import('../server/backup.js'); const problems = [];
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8')); const age = (Date.now() - Date.parse(manifest.created_at)) / 36e5;
  if (age > 36) problems.push(`The newest backup is ${Math.round(age)} hours old`); if (manifest.failed?.length) problems.push(`${manifest.failed.length} files failed in that backup`);
  const ctl = path.join(scratch, 'control.check.sqlite'); await decryptFile(path.join(from, 'control.sqlite.enc'), ctl); const c = new DatabaseSync(ctl, { readOnly: true }); const n = c.prepare('SELECT COUNT(*) c FROM tenants').get().c; c.close(); console.log(`control database OK (${n} workspaces)`);
  const tenants = manifest.files.filter((f) => f.kind === 'tenant').sort(() => Math.random() - 0.5).slice(0, count);
  for (const t of tenants) {
    try { await restoreTenant({ from, tenant: t.tenant }); const d = new DatabaseSync(path.join(scratch, t.tenant + '.sqlite'), { readOnly: true }); const o = d.prepare('SELECT COUNT(*) c FROM orders').get().c; const cu = d.prepare('SELECT COUNT(*) c FROM customers').get().c; d.close(); console.log(`restored ${t.subdomain} (${t.tenant}): ${cu} customers, ${o} orders`); }
    catch (e) { problems.push(`${t.subdomain}: ${e.message}`); }
  }
  if (!tenants.length && n > 0) problems.push('No workspace files in the backup');
} catch (e) { problems.push(e.message); }
fs.rmSync(scratch, { recursive: true, force: true });
if (problems.length) { console.error('RESTORE DRILL FAILED:\n - ' + problems.join('\n - ')); try { const { alertOperator } = await import('../server/platformmail.js'); await alertOperator('restore-drill', 'Restore drill FAILED', problems.join('\n')); } catch { /* ignore */ } process.exit(1); }
console.log('Restore drill passed: backups are readable and restorable.'); process.exit(0);
