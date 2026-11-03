// Super-admin (admin.<APP_DOMAIN>): separate auth, mandatory TOTP, tenant operations, support sessions, platform metrics.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { GET, POST, PUT, DELETE, parseCookies, isHttps, raw, redirect } from './http.js';
import { cAll, cGet, cRun, cTx, paudit, tenantRow, planById, planByCode, listPlans, control } from './control.js';
import { withTenant, get, run, audit, tenantFile, closeTenant, closeIdle } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt, hashToken, randomToken, safeEqual } from './crypto.js';
import { hashPassword, verifyPassword, createSession, checkPassword } from './auth.js';
import * as totp from './totp.js';
import { setTenantStatus, purgeTenant, effectiveStatus, purgeDays, addD, DELETE_AFTER_DAYS } from './lifecycle.js';
import { allow } from './ratelimit.js';
import { HttpError, bad, nowIso, safeJson, notFound, str, oneOf, int } from './util.js';

const A = (extra = {}) => ({ perm: 'admin', scope: 'admin', ...extra });
const PUB = { perm: 'public', scope: 'admin' };
const SID = (req) => (isHttps(req) ? '__Host-asid' : 'asid');
const readAsid = (req) => { const c = parseCookies(req.headers.cookie); return c['__Host-asid'] || c.asid; };
const ADMIN_HOURS = 8;

export function adminResolver(req) {
  const tok = readAsid(req); if (!tok) return null;
  const id = hashToken(tok); const s = cGet('SELECT * FROM admin_sessions WHERE id=?', id);
  if (!s || s.expires_at < nowIso()) return null;
  const a = cGet('SELECT * FROM admin_users WHERE id=? AND active=1', s.admin_id); if (!a) return null;
  return { admin: { id: a.id, email: a.email, name: a.name }, session: { id } };
}

/** Create a super-admin with mandatory TOTP. Returns what must be shown ONCE to the operator. */
export function createAdmin(email, name, password) {
  checkPassword(password); const secret = totp.newSecret();
  const recovery = Array.from({ length: 8 }, () => randomToken(5));
  cRun('INSERT INTO admin_users(email,name,password_hash,totp_secret_enc,recovery,created_at) VALUES (?,?,?,?,?,?)', email.toLowerCase(), name, hashPassword(password), encrypt(secret), JSON.stringify(recovery.map(hashToken)), nowIso());
  paudit('cli', 'admin_created', null, { email });
  return { secret, uri: totp.otpauth(email, secret, process.env.PLATFORM_NAME || 'BizControl'), recovery };
}

