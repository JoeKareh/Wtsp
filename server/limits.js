// Plan limits & usage. Reading and exporting are NEVER blocked: only creating new users / orders / marketing messages is.
// Single-business mode (no tenant) has no limits.
import { get, run, all, allSettings, setSettings, currentTenantContext } from './db.js';
import { planById } from './control.js';
import { HttpError, todayStr } from './util.js';
import { notify } from './services/notifications.js';

export const period = () => todayStr(allSettings().timezone).slice(0, 7);
export function currentPlan() { const t = currentTenantContext()?.tenant; return t?.plan_id ? planById(t.plan_id) : null; }
export const hasFeature = (f) => { const p = currentPlan(); return !p || p.features?.[f] !== false; };   // no plan context => single-business mode => everything on
export function requireFeature(f, label) {
  if (hasFeature(f)) return;
  throw new HttpError(402, `${label} is not included in your plan. Upgrade to use it.`, { code: `feature_${f}`, upgrade: true });
}
export function used(metric) {
  if (metric === 'users') return get('SELECT COUNT(*) c FROM users WHERE active=1').c;
  return get('SELECT value FROM usage_counters WHERE period=? AND metric=?', period(), metric)?.value || 0;
}
export function bump(metric, n = 1) { run('INSERT INTO usage_counters(period,metric,value) VALUES (?,?,?) ON CONFLICT(period,metric) DO UPDATE SET value=value+excluded.value', period(), metric, n); }
const limitOf = (p, metric) => ({ users: p.limits.users, orders: p.limits.orders_month, wa_marketing: p.limits.wa_marketing_month, ai_credits: p.limits.ai_credits_month })[metric];
/** Hard ceiling: users and WhatsApp marketing messages stop at 100%; orders get a configurable grace (default +20%) with warnings first. */
export function ceiling(p, metric) { const l = limitOf(p, metric); return metric === 'orders' ? Math.floor(l * (1 + (p.limits.orders_grace_pct ?? 20) / 100)) : l; }

export function usageSummary() {
  const p = currentPlan(); if (!p) return null;
  const meters = {}; for (const m of ['users', 'orders', 'wa_marketing', 'ai_credits']) { const limit = limitOf(p, m); const u = used(m); meters[m] = { used: u, limit, pct: limit ? Math.round((u / limit) * 100) : (u ? 100 : 0), hard_limit: ceiling(p, m) }; }
  return { plan: p.code, period: period(), meters };
}
function warn(metric, level, u, limit) {   // once per period/metric/level
  const key = `${period()}:${metric}:${level}`; const warned = allSettings().usage_warned || {}; if (warned[key]) return;
  const w = { ...warned, [key]: 1 }; for (const k of Object.keys(w)) if (!k.startsWith(period())) delete w[k]; setSettings({ usage_warned: w });
  const label = { users: 'users', orders: 'orders this month', wa_marketing: 'WhatsApp marketing messages this month', ai_credits: 'AI credits this month' }[metric];
  notify({ type: 'usage_limit', severity: level === 100 ? 'critical' : 'warning', title: level === 100 ? `You reached your plan limit for ${label}` : `You have used ${Math.round((u / limit) * 100)}% of your ${label}`, body: 'Upgrade your plan in Billing to avoid interruption. Your data is never affected.', link: '#/billing', dedupe_key: `usage:${key}` });
}
/** Call BEFORE creating something. Throws 402 when at the hard ceiling; raises 80% / 100% warnings. `add` = how many are about to be created. */
export function enforce(metric, add = 1) {
  const p = currentPlan(); if (!p) return;
  const limit = limitOf(p, metric); if (limit === undefined) return; const hard = ceiling(p, metric); const u = used(metric);
  if (u + add > hard) throw new HttpError(402, { users: `Your plan allows ${limit} active users. Upgrade to add more.`, orders: `You have reached this month's order allowance (${limit} + ${p.limits.orders_grace_pct ?? 20}% grace). Upgrade your plan to keep creating orders. Existing data stays fully accessible.`, wa_marketing: 'You have used all WhatsApp marketing messages included in your plan this month.', ai_credits: 'You have used all AI credits included in your plan this month.' }[metric], { code: `limit_${metric}`, upgrade: true, used: u, limit });
  if (limit > 0) { if (u + add >= limit) warn(metric, 100, u + add, limit); else if (u + add >= limit * 0.8) warn(metric, 80, u + add, limit); }
}
/** Remaining allowance for a metric (Infinity when unlimited / single-business mode). */
export function remaining(metric) { const p = currentPlan(); if (!p) return Infinity; return Math.max(0, ceiling(p, metric) - used(metric)); }
