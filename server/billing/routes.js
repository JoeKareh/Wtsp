import { GET, POST, PUT, route, raw, reply } from '../http.js';
import { cAll, cGet, cRun, listPlans, planByCode, planById, paudit, tenantRow } from '../control.js';
import { paddle } from './paddle.js';
import { manual } from './manual.js';
import { whish } from './whish.js';
import { markCanceled, prepaidQuote, PREPAID_MONTHS, renderInvoicePdf } from './core.js';
import { workspaceInfo, DELETE_AFTER_DAYS } from '../lifecycle.js';
import { usageSummary } from '../limits.js';
import { currentTenantContext, audit } from '../db.js';
import { sendPlatformEmail } from '../platformmail.js';
import { config } from '../config.js';
import { HttpError, bad, oneOf, str, safeJson, notFound } from '../util.js';
import { allow } from '../ratelimit.js';

const B = { perm: 'users:manage', lifecycle: 'always' };      // owner only; must keep working when the workspace is read-only
const ctxTenant = () => currentTenantContext().tenant;
const acct = (t) => cGet('SELECT * FROM accounts WHERE id=?', t.account_id);
const providers = { paddle, manual, whish };
const routeOptions = (a) => (a.country === 'LB' ? ['manual', 'paddle'] : ['paddle']);
export const manualInstructions = () => process.env.MANUAL_PAYMENT_INSTRUCTIONS || 'Pay by bank transfer, Whish Money or OMT using the details we send you by email, then press "I have paid". We activate your plan as soon as the payment is confirmed.';

