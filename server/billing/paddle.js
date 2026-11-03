// PaddleBilling (Paddle Billing, the current API). Paddle is Merchant of Record: it handles VAT/sales tax and tax invoices worldwide.
// Webhook verification follows Paddle's documented scheme (Paddle-Signature: ts=...;h1=..., HMAC-SHA256 over "ts:rawBody", several h1 during secret rotation).
// API calls (portal, cancel, change plan) are written from Paddle's Billing API reference and exercised against a fake server in tests: verify them in the Paddle SANDBOX before going live.
import crypto from 'node:crypto';
import { cGet, cRun, cAll, planById, listPlans, paudit, tenantRow } from '../control.js';
import { activate, issueInvoice, emailReceipt, markPastDue, markCanceled, today } from './core.js';
import { setTenantStatus } from '../lifecycle.js';
import { alertOperator } from '../platformmail.js';
import { config } from '../config.js';
import { nowIso, safeJson, HttpError } from '../util.js';
import { safeEqual } from '../crypto.js';

const apiBase = () => process.env.PADDLE_API_BASE || (process.env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com');
async function api(method, path, body) {
  const key = process.env.PADDLE_API_KEY; if (!key) throw new HttpError(503, 'Card billing is not configured on this server (PADDLE_API_KEY).');
  const r = await fetch(apiBase() + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new HttpError(502, `Paddle: ${j?.error?.detail || j?.error?.code || r.status}`);
  return j.data ?? j;
}
export function verifySignature(rawBody, header, { secret = process.env.PADDLE_WEBHOOK_SECRET, now = Date.now(), toleranceS = Number(process.env.PADDLE_WEBHOOK_TOLERANCE_S || 300) } = {}) {
  if (!secret || !header) return { ok: false, reason: 'missing' };
  const parts = String(header).split(';').map((x) => x.trim().split('=')); const ts = parts.find(([k]) => k === 'ts')?.[1]; const h1s = parts.filter(([k]) => k === 'h1').map(([, v]) => v);
  if (!ts || !h1s.length || !/^\d+$/.test(ts)) return { ok: false, reason: 'malformed' };
  if (Math.abs(now / 1000 - Number(ts)) > toleranceS) return { ok: false, reason: 'timestamp outside tolerance (replay protection)' };
  const exp = crypto.createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest('hex');
  return h1s.some((h) => h.length === exp.length && safeEqual(h, exp)) ? { ok: true } : { ok: false, reason: 'bad signature' };
}
const planFromPrice = (priceId) => { for (const p of listPlans(false)) { if (p.paddle_price_monthly === priceId) return { plan: p, interval: 'month' }; if (p.paddle_price_annual === priceId) return { plan: p, interval: 'year' }; } return null; };
const isoDate = (s) => (s ? String(s).slice(0, 10) : null);

function tenantFor(data) {
  const id = data.custom_data?.tenant_id; if (id) { const t = tenantRow(String(id)); if (t) return t; }
  const sid = data.subscription_id || (data.id && String(data.id).startsWith('sub_') ? data.id : null);
  if (sid) { const s = cGet("SELECT tenant_id FROM subscriptions WHERE provider='paddle' AND provider_ref=?", sid); if (s) return tenantRow(s.tenant_id); }
  return null;
}
function upsertSub(t, d, occurred) {
  const price = d.items?.[0]?.price?.id || d.items?.[0]?.price_id; const m = price ? planFromPrice(price) : null;
  const existing = cGet("SELECT * FROM subscriptions WHERE provider='paddle' AND provider_ref=?", d.id);
  if (existing && existing.last_event_at && occurred && occurred < existing.last_event_at) return { stale: true, sub: existing };    // an older event arriving late must never overwrite newer state
  const periodEnd = d.current_billing_period?.ends_at || d.next_billed_at || null; const cancelAt = d.scheduled_change?.action === 'cancel' ? d.scheduled_change.effective_at : null;
  const vals = [t.id, 'paddle', d.id, d.status, m?.plan.id ?? existing?.plan_id ?? t.plan_id, m?.interval || d.billing_cycle?.interval || existing?.interval || 'month', periodEnd, cancelAt, occurred || nowIso(), nowIso()];
  if (existing) cRun('UPDATE subscriptions SET tenant_id=?, provider=?, provider_ref=?, status=?, plan_id=?, interval=?, current_period_end=?, cancel_at=?, last_event_at=?, updated_at=? WHERE id=?', ...vals, existing.id);
  else cRun('INSERT INTO subscriptions(tenant_id,provider,provider_ref,status,plan_id,interval,current_period_end,cancel_at,last_event_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals);
  if (d.customer_id) cRun('UPDATE accounts SET paddle_customer_id=? WHERE id=?', d.customer_id, t.account_id);
  return { stale: false, sub: cGet("SELECT * FROM subscriptions WHERE provider='paddle' AND provider_ref=?", d.id), plan: m };
}

/** Apply one verified event. Returns a short description of what happened (stored on the event row). */
export function applyEvent(evt) {
  const d = evt.data || {}; const type = evt.event_type; const occurred = evt.occurred_at || null;
  if (type.startsWith('subscription.')) {
    const t = tenantFor(d); if (!t) return 'ignored: unknown tenant';
    if (t.status === 'deleted' || t.purged_at) return 'ignored: tenant deleted';
    const { stale, sub, plan } = upsertSub(t, d, occurred); if (stale) return 'ignored: stale (older than the stored state)';
    const end = isoDate(d.current_billing_period?.ends_at || d.next_billed_at);
    const flags = safeJson(tenantRow(t.id).flags, {});
    switch (type) {
      case 'subscription.created': case 'subscription.activated': case 'subscription.resumed':
        if (['active', 'trialing'].includes(d.status)) { activate(t.id, { planId: sub.plan_id, interval: sub.interval, paidThrough: end || today(), actor: 'paddle', detail: type }); return 'activated'; } return `recorded (${d.status})`;
      case 'subscription.updated':
        if (d.status === 'active' || d.status === 'trialing') { activate(t.id, { planId: sub.plan_id, interval: sub.interval, paidThrough: end || today(), actor: 'paddle', detail: 'subscription updated' }); if (sub.cancel_at) { cRun('UPDATE tenants SET flags=? WHERE id=?', JSON.stringify({ ...flags, cancel_at_period_end: 1 }), t.id); return 'active, cancels at period end'; } return 'active'; }
        if (d.status === 'past_due') { markPastDue(t.id, 'paddle', 'subscription past_due'); return 'past_due'; }
        if (d.status === 'paused') { setTenantStatus(t.id, 'suspended', { suspended_reason: 'subscription paused' }, 'paddle'); return 'paused'; }
        if (d.status === 'canceled') { markCanceled(t.id, { actor: 'paddle' }); return 'canceled'; }
        return `recorded (${d.status})`;
      case 'subscription.past_due': markPastDue(t.id, 'paddle', 'subscription.past_due'); return 'past_due';
      case 'subscription.canceled': markCanceled(t.id, { actor: 'paddle' }); return 'canceled';
      case 'subscription.paused': setTenantStatus(t.id, 'suspended', { suspended_reason: 'subscription paused' }, 'paddle'); return 'paused';
      default: return `recorded (${type})`;
    }
  }
  if (type === 'transaction.completed') {
    const t = tenantFor(d); if (!t) return 'ignored: unknown tenant';
    const totals = d.details?.totals || {}; const price = d.items?.[0]?.price?.id; const m = price ? planFromPrice(price) : null;
    const { invoice, created } = issueInvoice({ tenantId: t.id, provider: 'paddle', providerRef: d.id, description: `${m?.plan.name || planById(t.plan_id)?.name || 'Subscription'} plan (${m?.interval === 'year' ? 'annual' : 'monthly'})`, amountCents: Number(totals.grand_total ?? totals.total ?? 0), taxCents: Number(totals.tax ?? 0), currency: d.currency_code || 'USD', periodStart: isoDate(d.billing_period?.starts_at), periodEnd: isoDate(d.billing_period?.ends_at), method: 'card', reference: d.invoice_number || d.id });
    const end = isoDate(d.billing_period?.ends_at); const cur = tenantRow(t.id);
    if (end && cur.status !== 'canceled' && cur.status !== 'deleted') activate(t.id, { planId: m?.plan.id, interval: m?.interval, paidThrough: end, actor: 'paddle', detail: 'payment received' });   // also recovers a past_due / suspended workspace
    if (created) emailReceipt(invoice); return created ? `invoice ${invoice.number}` : 'invoice already issued';
  }
  if (type === 'transaction.payment_failed') { const t = tenantFor(d); if (!t) return 'ignored: unknown tenant'; markPastDue(t.id, 'paddle', 'transaction.payment_failed'); return 'past_due'; }
  return `ignored (${type})`;
}
/** Webhook entry point. Verified first, stored for idempotency, applied, never double-processed. */
export function handleWebhook(rawBody, signatureHeader) {
  const v = verifySignature(rawBody, signatureHeader); if (!v.ok) { alertOperator('webhook:paddle-sig', 'Paddle webhook rejected', v.reason); return { status: 401, body: { error: 'Invalid signature' } }; }
  let evt; try { evt = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'Invalid JSON' } }; }
  const id = evt.event_id; if (!id || !evt.event_type) return { status: 400, body: { error: 'Missing event_id/event_type' } };
  const ins = cRun('INSERT OR IGNORE INTO payment_events(provider,event_id,type,occurred_at,received_at,payload,status) VALUES (?,?,?,?,?,?,?)', 'paddle', id, evt.event_type, evt.occurred_at || null, nowIso(), rawBody.toString('utf8').slice(0, 20000), 'received');
  if (!ins.changes) {
    const prior = cGet("SELECT status FROM payment_events WHERE provider='paddle' AND event_id=?", id);
    if (prior.status !== 'failed') return { status: 200, body: { ok: true, duplicate: true } };   // already applied (or in progress): acknowledge, never apply twice
    // a previous attempt FAILED: Paddle is retrying, so process it again (applying an event is idempotent)
  }
  try { const result = applyEvent(evt); cRun("UPDATE payment_events SET status='processed', error=? WHERE provider='paddle' AND event_id=?", result, id); return { status: 200, body: { ok: true, result } }; }
  catch (e) { cRun("UPDATE payment_events SET status='failed', error=? WHERE provider='paddle' AND event_id=?", String(e.message).slice(0, 300), id); alertOperator('webhook:paddle', 'Paddle webhook processing failed', `${evt.event_type} ${id}: ${e.message}`); return { status: 500, body: { error: 'Processing failed, will retry' } }; }   // 500 => Paddle retries; the same event id is re-applied safely
}
export const paddle = {
  name: 'paddle',
  createCheckout({ tenant, account, plan, interval }) {
    const priceId = interval === 'year' ? plan.paddle_price_annual : plan.paddle_price_monthly;
    if (!priceId) throw new HttpError(400, `Card checkout is not set up for the ${plan.name} ${interval === 'year' ? 'annual' : 'monthly'} price yet. Contact support.`);
    return { provider: 'paddle', env: process.env.PADDLE_ENV || 'sandbox', client_token: process.env.PADDLE_CLIENT_TOKEN || null, items: [{ priceId, quantity: 1 }], customData: { tenant_id: tenant.id }, customer: { email: account.email }, settings: { displayMode: 'overlay', locale: account.language === 'ar' ? 'ar' : 'en', successUrl: config.tenantUrl(tenant.subdomain, '/#/billing?paid=1') } };
  },
  handleWebhook,
  async customerPortalUrl(tenant, account) {
    const sub = cGet("SELECT provider_ref FROM subscriptions WHERE tenant_id=? AND provider='paddle' ORDER BY id DESC LIMIT 1", tenant.id); if (!account.paddle_customer_id) throw new HttpError(400, 'No card subscription found for this workspace.');
    const d = await api('POST', `/customers/${account.paddle_customer_id}/portal-sessions`, sub ? { subscription_ids: [sub.provider_ref] } : {}); return d.urls?.general?.overview || d.urls?.general?.url || null;
  },
  async cancel(tenant) { const sub = cGet("SELECT provider_ref FROM subscriptions WHERE tenant_id=? AND provider='paddle' ORDER BY id DESC LIMIT 1", tenant.id); if (!sub) throw new HttpError(400, 'No card subscription to cancel.'); await api('POST', `/subscriptions/${sub.provider_ref}/cancel`, { effective_from: 'next_billing_period' }); },
  async changePlan(tenant, plan, interval) {
    const sub = cGet("SELECT provider_ref FROM subscriptions WHERE tenant_id=? AND provider='paddle' ORDER BY id DESC LIMIT 1", tenant.id); if (!sub) throw new HttpError(400, 'No card subscription to change.');
    const priceId = interval === 'year' ? plan.paddle_price_annual : plan.paddle_price_monthly; if (!priceId) throw new HttpError(400, 'That plan has no Paddle price configured.');
    await api('PATCH', `/subscriptions/${sub.provider_ref}`, { items: [{ price_id: priceId, quantity: 1 }], proration_billing_mode: 'prorated_immediately' });
  },
  async syncStatus(tenant) { const sub = cGet("SELECT provider_ref FROM subscriptions WHERE tenant_id=? AND provider='paddle' ORDER BY id DESC LIMIT 1", tenant.id); if (!sub) return null; const d = await api('GET', `/subscriptions/${sub.provider_ref}`); applyEvent({ event_type: 'subscription.updated', occurred_at: nowIso(), data: { ...d, custom_data: { ...(d.custom_data || {}), tenant_id: tenant.id } } }); return d.status; },
};
