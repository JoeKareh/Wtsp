// Per-tenant secrets (WhatsApp credentials, optional SMTP) encrypted at rest with AES-256-GCM; never returned by any API.
import { allSettings, setSettings } from './db.js';
import { encryptJson, decryptJson } from './crypto.js';
import { randomToken } from './crypto.js';

export const getSecrets = () => decryptJson(allSettings().integrations_enc);
export function setSecrets(patch) {
  const cur = getSecrets(); const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') continue; if (v === null) delete next[k]; else next[k] = v; }   // '' keeps the stored value, null clears it
  setSettings({ integrations_enc: encryptJson(next) }); return next;
}
/** The verify token is not a secret from Meta, but we still keep it with the other credentials. Generated once. */
export function verifyToken() { const s = getSecrets(); if (s.wa_verify_token) return s.wa_verify_token; const t = 'vt_' + randomToken(16); setSecrets({ wa_verify_token: t }); return t; }
export const maskSecrets = (s) => ({ wa_token: !!s.wa_token, wa_phone_number_id: s.wa_phone_number_id || null, wa_waba_id: s.wa_waba_id || null, wa_app_secret: !!s.wa_app_secret, smtp: s.smtp?.host ? { host: s.smtp.host, port: s.smtp.port, user: s.smtp.user, from: s.smtp.from, security: s.smtp.security } : null });
