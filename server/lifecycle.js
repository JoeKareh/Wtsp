// Tenant lifecycle: trialing -> active -> past_due -> suspended -> canceled -> deleted (soft) -> purged.
import fs from 'node:fs';
import path from 'node:path';
import { cAll, cGet, cRun, planById, paudit, tenantRow } from './control.js';
import { sendPlatformEmail } from './platformmail.js';
import { closeTenant, tenantFile } from './db.js';
import { config } from './config.js';
import { nowIso, safeJson, addDays } from './util.js';
import { log } from './log.js';

export const TRIAL_DAYS = 14; export const GRACE_DAYS = 7; export const DELETE_AFTER_DAYS = 60;
export const purgeDays = () => Number(process.env.PURGE_DAYS || 30);
const day = (d) => new Date(d).toISOString().slice(0, 10);
const addD = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString();

/** The state a request should see right now, computed lazily so a missed job tick can never keep a lapsed workspace open. */
export function effectiveStatus(t, now = Date.now()) {
  let st = t.status;
  if (st === 'trialing' && t.trial_ends_at && Date.parse(t.trial_ends_at) < now) st = 'suspended';
  if (st === 'active' && t.paid_through && Date.parse(t.paid_through + 'T23:59:59Z') < now) {
    st = Date.parse(addD(t.paid_through + 'T23:59:59Z', GRACE_DAYS)) < now ? 'suspended' : 'past_due';
  }
  if (st === 'past_due' && t.grace_ends_at && Date.parse(t.grace_ends_at) < now) st = 'suspended';
  return st;
}
const READ_ONLY = new Set(['suspended', 'canceled']);
/** Lifecycle gate for tenant API routes. Reads, exports, login and billing always work. */
export function gate(t, method, opts = {}) {
  const st = effectiveStatus(t); const read = method === 'GET' || method === 'HEAD';
  if (st === 'deleted') return { status: 410, code: 'deleted', message: 'This workspace has been deleted.' };
  if (st === 'pending_verification' && opts.lifecycle !== 'status') return { status: 403, code: 'verify_email', message: 'Please confirm your email address to activate this workspace.' };
  if (opts.lifecycle === 'always' || opts.lifecycle === 'status') return null;
  if (READ_ONLY.has(st) && !read) return { status: 402, code: 'read_only', message: st === 'canceled' ? 'This workspace was canceled and is read-only. You can export your data or reactivate it in Billing.' : 'Your workspace is read-only until the subscription is renewed. Your data is safe and can be exported at any time.' };
  return null;
}
export function workspaceInfo(t) {
  if (!t) return null;
  const st = effectiveStatus(t); const plan = t.plan_id ? planById(t.plan_id) : null;
  const left = t.trial_ends_at ? Math.max(0, Math.ceil((Date.parse(t.trial_ends_at) - Date.now()) / 864e5)) : null;
  return {
    state: st, stored_state: t.status, read_only: READ_ONLY.has(st), plan: plan && { code: plan.code, name: plan.name, limits: plan.limits, features: plan.features },
    trial_ends_at: t.trial_ends_at, trial_days_left: st === 'trialing' ? left : null, grace_ends_at: t.grace_ends_at, paid_through: t.paid_through, delete_after: t.delete_after,
    banner: st === 'trialing' ? { type: 'trial', days: left } : st === 'past_due' ? { type: 'past_due', until: t.grace_ends_at || addD(t.paid_through + 'T23:59:59Z', GRACE_DAYS) } : st === 'suspended' ? { type: 'suspended' } : st === 'canceled' ? { type: 'canceled', delete_after: t.delete_after } : null,
  };
}

export function setTenantStatus(id, status, fields = {}, actor = 'system', detail = null) {
  const cols = Object.keys(fields); const sets = ['status=?', ...cols.map((c) => `${c}=?`)];
  cRun(`UPDATE tenants SET ${sets.join(',')} WHERE id=?`, status, ...cols.map((c) => fields[c]), id);
  paudit(actor, `status:${status}`, id, detail);
}
const ownerOf = (t) => cGet('SELECT a.* FROM accounts a WHERE a.id=?', t.account_id);
const vars = (t, extra = {}) => { const a = ownerOf(t); return { name: a?.name || 'there', business: t.business_name, url: config.tenantUrl(t.subdomain, '/#/billing'), ...extra }; };
const mail = (kind, t, extra) => { const a = ownerOf(t); if (a) sendPlatformEmail(kind, a.email, vars(t, extra), a.language || 'en'); };
const marked = (t, key) => !!safeJson(t.reminders, {})[key];
const mark = (t, key) => { const r = safeJson(t.reminders, {}); r[key] = nowIso(); cRun('UPDATE tenants SET reminders=? WHERE id=?', JSON.stringify(r), t.id); t.reminders = JSON.stringify(r); };

