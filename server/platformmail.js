// Platform-level email (verification, billing, lifecycle). Queued in the control plane, sent by a job; never blocks a request.
import { cAll, cRun, cGet } from './control.js';
import { render } from './emails.js';
import { config } from './config.js';
import { smtpSend } from './mail.js';
import { nowIso } from './util.js';
import { log } from './log.js';

export function sendPlatformEmail(kind, to, vars, lang = 'en', attachments = []) {
  if (!to) return null;
  const m = render(kind, vars, lang);
  const id = cRun('INSERT INTO platform_outbox(kind,to_addr,subject,text,html,attachments,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
    kind, to, m.subject, m.text, m.html, attachments.length ? JSON.stringify(attachments.map((a) => ({ filename: a.filename, type: a.type, b64: Buffer.from(a.content).toString('base64') }))) : null, 'pending', nowIso()).lastInsertRowid;
  setImmediate(() => flushPlatformOutbox().catch(() => {}));
  return id;
}
let flushing = false;
export async function flushPlatformOutbox() {
  if (flushing) return; flushing = true;
  try {
    const cfg = config.platformSmtp();
    for (const r of cAll("SELECT * FROM platform_outbox WHERE status='pending' ORDER BY id LIMIT 25")) {
      if (!cfg.host || !cfg.from) { cRun("UPDATE platform_outbox SET status='skipped', error='Platform SMTP is not configured (PLATFORM_SMTP_*)' WHERE id=?", r.id); log.warn('platform email not sent (SMTP not configured)', { to: r.to_addr, subject: r.subject }); continue; }
      try {
        const atts = r.attachments ? JSON.parse(r.attachments).map((a) => ({ filename: a.filename, type: a.type, content: Buffer.from(a.b64, 'base64') })) : [];
        await smtpSend(cfg, r.to_addr, r.subject, r.text, { html: r.html, attachments: atts });
        cRun("UPDATE platform_outbox SET status='sent', sent_at=? WHERE id=?", nowIso(), r.id);
      } catch (e) { cRun("UPDATE platform_outbox SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), r.id); }
    }
  } finally { flushing = false; }
}
/** Operator alerts (job failures, failed migrations, disk, backups, webhooks): throttled to one email per key per hour. */
export function alertOperator(key, title, body) {
  log.error('ALERT ' + title, { key, body });
  const to = process.env.ALERT_EMAIL; if (!to) return;
  const last = cGet('SELECT at FROM alerts_sent WHERE key=?', key);
  if (last && Date.now() - Date.parse(last.at) < 3600e3) return;
  cRun('INSERT INTO alerts_sent(key,at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at', key, nowIso());
  sendPlatformEmail('alert', to, { title, body });
}
