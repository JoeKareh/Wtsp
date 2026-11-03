// Secrets at rest: AES-256-GCM with a key ring (supports rotation). Format: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url parts)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const b64 = (b) => Buffer.from(b).toString('base64url');
const fromB64 = (s) => Buffer.from(s, 'base64url');
const parseKey = (s) => { const t = s.trim(); const buf = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64'); if (buf.length !== 32) throw new Error('Encryption keys must be 32 bytes (64 hex chars or base64)'); return buf; };
const keyId = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);
let ring = null;
export function keyRing() {
  if (ring) return ring;
  let cur = process.env.APP_ENCRYPTION_KEY;
  if (!cur) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_ENCRYPTION_KEY is required in production (32 bytes, hex or base64). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    const f = path.join(config.dataDir, '.dev-encryption-key'); fs.mkdirSync(config.dataDir, { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    cur = fs.readFileSync(f, 'utf8');
  }
  const keys = [parseKey(cur), ...(process.env.APP_ENCRYPTION_KEY_OLD || '').split(',').filter((x) => x.trim()).map(parseKey)];
  ring = { current: keys[0], id: keyId(keys[0]), byId: new Map(keys.map((k) => [keyId(k), k])) };
  return ring;
}
export const resetKeyRing = () => { ring = null; };

export function encrypt(plain) {
  const r = keyRing(); const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', r.current, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', r.id, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}
export function decrypt(blob) {
  const [v, kid, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !ct) throw new Error('Unrecognised encrypted value');
  const key = keyRing().byId.get(kid); if (!key) throw new Error(`Encryption key ${kid} is not in the key ring (add it to APP_ENCRYPTION_KEY_OLD)`);
  const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64(iv)); d.setAuthTag(fromB64(tag));
  return Buffer.concat([d.update(fromB64(ct)), d.final()]).toString('utf8');
}
export const encryptJson = (o) => encrypt(JSON.stringify(o));
export const decryptJson = (s) => { if (!s) return {}; try { return JSON.parse(decrypt(s)); } catch (e) { if (/key ring/.test(e.message)) throw e; return {}; } };
/** True if the blob is not encrypted with the current key (needs re-encryption after a rotation). */
export const needsRotation = (blob) => Boolean(blob) && String(blob).split('.')[1] !== keyRing().id;
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
