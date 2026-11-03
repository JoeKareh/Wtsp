// Provider-independent billing logic: activating a plan, invoices (gap-free numbers), receipts, past-due and cancellation transitions.
import { cGet, cAll, cRun, cTx, cCounter, planById, planByCode, paudit, tenantRow } from '../control.js';
import { setTenantStatus, GRACE_DAYS, DELETE_AFTER_DAYS, addD } from '../lifecycle.js';
import { sendPlatformEmail } from '../platformmail.js';
import { invoicePdf, fmtMoney } from '../invoice.js';
import { config } from '../config.js';
import { nowIso, safeJson } from '../util.js';
import { withTenant, allSettings } from '../db.js';

/** Calendar months added to a date string (YYYY-MM-DD), clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsISO(date, n) { const d = new Date(date + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); }
export const today = () => new Date().toISOString().slice(0, 10);
const acct = (t) => cGet('SELECT * FROM accounts WHERE id=?', t.account_id);
const links = (t) => config.tenantUrl(t.subdomain, '/#/billing');

/** Make a workspace active on a plan through `paidThrough` (YYYY-MM-DD). Clears every lapse / cancel marker. Idempotent. */
export function activate(tenantId, { planId, interval, paidThrough, actor = 'billing', detail }) {
  const t = tenantRow(tenantId); if (!t) throw new Error('Unknown tenant');
  const flags = safeJson(t.flags, {}); delete flags.cancel_at_period_end;
  setTenantStatus(tenantId, 'active', { plan_id: planId ?? t.plan_id, billing_interval: interval || t.billing_interval, paid_through: paidThrough, grace_ends_at: null, suspended_reason: null, canceled_at: null, delete_after: null, flags: JSON.stringify(flags) }, actor, detail || `active through ${paidThrough}`);
  return tenantRow(tenantId);
}
export function invoiceNumber() { const y = new Date().getFullYear(); return `INV-${y}-${String(cCounter('invoice-' + y)).padStart(6, '0')}`; }
/** Create an invoice; (provider, provider_ref) makes it idempotent. Returns { invoice, created }. */
export function issueInvoice({ tenantId, provider, providerRef, description, amountCents, taxCents = 0, currency = 'USD', periodStart = null, periodEnd = null, method = null, reference = null, status = 'paid' }) {
  if (providerRef) { const ex = cGet('SELECT * FROM invoices WHERE provider=? AND provider_ref=?', provider, providerRef); if (ex) return { invoice: ex, created: false }; }
  const number = invoiceNumber();
  const id = cRun('INSERT INTO invoices(tenant_id,number,provider,provider_ref,description,amount_cents,tax_cents,currency,status,period_start,period_end,issued_at,method,reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', tenantId, number, provider, providerRef, description, amountCents, taxCents, currency, status, periodStart, periodEnd, nowIso(), method, reference).lastInsertRowid;
  return { invoice: cGet('SELECT * FROM invoices WHERE id=?', id), created: true };
}
export function renderInvoicePdf(invoice) {
  const t = tenantRow(invoice.tenant_id); const a = acct(t); let logo = null;
  try { logo = withTenant(t.id, () => allSettings().logo || null, t); } catch { /* workspace unavailable: no logo */ }
  return invoicePdf({ invoice, account: a, tenant: t, lang: a?.language === 'ar' ? 'ar' : 'en', logo });
}
export function emailReceipt(invoice) {
  const t = tenantRow(invoice.tenant_id); const a = acct(t); if (!a) return;
  const pdf = renderInvoicePdf(invoice);
  sendPlatformEmail('receipt', a.email, { name: a.name, business: t.business_name, invoice: invoice.number, amount: fmtMoney(invoice.amount_cents, invoice.currency), plan: invoice.description, date: t.paid_through, url: links(t) }, a.language || 'en', [{ filename: `${invoice.number}.pdf`, type: 'application/pdf', content: pdf }]);
}
export function markPastDue(tenantId, actor = 'billing', detail = 'payment failed') {
  const t = tenantRow(tenantId); if (!t || ['canceled', 'deleted', 'suspended'].includes(t.status)) return;
  const grace = t.status === 'past_due' && t.grace_ends_at ? t.grace_ends_at : addD(nowIso(), GRACE_DAYS);
  setTenantStatus(tenantId, 'past_due', { grace_ends_at: grace }, actor, detail);
  const a = acct(t); if (a && t.status !== 'past_due') sendPlatformEmail('payment_failed', a.email, { name: a.name, business: t.business_name, date: grace.slice(0, 10), url: links(t) }, a.language || 'en');
}
/** Cancel: the workspace stays usable until `atPeriodEnd` (if given) and is then read-only; data is deleted DELETE_AFTER_DAYS after cancellation. */
export function markCanceled(tenantId, { actor = 'billing', immediate = true, deleteInDays = DELETE_AFTER_DAYS, reason = null } = {}) {
  const t = tenantRow(tenantId); if (!t || t.status === 'deleted') return;
  setTenantStatus(tenantId, 'canceled', { canceled_at: nowIso(), delete_after: addD(nowIso(), deleteInDays), grace_ends_at: null, cancel_reason: reason }, actor, 'canceled');
}
export function prepaidDiscount(months) { return { 1: 0, 3: 0.05, 6: 0.1 }[months] ?? 0; }
/** Prepaid price for N months. 12 months uses the plan's annual price (two months free). */
export function prepaidQuote(plan, months) { const amount = months === 12 ? plan.price_annual : Math.round(plan.price_monthly * months * (1 - prepaidDiscount(months))); return { months, amount_cents: amount, currency: plan.currency, per_month_cents: Math.round(amount / months), saving_pct: Math.round((1 - amount / (plan.price_monthly * months)) * 100) }; }
export const PREPAID_MONTHS = [1, 3, 6, 12];
export { planById, planByCode, cGet, cAll, cRun, cTx, paudit, tenantRow };