/** Daily (and at startup) lapse engine. Idempotent: reminders are recorded so nothing is ever sent twice. */
export function runLifecycle(now = new Date()) {
  const n = now.getTime(); const out = { suspended: 0, past_due: 0, deleted: 0, purged: 0, emails: 0 };
  for (const t of cAll("SELECT * FROM tenants WHERE status NOT IN ('pending_verification') AND purged_at IS NULL")) {
    try {
      const flags = safeJson(t.flags, {}); if (flags.demo) continue;
      if (t.status === 'trialing' && t.trial_ends_at) {
        const started = Date.parse(t.trial_ends_at) - TRIAL_DAYS * 864e5; const d = Math.floor((n - started) / 864e5);
        for (const [key, at] of [['trial7', 7], ['trial12', 12], ['trial14', 14]]) if (d >= at && Date.parse(t.trial_ends_at) > n - 864e5 && !marked(t, key)) { mark(t, key); mail('trial_reminder', t, { left: Math.max(0, TRIAL_DAYS - at) }); out.emails++; }
        if (Date.parse(t.trial_ends_at) < n) { setTenantStatus(t.id, 'suspended', { suspended_reason: 'trial_expired' }, 'system', 'trial ended without a subscription'); mail('suspended', t, { reason: 'trial ended' }); out.suspended++; }
      } else if (t.status === 'active' && t.paid_through) {
        const left = Math.ceil((Date.parse(t.paid_through + 'T23:59:59Z') - n) / 864e5);
        const manual = cGet("SELECT 1 x FROM subscriptions WHERE tenant_id=? AND provider='paddle' AND status IN ('active','trialing','past_due')", t.id) ? false : true;
        if (manual) for (const [key, at] of [['renew7', 7], ['renew1', 1]]) if (left <= at && left >= 0 && !marked(t, key + t.paid_through)) { mark(t, key + t.paid_through); mail('renewal_reminder', t, { left, date: t.paid_through }); out.emails++; }
        if (Date.parse(t.paid_through + 'T23:59:59Z') < n) { const grace = addD(t.paid_through + 'T23:59:59Z', GRACE_DAYS); setTenantStatus(t.id, 'past_due', { grace_ends_at: grace }, 'system', 'paid-through date passed'); mail('payment_failed', t, { date: day(grace) }); out.past_due++; }
      } else if (t.status === 'past_due' && t.grace_ends_at && Date.parse(t.grace_ends_at) < n) {
        setTenantStatus(t.id, 'suspended', { suspended_reason: 'payment_overdue' }, 'system', 'grace period ended'); mail('suspended', t, { reason: 'payment overdue' }); out.suspended++;
      } else if (t.status === 'canceled' && t.delete_after) {
        const left = Math.ceil((Date.parse(t.delete_after) - n) / 864e5);
        for (const [key, at] of [['del14', 14], ['del3', 3]]) if (left <= at && left > 0 && !marked(t, key)) { mark(t, key); mail('deletion_warning', t, { date: day(t.delete_after) }); out.emails++; }
        if (left <= 0) { setTenantStatus(t.id, 'deleted', { purge_after: addD(now.toISOString(), purgeDays()) }, 'system', 'scheduled deletion reached'); out.deleted++; }
      }
    } catch (e) { log.error('lifecycle failed for ' + t.id, e); }
  }
  for (const t of cAll("SELECT * FROM tenants WHERE status='deleted' AND purged_at IS NULL AND purge_after IS NOT NULL AND purge_after < ?", now.toISOString())) { try { purgeTenant(t.id, 'system'); out.purged++; } catch (e) { log.error('purge failed ' + t.id, e); } }
  return out;
}
/** Irreversibly remove a tenant's files. Closes the pooled connection first (Windows cannot delete open files). */
export function purgeTenant(id, actor) {
  const t = tenantRow(id); if (!t) return false; if (!['deleted'].includes(t.status)) throw new Error('Only soft-deleted workspaces can be purged');
  closeTenant(id); const f = tenantFile(id);
  for (const x of [f, f + '-wal', f + '-shm']) fs.rmSync(x, { force: true });
  fs.rmSync(path.join(config.tenantsDir, id + '-files'), { recursive: true, force: true });
  cRun("UPDATE tenants SET purged_at=?, business_name='[deleted]', webhook_key=NULL WHERE id=?", nowIso(), id);
  paudit(actor, 'purged', id, 'tenant files removed'); return true;
}
export { addD };