POST('/api/admin/login', PUB, (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase(); const key = ctx.ip + '|' + email;
  const fails = `adminfails:${key}`;
  const a = cGet('SELECT * FROM admin_users WHERE email=? AND active=1', email);
  const pwOk = a ? verifyPassword(String(ctx.body.password || ''), a.password_hash) : (verifyPassword('x', 'scrypt$00$00'), false);
  let ok = false; let step = 0;
  if (a && pwOk) {
    const codeIn = String(ctx.body.code || '').trim();
    const st = totp.verify(decrypt(a.totp_secret_enc), codeIn, a.totp_last_step);
    if (st) { ok = true; step = st; }
    else { const rec = safeJson(a.recovery, []); const h = hashToken(codeIn.toLowerCase()); const i = rec.findIndex((x) => safeEqual(x, h)); if (codeIn && i >= 0) { rec.splice(i, 1); cRun('UPDATE admin_users SET recovery=? WHERE id=?', JSON.stringify(rec), a.id); ok = true; } }
  }
  if (!throttleOk(fails, ok)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  if (!ok) { paudit(email || 'unknown', 'admin_login_failed', null, null, ctx.ip); throw new HttpError(401, 'Incorrect email, password or code'); }
  const tok = randomToken(32);
  cRun('INSERT INTO admin_sessions(id,admin_id,created_at,expires_at,last_seen,ip) VALUES (?,?,?,?,?,?)', hashToken(tok), a.id, nowIso(), new Date(Date.now() + ADMIN_HOURS * 3600e3).toISOString(), nowIso(), ctx.ip);
  if (step) cRun('UPDATE admin_users SET totp_last_step=?, last_login_at=? WHERE id=?', step, nowIso(), a.id); else cRun('UPDATE admin_users SET last_login_at=? WHERE id=?', nowIso(), a.id);
  ctx.setCookies.push(`${SID(ctx.req)}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_HOURS * 3600}${isHttps(ctx.req) ? '; Secure' : ''}`);
  paudit(a.email, 'admin_login', null, null, ctx.ip);
  return { ok: true, admin: { email: a.email, name: a.name } };
});
const failMap = new Map();
export const resetAdminThrottle = () => failMap.clear();   // used by tests
function throttleOk(key, success) {
  const now = Date.now(); const a = (failMap.get(key) || []).filter((t) => now - t < 15 * 60_000);
  if (a.length >= 5) { failMap.set(key, a); return false; }
  if (success) failMap.delete(key); else { a.push(now); failMap.set(key, a); }
  return true;
}
POST('/api/admin/logout', A(), (ctx) => { cRun('DELETE FROM admin_sessions WHERE id=?', ctx.adminSession.id); ctx.setCookies.push(`${SID(ctx.req)}=; Max-Age=0; Path=/`); return { ok: true }; });
GET('/api/admin/me', A(), (ctx) => ctx.admin);

// ---------- tenants ----------
const shapeTenant = (t) => { const a = cGet('SELECT email,name,country,billing_route FROM accounts WHERE id=?', t.account_id); const p = t.plan_id ? planById(t.plan_id) : null;
  return { id: t.id, subdomain: t.subdomain, url: config.tenantUrl(t.subdomain), business_name: t.business_name, status: t.status, effective_status: effectiveStatus(t), plan: p?.code || null, interval: t.billing_interval, owner_email: a?.email, owner_name: a?.name, country: a?.country, billing_route: a?.billing_route,
    created_at: t.created_at, verified_at: t.verified_at, trial_ends_at: t.trial_ends_at, grace_ends_at: t.grace_ends_at, paid_through: t.paid_through, delete_after: t.delete_after, purge_after: t.purge_after, purged_at: t.purged_at, last_activity_at: t.last_activity_at, order_count: t.order_count, db_bytes: t.db_bytes, stats_at: t.stats_at, disabled_reason: t.disabled_reason, suspended_reason: t.suspended_reason, flags: safeJson(t.flags, {}) }; };
GET('/api/admin/tenants', A(), (ctx) => {
  const w = ['1=1']; const p = []; const q = ctx.query;
  if (q.status) { w.push('t.status=?'); p.push(q.status); }
  if (q.q) { w.push('(t.subdomain LIKE ? OR t.business_name LIKE ? OR a.email LIKE ?)'); const l = `%${String(q.q).replace(/[%_\\]/g, '')}%`; p.push(l, l, l); }
  const limit = Math.min(Number(q.limit) || 100, 500); const offset = Number(q.offset) || 0;
  const rows = cAll(`SELECT t.* FROM tenants t JOIN accounts a ON a.id=t.account_id WHERE ${w.join(' AND ')} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map(shapeTenant);
  return { total: cGet(`SELECT COUNT(*) c FROM tenants t JOIN accounts a ON a.id=t.account_id WHERE ${w.join(' AND ')}`, ...p).c, rows };
});
GET('/api/admin/tenants/:id', A(), (ctx) => {
  const t = tenantRow(ctx.params.id); if (!t) throw notFound('Tenant');
  return { tenant: shapeTenant(t), subscriptions: cAll('SELECT * FROM subscriptions WHERE tenant_id=? ORDER BY id DESC', t.id), invoices: cAll('SELECT * FROM invoices WHERE tenant_id=? ORDER BY id DESC', t.id), audit: cAll('SELECT * FROM platform_audit WHERE tenant_id=? ORDER BY id DESC LIMIT 100', t.id), surveys: cAll('SELECT * FROM surveys WHERE tenant_id=? ORDER BY id DESC', t.id) };
});
const need = (ctx) => { const t = tenantRow(ctx.params.id); if (!t) throw notFound('Tenant'); if (t.purged_at) throw bad('This workspace was purged'); return t; };
POST('/api/admin/tenants/:id/suspend', A(), (ctx) => { const t = need(ctx); setTenantStatus(t.id, 'suspended', { suspended_reason: str(ctx.body.reason, 'Reason', { max: 200 }) || 'admin' }, ctx.admin.email, ctx.body.reason); return shapeTenant(tenantRow(t.id)); });
POST('/api/admin/tenants/:id/unsuspend', A(), (ctx) => {
  const t = need(ctx); const paid = t.paid_through && Date.parse(t.paid_through + 'T23:59:59Z') > Date.now();
  const target = paid ? 'active' : 'trialing'; const fields = { suspended_reason: null, grace_ends_at: null };
  if (target === 'trialing' && (!t.trial_ends_at || Date.parse(t.trial_ends_at) < Date.now())) fields.trial_ends_at = addD(nowIso(), 7);   // an unsuspended workspace with no paid period gets a short window
  setTenantStatus(t.id, target, fields, ctx.admin.email, 'unsuspended'); return shapeTenant(tenantRow(t.id));
});
POST('/api/admin/tenants/:id/extend-trial', A(), (ctx) => {
  const t = need(ctx); const days = int(ctx.body.days, 'Days', { required: true, min: 1, max: 365 });
  const base = t.trial_ends_at && Date.parse(t.trial_ends_at) > Date.now() ? t.trial_ends_at : nowIso();
  setTenantStatus(t.id, 'trialing', { trial_ends_at: addD(base, days), suspended_reason: null }, ctx.admin.email, `trial +${days}d`); return shapeTenant(tenantRow(t.id));
});
POST('/api/admin/tenants/:id/plan', A(), (ctx) => {
  const t = need(ctx); const plan = planByCode(String(ctx.body.plan || '')); if (!plan) throw bad('Unknown plan');
  cRun('UPDATE tenants SET plan_id=?, billing_interval=? WHERE id=?', plan.id, oneOf(ctx.body.interval, 'Interval', ['month', 'year'], { def: t.billing_interval }), t.id); paudit(ctx.admin.email, 'plan_changed', t.id, { plan: plan.code }); return shapeTenant(tenantRow(t.id));
});
PUT('/api/admin/accounts/:id/route', A(), (ctx) => { const r = oneOf(ctx.body.billing_route, 'Route', ['paddle', 'manual', 'whish']); cRun('UPDATE accounts SET billing_route=? WHERE id=?', r, ctx.params.id); paudit(ctx.admin.email, 'billing_route', null, { account: ctx.params.id, route: r }); return { ok: true }; });
DELETE('/api/admin/tenants/:id', A(), (ctx) => { const t = need(ctx); setTenantStatus(t.id, 'deleted', { purge_after: addD(nowIso(), purgeDays()) }, ctx.admin.email, 'soft delete'); return { ok: true, purge_after: tenantRow(t.id).purge_after }; });
POST('/api/admin/tenants/:id/restore', A(), (ctx) => { const t = need(ctx); if (t.status !== 'deleted') throw bad('Not deleted'); setTenantStatus(t.id, 'suspended', { purge_after: null, suspended_reason: 'restored' }, ctx.admin.email, 'restored'); return shapeTenant(tenantRow(t.id)); });
POST('/api/admin/tenants/:id/purge', A(), (ctx) => { const t = need(ctx); if (ctx.body.confirm !== t.subdomain) throw bad('Type the workspace address to confirm'); if (t.status !== 'deleted') throw bad('Soft-delete the workspace first'); purgeTenant(t.id, ctx.admin.email); return { ok: true }; });

// ---------- support sessions (impersonation) ----------
// Never assumes the owner's identity silently: a separate, short-lived, flagged session, read-only unless explicitly allowed.
POST('/api/admin/tenants/:id/impersonate', A(), (ctx) => {
  const t = need(ctx); if (t.status === 'deleted') throw bad('Deleted workspace');
  const tok = randomToken(24);
  cRun('INSERT INTO tokens(token_hash,kind,tenant_id,data,expires_at) VALUES (?,?,?,?,?)', hashToken(tok), 'impersonate', t.id, JSON.stringify({ admin: ctx.admin.email, readonly: ctx.body.write !== true }), new Date(Date.now() + 60_000).toISOString());
  paudit(ctx.admin.email, 'impersonation_requested', t.id, { readonly: ctx.body.write !== true, reason: str(ctx.body.reason, 'Reason', { max: 200 }) }, ctx.ip);
  return { url: config.tenantUrl(t.subdomain, '/api/support/enter?token=' + tok), expires_in_seconds: 60, readonly: ctx.body.write !== true };
});
// tenant side: consume the one-time token. The token is bound to ONE tenant id, checked against the host the request arrived on.
GET('/api/support/enter', { perm: 'public', lifecycle: 'always' }, (ctx) => {
  const row = cGet('SELECT * FROM tokens WHERE token_hash=? AND kind=?', hashToken(String(ctx.query.token || '')), 'impersonate');
  if (!row || row.used_at || row.expires_at < nowIso() || row.tenant_id !== ctx.tenant?.id) throw new HttpError(403, 'This support link is invalid or has expired');
  cRun('UPDATE tokens SET used_at=? WHERE token_hash=?', nowIso(), row.token_hash);
  const d = safeJson(row.data, {}); const owner = get("SELECT u.id, u.name FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='OWNER' AND u.active=1 ORDER BY u.id LIMIT 1");
  if (!owner) throw new HttpError(409, 'This workspace has no active owner');
  createSession(ctx, owner.id, { expires: new Date(Date.now() + 30 * 60_000).toISOString(), impersonator: d.admin, readonly: d.readonly });
  audit({ id: owner.id, name: 'Support: ' + d.admin, ip: ctx.ip }, 'support_session_start', 'user', owner.id, null, { readonly: d.readonly }, 'Platform support accessed this workspace');
  paudit(d.admin, 'impersonation_started', ctx.tenant.id, { readonly: d.readonly }, ctx.ip);
  return redirect('/');
});

// ---------- metrics, plans, operations ----------
export function platformMetrics() {
  const rows = cAll('SELECT * FROM tenants WHERE purged_at IS NULL'); const now = Date.now(); const byStatus = {};
  let mrr = 0; let active = 0; let expiring = 0;
  for (const t of rows) {
    const st = effectiveStatus(t); byStatus[st] = (byStatus[st] || 0) + 1;
    if ((st === 'active' || st === 'past_due') && t.plan_id && !safeJson(t.flags, {}).demo) { const p = planById(t.plan_id); mrr += t.billing_interval === 'year' ? Math.round(p.price_annual / 12) : p.price_monthly; active++; }
    if (st === 'trialing' && t.trial_ends_at && Date.parse(t.trial_ends_at) - now < 7 * 864e5) expiring++;
  }
  const since = (d) => new Date(now - d * 864e5).toISOString();
  const canceled30 = cGet("SELECT COUNT(*) c FROM tenants WHERE canceled_at > ?", since(30)).c;
  const activeStart = Math.max(1, active + canceled30);
  return { tenants: rows.length, by_status: byStatus, paying: active, mrr_cents: mrr, arr_cents: mrr * 12, signups_7d: cGet('SELECT COUNT(*) c FROM tenants WHERE created_at > ?', since(7)).c, signups_30d: cGet('SELECT COUNT(*) c FROM tenants WHERE created_at > ?', since(30)).c, trials_expiring_7d: expiring, canceled_30d: canceled30, churn_30d_pct: Math.round((canceled30 / activeStart) * 1000) / 10, db_bytes_total: rows.reduce((a, t) => a + (t.db_bytes || 0), 0), currency: 'USD' };
}
GET('/api/admin/metrics', A(), () => platformMetrics());
GET('/api/admin/plans', A(), () => listPlans(false));
PUT('/api/admin/plans/:id', A(), (ctx) => {
  const p = planById(ctx.params.id); if (!p) throw notFound('Plan'); const b = ctx.body;
  const limits = { ...p.limits, ...(b.limits || {}) }; const features = { ...p.features, ...(b.features || {}) };
  for (const v of Object.values(limits)) if (!Number.isInteger(v) || v < 0) throw bad('Limits must be whole numbers ≥ 0');
  cRun('UPDATE plans SET name=?, price_monthly=?, price_annual=?, limits=?, features=?, paddle_price_monthly=?, paddle_price_annual=?, active=? WHERE id=?', str(b.name ?? p.name, 'Name', { required: true, max: 40 }), int(b.price_monthly ?? p.price_monthly, 'Monthly price', { min: 0 }), int(b.price_annual ?? p.price_annual, 'Annual price', { min: 0 }), JSON.stringify(limits), JSON.stringify(features), b.paddle_price_monthly ?? p.paddle_price_monthly, b.paddle_price_annual ?? p.paddle_price_annual, b.active === false ? 0 : 1, p.id);
  paudit(ctx.admin.email, 'plan_edited', null, { plan: p.code, price_monthly: b.price_monthly }); return planById(p.id);
});
GET('/api/admin/audit', A(), (ctx) => ({ rows: cAll(`SELECT * FROM platform_audit ${ctx.query.tenant ? 'WHERE tenant_id=?' : ''} ORDER BY id DESC LIMIT 200`, ...(ctx.query.tenant ? [ctx.query.tenant] : [])) }));
GET('/api/admin/outbox', A(), () => ({ rows: cAll('SELECT id,kind,to_addr,subject,status,error,created_at,sent_at FROM platform_outbox ORDER BY id DESC LIMIT 100') }));
POST('/api/admin/stats/refresh', A(), () => ({ updated: refreshTenantStats() }));
POST('/api/admin/lifecycle/run', A(), async () => (await import('./lifecycle.js')).runLifecycle());

/** Hourly: order count, last activity, database size per tenant (so the admin list never opens tenant databases on demand). */
export function refreshTenantStats() {
  let n = 0;
  for (const t of cAll("SELECT id FROM tenants WHERE purged_at IS NULL AND status<>'deleted'")) {
    try {
      const f = tenantFile(t.id); if (!fs.existsSync(f)) continue;
      const bytes = [f, f + '-wal'].reduce((a, x) => a + (fs.existsSync(x) ? fs.statSync(x).size : 0), 0);
      const st = withTenant(t.id, () => ({ orders: get('SELECT COUNT(*) c FROM orders').c, last: get('SELECT MAX(x) m FROM (SELECT MAX(last_seen) x FROM sessions UNION ALL SELECT MAX(at) FROM audit_logs)').m }));
      cRun('UPDATE tenants SET order_count=?, last_activity_at=?, db_bytes=?, stats_at=? WHERE id=?', st.orders, st.last, bytes, nowIso(), t.id); n++;
    } catch (e) { cRun('UPDATE tenants SET stats_at=? WHERE id=?', nowIso(), t.id); }
  }
  closeIdle(0); return n;
}

// Prometheus-style metrics for the operator only (admin session OR bearer METRICS_TOKEN)
GET('/metrics', { perm: 'public', scope: 'admin' }, async (ctx) => {
  const bearer = String(ctx.req.headers.authorization || '').replace(/^Bearer /, ''); const tokenOk = process.env.METRICS_TOKEN && safeEqual(bearer, process.env.METRICS_TOKEN);
  if (!tokenOk && !adminResolver(ctx.req)) throw new HttpError(401, 'Unauthorized');
  const { metrics } = await import('./http.js'); const { poolStats } = await import('./db.js'); const m = platformMetrics(); const ps = poolStats();
  const L = [];
  const g = (n, v, help) => { L.push(`# HELP ${n} ${help}`, `# TYPE ${n} gauge`, `${n} ${v}`); };
  g('bizcontrol_requests_total', metrics.requests, 'Requests handled'); g('bizcontrol_requests_inflight', metrics.inflight, 'In-flight requests');
  for (const [c, v] of Object.entries(metrics.byClass)) L.push(`bizcontrol_responses_total{class="${c}"} ${v}`);
  g('bizcontrol_request_ms_sum', metrics.sumMs, 'Total request time (ms)');
  g('bizcontrol_tenant_pool_open', ps.open, 'Open tenant connections'); g('bizcontrol_tenants_failed', ps.failed.length, 'Tenants disabled by failed migration');
  for (const [s, v] of Object.entries(m.by_status)) L.push(`bizcontrol_tenants{status="${s}"} ${v}`);
  g('bizcontrol_mrr_cents', m.mrr_cents, 'Monthly recurring revenue (USD cents)'); g('bizcontrol_db_bytes_total', m.db_bytes_total, 'Total tenant database bytes');
  g('bizcontrol_process_rss_bytes', process.memoryUsage().rss, 'Resident memory');
  return raw(L.join('\n') + '\n', 'text/plain; version=0.0.4');
});
