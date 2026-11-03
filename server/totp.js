// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with RFC 4648 base32. No dependency.
import crypto from 'node:crypto';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf) => { let bits = 0; let v = 0; let out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += ALPHA[(v << (5 - bits)) & 31]; return out; };
export const unbase32 = (s) => { let bits = 0; let v = 0; const out = []; for (const c of s.toUpperCase().replace(/[=\s]/g, '')) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error('bad base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
export const newSecret = () => base32(crypto.randomBytes(20));
export function code(secret, step) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', unbase32(secret)).update(b).digest(); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 30000);
/** Returns the matched time step (to reject replays) or null. Accepts +/- 1 step of clock drift. */
export function verify(secret, token, lastStep = 0, now = Date.now()) {
  const t = String(token || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(t)) return null;
  for (const d of [0, -1, 1]) { const st = currentStep(now) + d; if (st > lastStep && crypto.timingSafeEqual(Buffer.from(code(secret, st)), Buffer.from(t))) return st; }
  return null;
}
export const otpauth = (email, secret, issuer = 'BizControl') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
