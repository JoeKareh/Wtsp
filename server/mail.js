// Minimal dependency-free SMTP client + email outbox.
import net from 'node:net';
import tls from 'node:tls';
import { config } from './config.js';
import crypto from 'node:crypto';
import { all, get, run, tenantKey, currentTenantContext, allSettings } from './db.js';
import { decryptJson } from './crypto.js';
import { nowIso } from './util.js';
import { log } from './log.js';

/** Effective SMTP settings: in SaaS mode the tenant's own SMTP if they added one, otherwise the platform sender. */
export function mailConfig() {
  if (!config.saas) return config.smtp();
  const own = decryptJson(allSettings().integrations_enc).smtp;
  if (own?.host) return { host: own.host, port: Number(own.port) || 587, user: own.user || '', pass: own.pass || '', from: own.from || own.user, security: own.security || 'starttls', own: true };
  return { ...config.platformSmtp(), own: false };
}
export const smtpConfigured = () => { const c = mailConfig(); return Boolean(c.host && c.from); };
const wrap76 = (b64) => (b64.match(/.{1,76}/g) || ['']).join('\r\n');
const b64s = (s) => wrap76(Buffer.from(s, 'utf8').toString('base64'));
/** Build an RFC 5322 message: text only, text+html, or with attachments. */
export function buildMessage({ from, to, subject, text, html, attachments = [], replyTo }) {
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${mime(subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@bizcontrol>`, 'MIME-Version: 1.0'];
  if (replyTo) head.push(`Reply-To: ${replyTo}`);
  const part = (type, body) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64s(body)].join('\r\n');
  let body; let ct;
  const alt = () => { const bd = 'alt_' + crypto.randomBytes(8).toString('hex'); return { ct: `multipart/alternative; boundary="${bd}"`, body: [`--${bd}`, part('text/plain', text), `--${bd}`, part('text/html', html), `--${bd}--`].join('\r\n') }; };
  if (attachments.length) {
    const bd = 'mix_' + crypto.randomBytes(8).toString('hex'); const inner = html ? alt() : { ct: 'text/plain; charset=utf-8', body: null };
    const first = html ? [`Content-Type: ${inner.ct}`, '', inner.body].join('\r\n') : part('text/plain', text);
    const atts = attachments.map((a) => [`Content-Type: ${a.type || 'application/octet-stream'}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.filename}"`, '', wrap76(Buffer.from(a.content).toString('base64'))].join('\r\n'));
    ct = `multipart/mixed; boundary="${bd}"`; body = [`--${bd}`, first, ...atts.flatMap((x) => [`--${bd}`, x]), `--${bd}--`].join('\r\n');
  } else if (html) { const a = alt(); ct = a.ct; body = a.body; } else { ct = 'text/plain; charset=utf-8'; body = b64s(text); head.push('Content-Transfer-Encoding: base64'); }
  return [...head, `Content-Type: ${ct}`, '', body, '.'].join('\r\n');
}

function connect({ host, port, security }) {
  return new Promise((resolve, reject) => {
    const s = security === 'ssl' ? tls.connect({ host, port, servername: host }, () => resolve(s)) : net.connect({ host, port }, () => resolve(s));
    s.once('error', reject); s.setTimeout(20000, () => s.destroy(new Error('SMTP timeout')));
  });
}
function wrap(sock) {
  const lines = []; let buf = ''; let pending = null; let error = null;
  sock.setEncoding('utf8');
  const pump = () => { if (pending && pending.try()) pending = null; };
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); } pump(); });
  sock.on('error', (e) => { error = e; if (pending) { pending.reject(e); pending = null; } });
  return {
    sock,
    read: () => new Promise((resolve, reject) => {
      const t = () => {
        if (error) { reject(error); return true; }
        const i = lines.findIndex((l) => /^\d{3} /.test(l));
        if (i < 0) return false;
        const got = lines.splice(0, i + 1); resolve({ code: Number(got[i].slice(0, 3)), text: got.join('\n') }); return true;
      };
      if (!t()) pending = { try: t, reject };
    }),
    write: (s) => sock.write(s + '\r\n'),
  };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export const mime = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export async function smtpSend(cfg, to, subject, text, extra = {}) {
  let conn = wrap(await connect(cfg));
  const expect = async (codes, label) => { const r = await conn.read(); if (!codes.includes(r.code)) throw new Error(`SMTP ${label} failed: ${r.text}`); return r; };
  const cmd = async (c, codes, label) => { conn.write(c); return expect(codes, label); };
  try {
    await expect([220], 'greeting');
    await cmd('EHLO bizcontrol.local', [250], 'EHLO');
    if (cfg.security === 'starttls') {
      await cmd('STARTTLS', [220], 'STARTTLS');
      const t = tls.connect({ socket: conn.sock, servername: cfg.host });
      await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
      conn = wrap(t);
      await cmd('EHLO bizcontrol.local', [250], 'EHLO');
    }
    if (cfg.user) await cmd('AUTH PLAIN ' + b64(`\0${cfg.user}\0${cfg.pass}`), [235], 'AUTH');
    await cmd(`MAIL FROM:<${cfg.from.replace(/.*<|>.*/g, '')}>`, [250], 'MAIL FROM');
    await cmd(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354], 'DATA');
    const msg = buildMessage({ from: cfg.from, to, subject, text, ...extra });
    conn.write(msg); await expect([250], 'message');
    conn.write('QUIT');
  } finally { conn.sock.destroy(); }
}

export function queueEmail({ to, subject, body, mode = 'immediate', notificationId = null }) {
  if (!to) return null;
  return run('INSERT INTO email_outbox(notification_id,to_addr,subject,body,mode,status,created_at) VALUES (?,?,?,?,?,?,?)',
    notificationId, to, subject, body, mode, 'pending', nowIso()).lastInsertRowid;
}

const flushing = new Set();
/** Send pending immediate emails. Emails are never silently dropped: failures are recorded with the error. */
export async function flushOutbox() {
  const key = tenantKey(); if (flushing.has(key)) return; flushing.add(key);
  try {
    const rows = all("SELECT * FROM email_outbox WHERE status='pending' AND mode='immediate' ORDER BY id LIMIT 25");
    for (const r of rows) {
      if (!smtpConfigured()) { run("UPDATE email_outbox SET status='skipped', error='SMTP is not configured (set SMTP_* variables)' WHERE id=?", r.id); continue; }
      try { await smtpSend(mailConfig(), r.to_addr, r.subject, r.body); run("UPDATE email_outbox SET status='sent', sent_at=? WHERE id=?", nowIso(), r.id); }
      catch (e) { log.warn('email failed', e.message); run("UPDATE email_outbox SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), r.id); }
    }
  } finally { flushing.delete(key); }
}
export const outboxStats = () => ({
  smtp_configured: smtpConfigured(),
  pending: get("SELECT COUNT(*) c FROM email_outbox WHERE status='pending'").c,
  failed: get("SELECT COUNT(*) c FROM email_outbox WHERE status IN ('failed','skipped')").c,
});
