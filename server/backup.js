// Backups: consistent online copies (SQLite backup API) of the control database and every workspace, gzip + AES-256-GCM encrypted,
// optionally uploaded to any S3-compatible storage (AWS S3, Backblaze B2, Cloudflare R2, MinIO). Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { config } from './config.js';
import { zip } from './export.js';

const MAGIC = Buffer.from('BCBK1');
export function backupKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY; if (!raw) throw new Error('Set BACKUP_ENCRYPTION_KEY (32 bytes, hex). Without a key backups would be readable by anyone who finds them.');
  const b = /^[0-9a-f]{64}$/i.test(raw.trim()) ? Buffer.from(raw.trim(), 'hex') : Buffer.from(raw.trim(), 'base64'); if (b.length !== 32) throw new Error('The backup key must be 32 bytes (64 hex characters)'); return b;
}
/** file -> gzip -> AES-256-GCM. Layout: MAGIC | iv(12) | ciphertext | tag(16) */
export async function encryptFile(src, dst, key = backupKey()) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const out = fs.createWriteStream(dst); out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(fs.createReadStream(src), zlib.createGzip(), c, out, { end: false }); out.end(c.getAuthTag()); await new Promise((r) => out.on('close', r));
}
export async function decryptFile(src, dst, key = backupKey()) {
  const size = fs.statSync(src).size; if (size < MAGIC.length + 12 + 16) throw new Error('Backup file is too short');
  const fd = fs.openSync(src, 'r'); const head = Buffer.alloc(MAGIC.length + 12); const tag = Buffer.alloc(16); fs.readSync(fd, head, 0, head.length, 0); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a BizControl backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length)); d.setAuthTag(tag);
  try { await pipeline(fs.createReadStream(src, { start: head.length, end: size - 17 }), d, zlib.createGunzip(), fs.createWriteStream(dst)); }
  catch (e) { fs.rmSync(dst, { force: true }); throw new Error('Cannot decrypt this backup: wrong key or the file was altered (' + e.message + ')'); }
}