GET('/api/billing/summary', B, () => {
  const t = tenantRow(ctxTenant().id); const a = acct(t); const plans = listPlans();
  return {
    workspace: workspaceInfo(t), route: a.billing_route, route_options: routeOptions(a), country: a.country, plans: plans.map((p) => ({ code: p.code, name: p.name, price_monthly: p.price_monthly, price_annual: p.price_annual, currency: p.currency, limits: p.limits, features: p.features, prepaid: PREPAID_MONTHS.map((m) => prepaidQuote(p, m)) })),
    usage: usageSummary(), subscription: cGet("SELECT provider, provider_ref, status, interval, current_period_end, cancel_at FROM subscriptions WHERE tenant_id=? ORDER BY id DESC LIMIT 1", t.id) || null,
    invoices: cAll('SELECT number, description, amount_cents, tax_cents, currency, status, issued_at, method, period_start, period_end FROM invoices WHERE tenant_id=? ORDER BY id DESC', t.id),
    card: { enabled: Boolean(process.env.PADDLE_CLIENT_TOKEN), env: process.env.PADDLE_ENV || 'sandbox' }, manual: { instructions: manualInstructions() }, whish_enabled: whish.enabled(), delete_after_days: DELETE_AFTER_DAYS,
  };
});
PUT('/api/billing/route', B, (ctx) => {
  const t = tenantRow(ctxTenant().id); const a = acct(t); const r = oneOf(ctx.body.route, 'Route', ['paddle', 'manual']);
  if (!routeOptions(a).includes(r)) throw bad('That payment method is not available for your country. Contact support if you need it.');
  cRun('UPDATE accounts SET billing_route=? WHERE id=?', r, a.id); paudit('tenant:' + t.subdomain, 'billing_route', t.id, { route: r }); audit(ctx.user, 'update', 'billing_route', null, { route: a.billing_route }, { route: r }); return { route: r };
});
POST('/api/billing/checkout', B, (ctx) => {
  const t = tenantRow(ctxTenant().id); const a = acct(t); const plan = planByCode(String(ctx.body.plan || '')); if (!plan || !plan.active) throw bad('Choose a plan');
  const interval = oneOf(ctx.body.interval, 'Interval', ['month', 'year'], { def: 'month' });
  if (a.billing_route === 'manual') return { provider: 'manual', plan: plan.code, instructions: manualInstructions(), quotes: manual.quotes(plan), reference_hint: `${t.subdomain}-${plan.code}` };
  if (a.billing_route === 'whish') return whish.createCheckout();
  return paddle.createCheckout({ tenant: t, account: a, plan, interval });
});
/** Manual-pay customers tell us they paid: we get an email with everything needed to confirm and record it. Nothing is activated automatically. */
POST('/api/billing/manual-request', B, (ctx) => {
  if (!allow('manualreq:' + ctxTenant().id, 10, 3600e3)) throw new HttpError(429, 'Too many requests');
  const t = tenantRow(ctxTenant().id); const a = acct(t); const plan = planByCode(String(ctx.body.plan || '')); if (!plan) throw bad('Choose a plan'); const months = Number(ctx.body.months);
  if (!PREPAID_MONTHS.includes(months)) throw bad('Choose 1, 3, 6 or 12 months');
  const q = prepaidQuote(plan, months); const reference = str(ctx.body.reference, 'Payment reference', { max: 100 }); const note = str(ctx.body.note, 'Note', { max: 500 });
  paudit('tenant:' + t.subdomain, 'manual_payment_claimed', t.id, { plan: plan.code, months, amount_cents: q.amount_cents, reference, note });
  const to = process.env.SUPPORT_EMAIL || process.env.ALERT_EMAIL; if (to) sendPlatformEmail('support', to, { subject: `Manual payment claimed: ${t.subdomain}`, email: a.email, tenant: t.id, message: `${t.business_name} says they paid for ${plan.name} x ${months} months (${(q.amount_cents / 100).toFixed(2)} ${q.currency}). Reference: ${reference || '-'}. Note: ${note || '-'}\nRecord it in the admin panel to activate.`, errors: [] }, 'en');
  return { ok: true, message: 'Thank you. We will confirm your payment and activate your plan shortly. You will receive a receipt by email.' };
});
POST('/api/billing/portal', B, async () => { const t = tenantRow(ctxTenant().id); const a = acct(t); if (a.billing_route !== 'paddle') return { url: null, message: 'You pay by bank transfer / Whish: there is no card to update. Send your next payment before the paid-through date.' }; return { url: await paddle.customerPortalUrl(t, a) }; });
POST('/api/billing/change-plan', B, async (ctx) => {
  const t = tenantRow(ctxTenant().id); const a = acct(t); const plan = planByCode(String(ctx.body.plan || '')); if (!plan || !plan.active) throw bad('Choose a plan'); const interval = oneOf(ctx.body.interval, 'Interval', ['month', 'year'], { def: 'month' });
  if (a.billing_route === 'paddle' && cGet("SELECT 1 x FROM subscriptions WHERE tenant_id=? AND provider='paddle' AND status IN ('active','trialing','past_due')", t.id)) { await paddle.changePlan(t, plan, interval); audit(ctx.user, 'update', 'plan_change_requested', null, null, { plan: plan.code, interval }); return { ok: true, message: 'Plan change requested. It is applied as soon as the payment provider confirms it.' }; }
  return { ok: false, needs_checkout: true, message: 'Choose how to pay for the new plan.' };
});
POST('/api/billing/cancel', B, async (ctx) => {
  const t = tenantRow(ctxTenant().id); const a = acct(t); const reason = str(ctx.body.reason, 'Reason', { max: 500 }); const eraseNow = ctx.body.delete_my_data === true;
  cRun('INSERT INTO surveys(tenant_id,kind,answer,created_at) VALUES (?,?,?,?)', t.id, 'cancel_reason', reason || '(no answer)', new Date().toISOString());
  if (a.billing_route === 'paddle' && cGet("SELECT 1 x FROM subscriptions WHERE tenant_id=? AND provider='paddle' AND status IN ('active','trialing','past_due')", t.id)) await paddle.cancel(t);   // stays active until the period ends, then Paddle sends subscription.canceled
  else if (t.status === 'active' && t.paid_through && t.paid_through >= new Date().toISOString().slice(0, 10)) { cRun('UPDATE tenants SET flags=? WHERE id=?', JSON.stringify({ ...safeJson(t.flags, {}), cancel_at_period_end: 1 }), t.id); }   // paid-for time is kept
  else markCanceled(t.id, { actor: 'tenant:' + ctx.user.email, reason, deleteInDays: eraseNow ? 14 : DELETE_AFTER_DAYS });
  if (eraseNow) { cRun("UPDATE tenants SET delete_after=? WHERE id=?", new Date(Date.now() + 14 * 864e5).toISOString(), t.id); }
  audit(ctx.user, 'cancel', 'subscription', null, null, { reason, eraseNow }); paudit('tenant:' + t.subdomain, 'cancel_requested', t.id, { reason, eraseNow });
  return { ok: true, workspace: workspaceInfo(tenantRow(t.id)), message: eraseNow ? 'Your account is scheduled for permanent deletion in 14 days. You can export your data until then.' : 'Your subscription is canceled. You keep access until the end of the paid period, then the workspace is read-only for ' + DELETE_AFTER_DAYS + ' days (your data stays safe and exportable) before it is deleted.' };
});
GET('/api/billing/invoices/:number/pdf', B, (ctx) => {
  const inv = cGet('SELECT * FROM invoices WHERE number=? AND tenant_id=?', ctx.params.number, ctxTenant().id); if (!inv) throw notFound('Invoice');
  return raw(renderInvoicePdf(inv), 'application/pdf', `${inv.number}.pdf`);
});

// ---- Paddle webhook (platform host). Verified on the raw bytes before anything is parsed. ----
route('POST', '/webhooks/paddle', { perm: 'public', scope: 'platform', raw: true }, (ctx) => { const r = paddle.handleWebhook(ctx.rawBody, ctx.req.headers['paddle-signature']); return reply(r.status, r.body); });
