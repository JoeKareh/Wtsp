import fs from 'node:fs';
import { all, run, allSettings, withTenant, closeIdle } from './db.js';
import { runChecks, sendDailyDigest } from './services/notifications.js';
import { processCampaigns } from './services/whatsapp.js';
import { processRecurringExpenses } from './services/expenses.js';
import { refreshAllCustomerStatuses } from './services/customers.js';
import { refreshRecommendations } from './services/recommendations.js';
import { flushOutbox } from './mail.js';
import { config } from './config.js';
import { nowIso } from './util.js';
import { log } from './log.js';

const timers = []; const inflight = new Set();
const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p; };
/** Wait for running jobs to finish (graceful shutdown). */
export const drainJobs = async (timeoutMs = 10_000) => { const t = Date.now(); while (inflight.size && Date.now() - t < timeoutMs) await Promise.race([...inflight, new Promise((r) => setTimeout(r, 200))]); return inflight.size; };

// ---- fair per-tenant execution ----
const cursors = new Map();
function limiter(n) { let active = 0; const q = []; const next = () => { if (active >= n || !q.length) return; active++; const { fn, res, rej } = q.shift(); fn().then(res, rej).finally(() => { active--; next(); }); }; return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); }); }
const capped = limiter(Number(process.env.JOB_CONCURRENCY || 3));   // global cap across all job types
const yieldLoop = () => new Promise((r) => setImmediate(r));

/**
 * Run fn(tenant) for every eligible tenant, inside that tenant's context.
 *  - rotates the starting tenant between ticks so nobody is permanently last
 *  - one tenant throwing never affects the others (onError / alert)
 *  - stops when the time budget is spent and resumes from the same spot next tick (a busy tenant cannot starve the rest)
 *  - yields to the event loop between tenants so web requests keep flowing
 */
export async function forEachTenant(name, fn, { onError, budgetMs = Number(process.env.JOB_BUDGET_MS || 3000), statuses = ['trialing', 'active', 'past_due'], filter } = {}) {
  const { cAll } = await import('./control.js'); const { safeJson } = await import('./util.js'); const { alertOperator } = await import('./platformmail.js');
  let list = cAll(`SELECT * FROM tenants WHERE status IN (${statuses.map(() => '?').join(',')}) AND purged_at IS NULL AND disabled_reason IS NULL ORDER BY id`, ...statuses);
  if (filter) list = list.filter((t) => filter(t, safeJson(t.flags, {})));
  if (!list.length) return 0;
  const start = (cursors.get(name) || 0) % list.length; const began = Date.now(); let done = 0;
  for (let i = 0; i < list.length; i++) {
    if (Date.now() - began > budgetMs && done > 0) { cursors.set(name, (start + i) % list.length); return done; }
    const t = list[(start + i) % list.length];
    await capped(async () => {
      try { await withTenant(t.id, () => fn(t), t); }
      catch (e) { if (onError) onError(t, e); else { log.error(`job ${name} failed for ${t.id}`, e); alertOperator('job:' + name, `Job "${name}" failed for tenant ${t.id}`, e.stack || e.message); } }
    });
    done++; await yieldLoop();
  }
  cursors.set(name, 0); return done;
}

const every = (ms, name, fn, { immediate = false, delay = 0 } = {}) => {
  const wrapped = () => track((async () => { try { await fn(); } catch (e) { log.error(`job ${name} failed:`, e.stack || e); import('./platformmail.js').then((m) => m.alertOperator('job:' + name, `Job "${name}" failed`, e.stack || e.message)).catch(() => {}); } })());
  if (immediate) setTimeout(wrapped, delay).unref();
  timers.push(setInterval(wrapped, ms).unref());
};

export function startJobs() {
  if (!config.saas) return startSingleTenantJobs();
  const T = (name, fn, opts) => () => forEachTenant(name, fn, opts);
  every(10_000, 'campaigns', T('campaigns', () => processCampaigns(), { filter: (t, f) => f.wa }));
  every(30_000, 'email', T('email', () => flushOutbox()));
  every(5 * 60_000, 'notification-checks', T('checks', () => runChecks()), { immediate: true, delay: 5000 });
  every(60 * 60_000, 'recurring-expenses', T('recurring', () => processRecurringExpenses()), { immediate: true, delay: 3000 });
  every(60 * 60_000, 'customer-status', T('custstatus', () => refreshAllCustomerStatuses()), { immediate: true, delay: 4000 });
  every(10 * 60_000, 'digest', T('digest', () => sendDailyDigest()));
  every(6 * 60 * 60_000, 'recommendations', T('reco', () => refreshRecommendations()), { immediate: true, delay: 8000 });
  every(60 * 60_000, 'cleanup', T('cleanup', () => cleanupTenant(), { statuses: ['trialing', 'active', 'past_due', 'suspended', 'canceled'] }));
  every(60 * 60_000, 'idle-connections', () => closeIdle(10 * 60_000));
  // platform-level
  every(15_000, 'platform-email', async () => (await import('./platformmail.js')).flushPlatformOutbox());
  every(6 * 60 * 60_000, 'lifecycle', async () => { const r = (await import('./lifecycle.js')).runLifecycle(); if (r.suspended || r.deleted || r.purged) log.info('lifecycle', r); }, { immediate: true, delay: 6000 });
  every(60 * 60_000, 'tenant-stats', async () => (await import('./admin.js')).refreshTenantStats(), { immediate: true, delay: 20_000 });
  every(10 * 60_000, 'disk-check', async () => { try { const s = fs.statfsSync(config.tenantsDir.replace(/[\\/]tenants$/, '') || '.'); const used = 100 - Math.round((s.bavail / s.blocks) * 100); if (used > 80) (await import('./platformmail.js')).alertOperator('disk', `Disk is ${used}% full`, 'Free space or grow the volume before the databases cannot write.'); } catch { /* statfs unavailable */ } }, { immediate: true, delay: 30_000 });
  every(24 * 60 * 60_000, 'demo-reset', async () => { const d = await import('./demo.js'); if (d.demoEnabled()) d.resetDemo(); });
  every(24 * 60 * 60_000, 'weekly-digest', T('weeklydigest', async () => (await import('./services/digest.js')).sendWeeklyDigest(), { filter: (t, f) => !f.demo }));
}
function cleanupTenant() {
  run('DELETE FROM sessions WHERE expires_at<?', nowIso());
  run('DELETE FROM password_resets WHERE expires_at<?', nowIso());
  run('DELETE FROM idempotency_keys WHERE created_at<?', new Date(Date.now() - 7 * 864e5).toISOString());
}
function startSingleTenantJobs() {
  every(10_000, 'campaigns', processCampaigns);
  every(30_000, 'email', flushOutbox);
  every(5 * 60_000, 'notification-checks', runChecks, { immediate: true, delay: 5000 });
  every(60 * 60_000, 'recurring-expenses', processRecurringExpenses, { immediate: true, delay: 3000 });
  every(60 * 60_000, 'customer-status', refreshAllCustomerStatuses, { immediate: true, delay: 4000 });
  every(10 * 60_000, 'digest', () => sendDailyDigest());
  every(6 * 60 * 60_000, 'recommendations', refreshRecommendations, { immediate: true, delay: 8000 });
  every(60 * 60_000, 'cleanup', cleanupTenant);
}
export const stopJobs = () => timers.forEach(clearInterval);
