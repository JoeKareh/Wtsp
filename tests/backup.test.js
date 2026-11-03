import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { bootSaas, makeTenant } from './saas-helpers.js';

let S; let B; let srv; const KEY = crypto.randomBytes(32).toString('hex'); let tmp;
before(async () => { S = await bootSaas({ BACKUP_ENCRYPTION_KEY: KEY }); B = await import('../server/backup.js'); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); });
after(async () => { srv?.closeAllConnections?.(); srv?.close(); await S?.close(); });

describe('backup encryption', () => {
  test('round-trips, is not readable without the key, and detects tampering', async () => {
    const src = path.join(tmp, 'a.bin'); fs.writeFileSync(src, Buffer.concat([Buffer.from('SECRET-CUSTOMER-LIST'), crypto.randomBytes(200_000)]));
    await B.encryptFile(src, src + '.enc'); assert.ok(!fs.readFileSync(src + '.enc').includes('SECRET-CUSTOMER-LIST')); await B.decryptFile(src + '.enc', src + '.out'); assert.ok(fs.readFileSync(src).equals(fs.readFileSync(src + '.out')));
    await assert.rejects(B.decryptFile(src + '.enc', src + '.bad', crypto.randomBytes(32)), /wrong key or the file was altered/); assert.ok(!fs.existsSync(src + '.bad'), 'no partial plaintext left behind');
    const buf = fs.readFileSync(src + '.enc'); buf[buf.length >> 1] ^= 1; fs.writeFileSync(src + '.tam', buf); await assert.rejects(B.decryptFile(src + '.tam', src + '.t2'), /altered/);
  });
  test('AWS Signature V4 matches the published AWS test vector (get-vanilla)', () => {
    const h = B.signV4({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z'), payloadHeader: false });
    assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
});

describe('backup all -> restore', () => {
  test('backs up every workspace + control, uploads to S3 with signed requests, restores one workspace, drill passes, retention prunes', async () => {
    const a = await makeTenant(S, { business_name: 'Alpha' }); const b = await makeTenant(S, { business_name: 'Beta' });
    for (let i = 0; i < 3; i++) await a.c.ok('POST', '/api/customers', { name: 'Cust ' + i, phone: '7100000' + i }); await b.c.ok('POST', '/api/customers', { name: 'Only B', phone: '70999999' });
    // fake S3
    const store = new Map(); let unsigned = 0;
    srv = http.createServer((req, res) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*host.*x-amz-date.*, Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) unsigned++;
      const u = new URL(req.url, 'http://x'); const key = decodeURIComponent(u.pathname.replace(/^\/bkt\/?/, ''));
      if (req.method === 'PUT') { store.set(key, Buffer.concat(chunks)); res.end(); } else if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); res.end(); }
      else if (u.searchParams.get('list-type')) { const p = u.searchParams.get('prefix') || ''; res.end(`<ListBucketResult>${[...store.keys()].filter((k) => k.startsWith(p)).map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`); }
      else { const v = store.get(key); if (!v) { res.writeHead(404); res.end(); } else res.end(v); } }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    Object.assign(process.env, { BACKUP_S3_ENDPOINT: `http://127.0.0.1:${srv.address().port}`, BACKUP_S3_BUCKET: 'bkt', BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SK', BACKUP_S3_REGION: 'auto' });
    // a stale backup that retention must remove (locally and in S3)
    const dir = path.join(tmp, 'bk'); fs.mkdirSync(path.join(dir, '2020-01-01-00-00-00'), { recursive: true }); store.set('bizcontrol/2020-01-01-00-00-00/manifest.json', Buffer.from('{}'));
    const r = await B.backupAll({ dir, keepDays: 30, log: () => {} }); assert.equal(r.manifest.failed.length, 0); assert.equal(unsigned, 0, 'every S3 request was signed');
    assert.ok(r.manifest.files.some((f) => f.kind === 'control') && r.manifest.files.filter((f) => f.kind === 'tenant').length >= 2);
    assert.ok(!fs.existsSync(path.join(dir, '2020-01-01-00-00-00')), 'old local backup pruned'); assert.ok(![...store.keys()].some((k) => k.includes('2020-01-01')), 'old S3 backup pruned');
    assert.ok([...store.keys()].some((k) => k.endsWith(`tenants/${a.id}.sqlite.enc`)), 'uploaded');
    for (const buf of store.values()) assert.ok(!buf.includes('Cust 1'), 'nothing readable in the cloud copy');
    // disaster: Alpha's database is damaged -> restore only Alpha, Beta is untouched
    S.db.closeAllTenants(); const af = path.join(process.env.TENANTS_DIR, a.id + '.sqlite'); fs.writeFileSync(af, 'garbage'); for (const x of ['-wal', '-shm']) fs.rmSync(af + x, { force: true });
    await assert.rejects(B.restoreTenant({ from: r.root, tenant: a.id }), /already exists/); await B.restoreTenant({ from: r.root, tenant: a.id, force: true }); assert.ok(fs.existsSync(af + '.before-restore'));
    S.db.clearTenantFailure?.(a.id); const d = new DatabaseSync(af, { readOnly: true }); assert.equal(d.prepare('SELECT COUNT(*) c FROM customers').get().c, 3); d.close();
    assert.equal((await a.c.ok('GET', '/api/customers')).total, 3);
    assert.equal((await b.c.ok('GET', '/api/customers')).total, 1);
    // drill (separate process, like the monthly job)
    const drill = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/restore-drill.js', '--from', r.root, '--count', '5'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env }, encoding: 'utf8' });
    assert.equal(drill.status, 0, drill.stdout + drill.stderr); assert.match(drill.stdout, /Restore drill passed/); assert.match(drill.stdout, /restored Alpha|restored t/i);
    // a wrong key makes the drill fail loudly
    const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/restore-drill.js', '--from', r.root], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') }, encoding: 'utf8' }); assert.equal(bad.status, 1); assert.match(bad.stderr, /DRILL FAILED/);
  });
});
