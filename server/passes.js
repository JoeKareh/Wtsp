// Free passes: the operator can grant any workspace free access (days or unlimited) and create redeemable pass codes. Everything is audited.
import { GET, POST, DELETE } from './http.js';
import { cAll, cGet, cRun, paudit, tenantRow, planByCode } from './control.js';
import { setTenantStatus, addD } from './lifecycle.js';
import { HttpError, bad, nowIso, safeJson, notFound, str, int, oneOf } from './util.js';
import { randomToken, hashToken } from './crypto.js';
import { closeTenant } from './db.js';

const A = { perm: 'admin', scope: 'admin' };
const FOREVER = '2099-12-31';
const day = (d) => new Date(d).toISOString().slice(0, 10);

/** Give a workspace free access. days=null -> unlimited. */
export function grantPass(t, { plan, days, note, by }) {
  const p = planByCode(plan || 'growth'); if (!p) throw bad('Unknown plan');
  const until = days ? day(addD(Date.parse(t.paid_through || '') > Date.now() ? t.paid_through : nowIso(), days)) : FOREVER;
  const flags = { ...safeJson(t.flags, {}), comp: { until, note: note || null, by, at: nowIso() }, cancel_at_period_end: false };
  cRun('UPDATE tenants SET plan_id=? WHERE id=?', p.id, t.id);
  setTenantStatus(t.id, 'active', { paid_through: until, trial_ends_at: null, grace_ends_at: null, suspended_reason: null, delete_after: null, purge_after: null, flags: JSON.stringify(flags) }, by, `free pass ${days ? days + 'd' : 'unlimited'} (${p.code})`);
  return until;
}
export function revokePass(t, by) {
  const flags = safeJson(t.flags, {}); delete flags.comp;
  setTenantStatus(t.id, 'suspended', { paid_through: null, suspended_reason: 'pass_revoked', flags: JSON.stringify(flags) }, by, 'free pass revoked');
}
/** Redeem a pass code for a workspace (called when its email is verified). Returns true if applied. */
export function redeemCode(t, code) {
  const c = cGet('SELECT * FROM passes WHERE code=?', String(code).toUpperCase()); if (!c || !c.active || c.used >= c.max_uses || (c.expires_at && c.expires_at < nowIso())) return false;
  cRun('UPDATE passes SET used=used+1 WHERE code=?', c.code);
  grantPass(t, { plan: c.plan_code, days: c.unlimited ? null : c.days, note: 'code ' + c.code + (c.note ? ' – ' + c.note : ''), by: 'pass-code' });
  return true;
}
export function checkCode(code) {
  const c = cGet('SELECT * FROM passes WHERE code=?', String(code || '').toUpperCase());
  return Boolean(c && c.active && c.used < c.max_uses && !(c.expires_at && c.expires_at < nowIso()));
}

const need = (ctx) => { const t = tenantRow(ctx.params.id); if (!t) throw notFound('Tenant'); if (t.purged_at || t.status === 'deleted') throw bad('This workspace is deleted'); return t; };
POST('/api/admin/tenants/:id/grant', A, (ctx) => {
  const t = need(ctx); const unlimited = ctx.body.unlimited === true; const days = unlimited ? null : int(ctx.body.days, 'Days', { required: true, min: 1, max: 3650 });
  const until = grantPass(t, { plan: ctx.body.plan, days, note: str(ctx.body.note, 'Note', { max: 200 }), by: ctx.admin.email }); return { ok: true, free_until: until, unlimited };
});
POST('/api/admin/tenants/:id/revoke-pass', A, (ctx) => { const t = need(ctx); if (!safeJson(t.flags, {}).comp) throw bad('This workspace has no free pass'); revokePass(t, ctx.admin.email); return { ok: true }; });
// one device per account: raise/lower the limit, or sign everyone out
POST('/api/admin/tenants/:id/sessions', A, (ctx) => {
  const t = need(ctx); const max = int(ctx.body.max_sessions, 'Devices', { required: true, min: 1, max: 50 });
  const flags = { ...safeJson(t.flags, {}), max_sessions: max }; cRun('UPDATE tenants SET flags=? WHERE id=?', JSON.stringify(flags), t.id); paudit(ctx.admin.email, 'max_sessions', t.id, { max }); return { ok: true, max_sessions: max };
});
POST('/api/admin/tenants/:id/logout-all', A, async (ctx) => {
  const t = need(ctx); const { withTenant, run } = await import('./db.js'); withTenant(t.id, () => run('DELETE FROM sessions'), t); paudit(ctx.admin.email, 'logout_all', t.id); return { ok: true };
});
GET('/api/admin/passes', A, () => ({ rows: cAll('SELECT * FROM passes ORDER BY created_at DESC LIMIT 500') }));
POST('/api/admin/passes', A, (ctx) => {
  const b = ctx.body; const plan = planByCode(String(b.plan || 'growth')); if (!plan) throw bad('Unknown plan'); const unlimited = b.unlimited === true;
  const days = unlimited ? null : int(b.days, 'Days', { required: true, min: 1, max: 3650 }); const uses = int(b.max_uses ?? 1, 'Uses', { min: 1, max: 100000 });
  const code = (str(b.code, 'Code', { max: 24 }) || randomToken(5)).toUpperCase().replace(/[^A-Z0-9-]/g, ''); if (code.length < 4) throw bad('Code needs at least 4 letters or digits');
  if (cGet('SELECT 1 x FROM passes WHERE code=?', code)) throw new HttpError(409, 'That code already exists');
  cRun('INSERT INTO passes(code,plan_code,days,unlimited,max_uses,note,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', code, plan.code, days, unlimited ? 1 : 0, uses, str(b.note, 'Note', { max: 200 }) || null, b.expires_at ? String(b.expires_at) : null, ctx.admin.email, nowIso());
  paudit(ctx.admin.email, 'pass_created', null, { code, plan: plan.code, days, unlimited, uses }); return cGet('SELECT * FROM passes WHERE code=?', code);
});
DELETE('/api/admin/passes/:code', A, (ctx) => { cRun('UPDATE passes SET active=0 WHERE code=?', String(ctx.params.code).toUpperCase()); paudit(ctx.admin.email, 'pass_disabled', null, { code: ctx.params.code }); return { ok: true }; });
// overview of every customer account with what they pay
GET('/api/admin/customers', A, (ctx) => {
  const q = ctx.query.q ? `%${String(ctx.query.q).replace(/[%_\\]/g, '')}%` : null;
  const rows = cAll(`SELECT a.id, a.email, a.name, a.country, a.billing_route, a.created_at, a.email_verified_at,
      (SELECT COUNT(*) FROM tenants t WHERE t.account_id=a.id) AS workspaces,
      (SELECT COALESCE(SUM(i.amount_cents),0) FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE t.account_id=a.id AND i.status='paid') AS paid_cents
    FROM accounts a ${q ? 'WHERE a.email LIKE ? OR a.name LIKE ?' : ''} ORDER BY a.created_at DESC LIMIT 500`, ...(q ? [q, q] : []));
  return { rows };
});
void hashToken; void closeTenant; void oneOf;