// ---------- S3 (Signature V4) ----------
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest(); const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function signV4({ method, url, headers = {}, body = '', region, service = 's3', accessKey, secretKey, date = new Date(), payloadHeader = true }) {
  const u = new URL(url); const amz = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = amz.slice(0, 8); const ph = sha(body);
  const h = { host: u.host, 'x-amz-date': amz, ...(payloadHeader ? { 'x-amz-content-sha256': ph } : {}), ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  const names = Object.keys(h).sort(); const canonHeaders = names.map((n) => `${n}:${h[n]}\n`).join(''); const signed = names.join(';');
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonPath = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
  const canon = [method, canonPath, query, canonHeaders, signed, ph].join('\n'); const scope = `${day}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request'); const signature = crypto.createHmac('sha256', k).update(sts).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
export function s3Config() {
  const e = process.env; if (!e.BACKUP_S3_BUCKET || !e.BACKUP_S3_ENDPOINT) return null;
  return { endpoint: e.BACKUP_S3_ENDPOINT.replace(/\/$/, ''), region: e.BACKUP_S3_REGION || 'auto', bucket: e.BACKUP_S3_BUCKET, accessKey: e.BACKUP_S3_ACCESS_KEY, secretKey: e.BACKUP_S3_SECRET_KEY };
}
async function s3(cfg, method, key, { body = '', query = '' } = {}) {
  const url = `${cfg.endpoint}/${cfg.bucket}/${key.split('/').map(enc).join('/')}${query ? '?' + query : ''}`; const headers = signV4({ method, url, body, region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  const res = await fetch(url, { method, headers, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(120_000) }); if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`S3 ${method} ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`); return res;
}
export const s3Put = (cfg, key, buf) => s3(cfg, 'PUT', key, { body: buf });
export const s3Get = async (cfg, key) => Buffer.from(await (await s3(cfg, 'GET', key)).arrayBuffer());
export const s3Delete = (cfg, key) => s3(cfg, 'DELETE', key);
export async function s3List(cfg, prefix) {
  const keys = []; let token = '';
  for (;;) { const q = `list-type=2&prefix=${enc(prefix)}${token ? '&continuation-token=' + enc(token) : ''}`; const xml = await (await s3(cfg, 'GET', '', { query: q })).text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&')); const nx = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml); if (!nx) break; token = nx[1]; }
  return keys;
}

// ---------- backup / restore ----------
const stamp = (d = new Date()) => d.toISOString().replace(/[:T]/g, '-').slice(0, 19);
async function snapshot(srcDb, dst) {      // consistent copy while the app keeps writing
  const db = new DatabaseSync(srcDb, { readOnly: true }); try { await sqliteBackup(db, dst); } finally { db.close(); }
  const chk = new DatabaseSync(dst, { readOnly: true }); const r = chk.prepare('PRAGMA integrity_check').get(); chk.close(); if (r.integrity_check !== 'ok') throw new Error('integrity check failed: ' + r.integrity_check);
}
export async function backupAll({ dir, keepDays = Number(process.env.BACKUP_KEEP_DAYS || 30), log = console.log } = {}) {
  const key = backupKey(); const cfg = s3Config(); const st = stamp(); const root = path.join(dir, st); fs.mkdirSync(path.join(root, 'tenants'), { recursive: true }); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcbk-'));
  const manifest = { created_at: new Date().toISOString(), version: process.env.APP_VERSION || null, files: [], failed: [] };
  const put = async (rel, plain, meta) => { const out = path.join(root, rel + '.enc'); await encryptFile(plain, out, key); const buf = fs.readFileSync(out); manifest.files.push({ file: rel + '.enc', bytes: buf.length, sha256: sha(buf), ...meta }); if (cfg) await s3Put(cfg, `bizcontrol/${st}/${rel}.enc`, buf); };
  try {
    const items = [];
    if (config.saas) {
      const { cAll, control } = await import('./control.js'); control(); items.push({ rel: 'control.sqlite', src: config.controlDbPath, meta: { kind: 'control' } });
      for (const t of cAll("SELECT id, subdomain FROM tenants WHERE purged_at IS NULL")) { const f = path.join(config.tenantsDir, t.id + '.sqlite'); if (fs.existsSync(f)) items.push({ rel: `tenants/${t.id}.sqlite`, src: f, meta: { kind: 'tenant', tenant: t.id, subdomain: t.subdomain } }); }
    } else items.push({ rel: 'bizcontrol.sqlite', src: config.dbPath, meta: { kind: 'single' } });
    for (const it of items) {
      try { const plain = path.join(tmp, path.basename(it.rel)); await snapshot(it.src, plain); await put(it.rel, plain, it.meta); fs.rmSync(plain, { force: true });
        if (it.meta.kind === 'tenant') { const fd = path.join(config.tenantsDir, it.meta.tenant + '-files'); if (fs.existsSync(fd) && fs.readdirSync(fd).length) { const z = path.join(tmp, it.meta.tenant + '-files.zip'); fs.writeFileSync(z, zip(fs.readdirSync(fd).map((n) => [n, fs.readFileSync(path.join(fd, n))]))); await put(`tenants/${it.meta.tenant}-files.zip`, z, { kind: 'files', tenant: it.meta.tenant }); fs.rmSync(z, { force: true }); } } }
      catch (e) { manifest.failed.push({ file: it.rel, error: e.message }); log(`FAILED ${it.rel}: ${e.message}`); }
    }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 1)); if (cfg) await s3Put(cfg, `bizcontrol/${st}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
    // retention
    const cutoff = stamp(new Date(Date.now() - keepDays * 864e5));
    for (const d of fs.readdirSync(dir)) if (/^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d$/.test(d) && d < cutoff) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    if (cfg) for (const k of await s3List(cfg, 'bizcontrol/')) { const s = k.split('/')[1]; if (s && s < cutoff) await s3Delete(cfg, k); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  log(`Backup ${st}: ${manifest.files.length} files, ${manifest.failed.length} failed${cfg ? ', uploaded to S3' : ''}.`);
  return { stamp: st, root, manifest };
}
/** Restore ONE workspace from a backup folder into a new/overwritten tenant database. The app must not be writing to it (suspend it first). */
export async function restoreTenant({ from, tenant, key = backupKey(), force = false }) {
  const src = path.join(from, 'tenants', tenant + '.sqlite.enc'); if (!fs.existsSync(src)) throw new Error(`No backup of ${tenant} in ${from}`);
  const dst = path.join(config.tenantsDir, tenant + '.sqlite'); if (fs.existsSync(dst) && !force) throw new Error('The workspace database already exists. Pass force to replace it (the old file is kept as .before-restore).');
  fs.mkdirSync(config.tenantsDir, { recursive: true }); const tmp = dst + '.restoring'; await decryptFile(src, tmp, key);
  const chk = new DatabaseSync(tmp, { readOnly: true }); const r = chk.prepare('PRAGMA integrity_check').get(); chk.close(); if (r.integrity_check !== 'ok') { fs.rmSync(tmp); throw new Error('Restored file failed its integrity check'); }
  if (fs.existsSync(dst)) fs.renameSync(dst, dst + '.before-restore'); for (const x of ['-wal', '-shm']) fs.rmSync(dst + x, { force: true }); fs.renameSync(tmp, dst);
  const files = path.join(from, 'tenants', tenant + '-files.zip.enc'); if (fs.existsSync(files)) { const z = tmp + '.zip'; await decryptFile(files, z, key); fs.mkdirSync(path.join(config.tenantsDir, tenant + '-files'), { recursive: true }); fs.writeFileSync(path.join(config.tenantsDir, tenant + '-files.restored.zip'), fs.readFileSync(z)); fs.rmSync(z); }
  return dst;
}
