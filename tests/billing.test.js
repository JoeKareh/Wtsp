import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootSaas, HostClient, makeTenant, lastEmail, DOMAIN } from './saas-helpers.js';

const SECRET = 'pdl_ntfset_test_secret'; let S; let adm; let fake; const apiCalls = []; let ev = 0;
const root = () => new HostClient(S.port, DOMAIN);
const body = (type, data, o = {}) => JSON.stringify({ event_id: o.id || `evt_${++ev}`, event_type: type, occurred_at: o.at || new Date().toISOString(), notification_id: 'ntf_1', data });
const sign = (b, ts = Math.floor(Date.now() / 1000), secret = SECRET) => `ts=${ts};h1=${crypto.createHmac('sha256', secret).update(`${ts}:${b}`).digest('hex')}`;
const send = (type, data, o = {}) => { const b = typeof o.raw === 'string' ? o.raw : body(type, data, o); return root().req('POST', '/webhooks/paddle', b, { 'Content-Type': 'application/json', 'Paddle-Signature': o.sig === undefined ? sign(b, o.ts, o.secret) : o.sig }); };
const T = (id) => S.control.cGet('SELECT * FROM tenants WHERE id=?', id);
const sub = (tid, status = 'active', over = {}) => ({ id: over.sid || `sub_${tid}`, status, customer_id: 'ctm_1', custom_data: { tenant_id: tid }, items: [{ price: { id: over.price || 'pri_growth_m' } }], current_billing_period: { starts_at: '2026-11-01T00:00:00Z', ends_at: over.end || new Date(Date.now() + 30 * 864e5).toISOString() }, billing_cycle: { interval: over.interval || 'month' }, ...(over.scheduled ? { scheduled_change: { action: 'cancel', effective_at: over.end } } : {}) });
const txn = (tid, id, over = {}) => ({ id, status: 'completed', subscription_id: `sub_${tid}`, custom_data: { tenant_id: tid }, currency_code: 'USD', items: [{ price: { id: over.price || 'pri_growth_m' } }], details: { totals: { grand_total: over.total || '4900', tax: over.tax || '0' } }, billing_period: { starts_at: new Date().toISOString(), ends_at: over.end || new Date(Date.now() + 30 * 864e5).toISOString() }, invoice_number: `${id}-inv` });
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString();

before(async () => {
  fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { apiCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null }); res.setHeader('content-type', 'application/json'); if (req.url.includes('portal-sessions')) return res.end(JSON.stringify({ data: { urls: { general: { overview: 'https://portal.example/customer' } } } })); res.end(JSON.stringify({ data: {} })); }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await bootSaas({ PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_API_KEY: 'pdl_api_key', PADDLE_API_BASE: `http://127.0.0.1:${fake.address().port}`, PADDLE_CLIENT_TOKEN: 'test_client_token', PADDLE_ENV: 'sandbox', SUPPORT_EMAIL: 'support@platform.test' });
  const a = S.admin.createAdmin('root@platform.test', 'Root', 'Sup3r-secret-pass'); adm = new HostClient(S.port, `admin.${DOMAIN}`);
  await adm.ok('POST', '/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: S.totp.code(a.secret, S.totp.currentStep()) });
  for (const p of await adm.ok('GET', '/api/admin/plans')) await adm.ok('PUT', `/api/admin/plans/${p.id}`, { paddle_price_monthly: `pri_${p.code === 'business' ? 'biz' : p.code}_m`, paddle_price_annual: `pri_${p.code === 'business' ? 'biz' : p.code}_y` });
});
after(async () => { fake.close(); await S?.close(); });

describe('Paddle webhook security', () => {
  test('valid signature accepted; forged, missing, wrong-secret, tampered and replayed are rejected', async () => {
    const t = await makeTenant(S); const b = body('subscription.created', sub(t.id));
    assert.equal((await send(null, null, { raw: b })).status, 200);
    assert.equal((await send(null, null, { raw: body('subscription.created', sub(t.id)), sig: 'ts=1;h1=deadbeef' })).status, 401);
    assert.equal((await send(null, null, { raw: body('subscription.created', sub(t.id)), sig: '' })).status, 401);
    assert.equal((await send(null, null, { raw: body('subscription.created', sub(t.id)), secret: 'other-secret' })).status, 401);
    const good = body('subscription.created', sub(t.id)); const s = sign(good); assert.equal((await root().req('POST', '/webhooks/paddle', good.replace('active', 'canceled'), { 'Paddle-Signature': s })).status, 401, 'body changed after signing');
    assert.equal((await send(null, null, { raw: body('subscription.created', sub(t.id)), ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, 'replay of an old signed request');
    assert.equal((await send(null, null, { raw: body('subscription.created', sub(t.id)), ts: Math.floor(Date.now() / 1000) + 3600 })).status, 401, 'timestamp from the future');
    assert.equal((await send(null, null, { raw: body('x', {}), sig: 'garbage' })).status, 401);
  });
  test('secret rotation: any of several h1 values may match', async () => {
    const t = await makeTenant(S); const b = body('subscription.created', sub(t.id)); const ts = Math.floor(Date.now() / 1000); const good = sign(b, ts).split('h1=')[1];
    assert.equal((await root().req('POST', '/webhooks/paddle', b, { 'Paddle-Signature': `ts=${ts};h1=${'0'.repeat(64)};h1=${good}` })).status, 200);
  });
  test('a bad signature never reaches the parser (junk body + bad signature => 401, not 400)', async () => {
    assert.equal((await send(null, null, { raw: '{{{ not json', sig: 'ts=1;h1=00' })).status, 401); assert.equal((await send(null, null, { raw: '{{{ not json' })).status, 400, 'validly signed junk is a clean 400');
  });
  test('the webhook exists only on the root domain', async () => { const t = await makeTenant(S); assert.equal((await t.c.post('/webhooks/paddle', {})).status, 404); });
});

describe('subscription lifecycle: trial -> paid -> failed payment -> recovered -> canceled', () => {
  let t;
  test('checkout parameters are built from the plans table and carry the tenant id', async () => {
    t = await makeTenant(S, { country: 'DE', currency: 'EUR' }); const r = await t.c.ok('POST', '/api/billing/checkout', { plan: 'growth', interval: 'year' });
    assert.equal(r.provider, 'paddle'); assert.deepEqual(r.items, [{ priceId: 'pri_growth_y', quantity: 1 }]); assert.deepEqual(r.customData, { tenant_id: t.id }); assert.equal(r.customer.email, t.email); assert.equal(r.client_token, 'test_client_token'); assert.equal(r.env, 'sandbox');
    assert.equal((await t.c.post('/api/billing/checkout', { plan: 'nope' })).status, 400);
  });
  test('subscription.created activates the plan and sets the paid-through date', async () => {
    const end = iso(31); assert.equal((await send('subscription.created', sub(t.id, 'active', { end }))).status, 200);
    const row = T(t.id); assert.equal(row.status, 'active'); assert.equal(row.paid_through, end.slice(0, 10)); assert.equal(S.control.cGet('SELECT paddle_customer_id p FROM accounts WHERE id=?', row.account_id).p, 'ctm_1');
    const sum = await t.c.ok('GET', '/api/billing/summary'); assert.equal(sum.workspace.state, 'active'); assert.equal(sum.workspace.plan.code, 'growth'); assert.equal(sum.subscription.provider, 'paddle');
  });
  test('transaction.completed issues ONE numbered invoice and emails a PDF receipt; duplicates and re-sends do not double-count', async () => {
    const d = txn(t.id, 'txn_1', { total: '4900', tax: '0' }); const r1 = await send('transaction.completed', d, { id: 'evt_dup' }); assert.equal(r1.status, 200);
    const r2 = await send('transaction.completed', d, { id: 'evt_dup' }); assert.equal(r2.data.duplicate, true);
    const r3 = await send('transaction.completed', d, { id: 'evt_other_id_same_txn' }); assert.equal(r3.status, 200);
    const inv = S.control.cAll('SELECT * FROM invoices WHERE tenant_id=?', t.id); assert.equal(inv.length, 1); assert.match(inv[0].number, /^INV-\d{4}-\d{6}$/); assert.equal(inv[0].amount_cents, 4900); assert.equal(inv[0].provider, 'paddle'); assert.equal(inv[0].method, 'card');
    const mails = S.control.cAll("SELECT * FROM platform_outbox WHERE to_addr=? AND kind='receipt'", t.email); assert.equal(mails.length, 1); const att = JSON.parse(mails[0].attachments)[0]; assert.equal(att.filename, `${inv[0].number}.pdf`); assert.equal(Buffer.from(att.b64, 'base64').subarray(0, 5).toString(), '%PDF-');
    const evs = S.control.cAll("SELECT status FROM payment_events WHERE event_id IN ('evt_dup')"); assert.equal(evs.length, 1);
  });
  test('failed payment: past_due with a 7-day grace (still writable) + email; then suspended after the grace', async () => {
    assert.equal((await send('transaction.payment_failed', txn(t.id, 'txn_2'))).status, 200); const row = T(t.id); assert.equal(row.status, 'past_due'); assert.ok(Date.parse(row.grace_ends_at) > Date.now() + 6 * 864e5 && Date.parse(row.grace_ends_at) < Date.now() + 8 * 864e5);
    assert.ok(lastEmail(S, t.email, 'payment_failed')); assert.equal((await t.c.post('/api/customers', { name: 'In grace', phone: '70 100 100' })).status, 200); assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.banner.type, 'past_due');
    S.control.cRun('UPDATE tenants SET grace_ends_at=? WHERE id=?', iso(-1), t.id); assert.equal((await t.c.post('/api/customers', { name: 'After grace', phone: '70 100 101' })).status, 402);
  });
  test('a later successful payment recovers the workspace completely (no data lost)', async () => {
    const before = (await t.c.ok('GET', '/api/customers')).total; const end = iso(31);
    assert.equal((await send('transaction.completed', txn(t.id, 'txn_3', { end }))).status, 200); const row = T(t.id); assert.equal(row.status, 'active'); assert.equal(row.grace_ends_at, null); assert.equal(row.paid_through, end.slice(0, 10));
    assert.equal((await t.c.post('/api/customers', { name: 'Back', phone: '70 100 102' })).status, 200); assert.equal((await t.c.ok('GET', '/api/customers')).total, before + 1);
    assert.equal(S.control.cAll('SELECT * FROM invoices WHERE tenant_id=?', t.id).length, 2);
  });
  test('cancellation at period end keeps access until the paid time ends, then read-only; subscription.canceled schedules deletion in 60 days', async () => {
    const end = iso(10); await send('subscription.updated', sub(t.id, 'active', { end, scheduled: true }), { at: iso(0.001) });
    assert.equal(T(t.id).status, 'active'); assert.equal(JSON.parse(T(t.id).flags).cancel_at_period_end, 1); assert.equal((await t.c.post('/api/customers', { name: 'Still ok', phone: '70 100 103' })).status, 200);
    S.control.cRun('UPDATE tenants SET paid_through=? WHERE id=?', iso(-1).slice(0, 10), t.id); assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.state, 'canceled'); assert.equal((await t.c.post('/api/customers', { name: 'x', phone: '70 100 104' })).status, 402);
    S.control.cRun('UPDATE tenants SET paid_through=? WHERE id=?', iso(5).slice(0, 10), t.id);
    await send('subscription.canceled', sub(t.id, 'canceled'), { at: iso(0.002) }); const row = T(t.id); assert.equal(row.status, 'canceled'); assert.ok(Math.abs(Date.parse(row.delete_after) - (Date.now() + 60 * 864e5)) < 864e5);
    assert.equal((await t.c.get('/api/customers')).status, 200, 'still readable');
  });
  test('resubscribing after cancellation reactivates the same workspace with all its data', async () => {
    await send('subscription.created', sub(t.id, 'active', { sid: 'sub_new', end: iso(30) }), { at: iso(0.003) }); const row = T(t.id); assert.equal(row.status, 'active'); assert.equal(row.canceled_at, null); assert.equal(row.delete_after, null);
    assert.equal((await t.c.post('/api/customers', { name: 'Welcome back', phone: '70 100 105' })).status, 200);
  });
});

describe('out-of-order, unknown and failing events', () => {
  test('older events arriving late never overwrite newer state', async () => {
    const t = await makeTenant(S); const t1 = iso(-0.003); const t2 = iso(-0.002); const t3 = iso(-0.001);
    await send('subscription.created', sub(t.id, 'active', { price: 'pri_growth_m' }), { at: t1 });
    await send('subscription.updated', sub(t.id, 'active', { price: 'pri_biz_m' }), { at: t3 });                       // newer: business
    const late = await send('subscription.updated', sub(t.id, 'active', { price: 'pri_growth_m' }), { at: t2 });      // older arrives last
    assert.match(late.data.result, /stale/); assert.equal((await t.c.ok('GET', '/api/billing/summary')).workspace.plan.code, 'business');
    await send('subscription.canceled', sub(t.id, 'canceled'), { at: iso(-0.0005) }); await send('subscription.updated', sub(t.id, 'active'), { at: t3 });
    assert.equal(T(t.id).status, 'canceled', 'a stale "active" cannot resurrect a canceled subscription');
  });
  test('mid-cycle plan change updates the plan, limits and invoices the prorated charge', async () => {
    const t = await makeTenant(S); await send('subscription.created', sub(t.id, 'active', { price: 'pri_starter_m' }), { at: iso(-0.01) });
    assert.equal((await t.c.ok('GET', '/api/billing/summary')).workspace.plan.limits.users, 2);
    await send('subscription.updated', sub(t.id, 'active', { price: 'pri_biz_m' }), { at: iso(-0.005) }); await send('transaction.completed', txn(t.id, 'txn_pro', { price: 'pri_biz_m', total: '3800' }), { at: iso(-0.004) });
    const s = await t.c.ok('GET', '/api/billing/summary'); assert.equal(s.workspace.plan.code, 'business'); assert.equal(s.workspace.plan.limits.users, 15); assert.equal(s.invoices[0].amount_cents, 3800);
  });
  test('events for unknown tenants are acknowledged (200) and ignored, so Paddle does not retry forever', async () => {
    const r = await send('subscription.created', sub('t_0000000000000000')); assert.equal(r.status, 200); assert.match(r.data.result, /unknown tenant/); assert.equal((await send('some.unknown_event', {})).status, 200);
  });
  test('a processing failure returns 500 and the retry of the SAME event is processed again (never dropped as a duplicate)', async () => {
    const t = await makeTenant(S); const bad = { ...txn(t.id, 'txn_bad'), details: { totals: { grand_total: {} } } };
    const a = await send('transaction.completed', bad, { id: 'evt_fail' }); assert.equal(a.status, 500); assert.equal(S.control.cGet("SELECT status FROM payment_events WHERE event_id='evt_fail'").status, 'failed');
    const b = await send('transaction.completed', bad, { id: 'evt_fail' }); assert.equal(b.status, 500, 'retried, not swallowed as a duplicate');
    const good = await send('transaction.completed', txn(t.id, 'txn_good'), { id: 'evt_fail2' }); assert.equal(good.status, 200);
  });
});

describe('manual billing (bank transfer / Whish / OMT / cash)', () => {
  let t;
  const pay = (id, b) => adm.req('POST', `/api/admin/tenants/${id}/manual-payment`, b);
  test('recording a payment activates the plan, extends the date, issues a numbered invoice and emails a PDF receipt', async () => {
    t = await makeTenant(S, { country: 'LB' }); assert.equal(S.control.cGet('SELECT billing_route r FROM accounts WHERE email=?', t.email).r, 'manual');
    const r = await pay(t.id, { plan: 'growth', months: 3, amount_cents: 13965, method: 'whish', reference: 'WHISH-1001' }); assert.equal(r.status, 200);
    const row = T(t.id); assert.equal(row.status, 'active'); assert.ok(r.data.paid_through > new Date(Date.now() + 80 * 864e5).toISOString().slice(0, 10)); assert.equal(row.paid_through, r.data.paid_through);
    assert.match(r.data.invoice.number, /^INV-\d{4}-\d{6}$/); const mail = S.control.cGet("SELECT * FROM platform_outbox WHERE to_addr=? AND kind='receipt'", t.email); assert.ok(JSON.parse(mail.attachments)[0].b64.length > 1000);
  });
  test('duplicate references are refused; an early renewal extends from the current paid-through date', async () => {
    assert.equal((await pay(t.id, { plan: 'growth', months: 1, amount_cents: 4900, method: 'whish', reference: 'whish-1001' })).status, 409);
    const before = T(t.id).paid_through; const r = await pay(t.id, { plan: 'growth', months: 1, amount_cents: 4900, method: 'bank_transfer', reference: 'BT-77' }); const d = new Date(before + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1);
    assert.ok(Math.abs(Date.parse(r.data.paid_through) - d.getTime()) <= 3 * 864e5, `${before} -> ${r.data.paid_through}`);
  });
  test('a lapsed workspace restarts from the payment date and is fully recovered', async () => {
    S.control.cRun("UPDATE tenants SET status='suspended', paid_through=? WHERE id=?", iso(-40).slice(0, 10), t.id); assert.equal((await t.c.post('/api/customers', { name: 'x', phone: '70 100 100' })).status, 402);
    const r = await pay(t.id, { plan: 'growth', months: 1, amount_cents: 4900, method: 'cash', reference: 'CASH-1' }); assert.equal(T(t.id).status, 'active'); assert.ok(Date.parse(r.data.paid_through) > Date.now() + 27 * 864e5 && Date.parse(r.data.paid_through) < Date.now() + 33 * 864e5);
    assert.equal((await t.c.post('/api/customers', { name: 'Recovered', phone: '70 100 101' })).status, 200);
  });
  test('validation and authorisation', async () => {
    for (const b of [{}, { plan: 'growth', months: 0, amount_cents: 1, method: 'cash', reference: 'a' }, { plan: 'growth', months: 1, amount_cents: -5, method: 'cash', reference: 'a' }, { plan: 'growth', months: 1, amount_cents: 100, method: 'bitcoin', reference: 'a' }, { plan: 'nope', months: 1, amount_cents: 100, method: 'cash', reference: 'a' }, { plan: 'growth', months: 1, amount_cents: 100, method: 'cash' }]) assert.equal((await pay(t.id, b)).status, 400, JSON.stringify(b));
    assert.equal((await new HostClient(S.port, `admin.${DOMAIN}`).req('POST', `/api/admin/tenants/${t.id}/manual-payment`, {})).status, 401); assert.equal((await t.c.post(`/api/admin/tenants/${t.id}/manual-payment`, {})).status, 404);
  });
  test('prepaid pricing: 1/3/6 months get volume discounts, 12 months = the annual price (two months free)', async () => {
    const s = await t.c.ok('GET', '/api/billing/summary'); const g = s.plans.find((p) => p.code === 'growth'); const q = Object.fromEntries(g.prepaid.map((x) => [x.months, x]));
    assert.equal(q[1].amount_cents, 4900); assert.equal(q[3].amount_cents, Math.round(4900 * 3 * 0.95)); assert.equal(q[6].amount_cents, Math.round(4900 * 6 * 0.9)); assert.equal(q[12].amount_cents, 49000); assert.equal(q[12].saving_pct, 17);
  });
  test('"I have paid": the owner is told, an email reaches support, and NOTHING is activated automatically', async () => {
    const x = await makeTenant(S, { country: 'LB' }); S.control.cRun('DELETE FROM platform_outbox'); const r = await x.c.ok('POST', '/api/billing/manual-request', { plan: 'growth', months: 3, reference: 'WHISH-555', note: 'sent from my phone' });
    assert.match(r.message, /confirm/i); assert.equal(T(x.id).status, 'trialing'); const mail = lastEmail(S, 'support@platform.test'); assert.match(mail.text, /WHISH-555/); assert.equal((await x.c.post('/api/billing/manual-request', { plan: 'growth', months: 5 })).status, 400);
  });
  test('invoice PDFs are tenant-scoped and valid; a tenant cannot fetch another tenant\'s invoice', async () => {
    const inv = (await t.c.ok('GET', '/api/billing/summary')).invoices[0]; const pdf = await t.c.get(`/api/billing/invoices/${inv.number}/pdf`); assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
    const other = await makeTenant(S); assert.equal((await other.c.get(`/api/billing/invoices/${inv.number}/pdf`)).status, 404);
    assert.equal((await adm.get(`/api/admin/invoices/${inv.number}/pdf`)).status, 200);
  });
});

describe('payment routing by country', () => {
  test('Lebanon defaults to Whish/bank (manual), everyone else to card; Lebanon may choose card; others may not choose manual', async () => {
    const lb = await makeTenant(S, { country: 'LB' }); const de = await makeTenant(S, { country: 'DE', currency: 'EUR' });
    assert.equal((await lb.c.ok('GET', '/api/billing/summary')).route, 'manual'); assert.deepEqual((await lb.c.ok('GET', '/api/billing/summary')).route_options, ['manual', 'paddle']); assert.equal((await de.c.ok('GET', '/api/billing/summary')).route, 'paddle');
    assert.equal((await lb.c.ok('POST', '/api/billing/checkout', { plan: 'growth' })).provider, 'manual'); assert.equal((await lb.c.ok('PUT', '/api/billing/route', { route: 'paddle' })).route, 'paddle'); assert.equal((await lb.c.ok('POST', '/api/billing/checkout', { plan: 'growth' })).provider, 'paddle');
    assert.equal((await de.c.put('/api/billing/route', { route: 'manual' })).status, 400);
    const accId = S.control.cGet('SELECT account_id a FROM tenants WHERE id=?', de.id).a; assert.equal((await adm.put(`/api/admin/accounts/${accId}/route`, { billing_route: 'manual' })).status, 200); assert.equal((await de.c.ok('POST', '/api/billing/checkout', { plan: 'growth' })).provider, 'manual');
  });
  test('Whish Pay is a stub: clear message, never pretends to work', async () => {
    const x = await makeTenant(S, { country: 'LB' }); const acc = S.control.cGet('SELECT account_id a FROM tenants WHERE id=?', x.id).a; await adm.put(`/api/admin/accounts/${acc}/route`, { billing_route: 'whish' });
    const r = await x.c.post('/api/billing/checkout', { plan: 'growth' }); assert.equal(r.status, 501); assert.match(r.data.error, /Whish Pay is not connected/);
  });
});

describe('billing screen actions', () => {
  test('portal link (card) / none (manual); cancel stores the exit survey; plan change calls the provider', async () => {
    const t = await makeTenant(S, { country: 'DE', currency: 'EUR' }); await send('subscription.created', sub(t.id, 'active'), { at: iso(-0.01) }); apiCalls.length = 0;
    assert.equal((await t.c.ok('POST', '/api/billing/portal')).url, 'https://portal.example/customer'); assert.match(apiCalls[0].url, /\/customers\/ctm_1\/portal-sessions/); assert.equal(apiCalls[0].auth, 'Bearer pdl_api_key');
    await t.c.ok('POST', '/api/billing/change-plan', { plan: 'business', interval: 'month' }); const ch = apiCalls.find((c) => c.method === 'PATCH'); assert.equal(ch.body.items[0].price_id, 'pri_biz_m'); assert.equal(ch.body.proration_billing_mode, 'prorated_immediately');
    const c = await t.c.ok('POST', '/api/billing/cancel', { reason: 'Too expensive for now' }); assert.match(c.message, /keep access/); const cancel = apiCalls.find((x) => x.url.endsWith('/cancel')); assert.equal(cancel.body.effective_from, 'next_billing_period');
    assert.equal(S.control.cGet("SELECT answer FROM surveys WHERE tenant_id=? AND kind='cancel_reason'", t.id).answer, 'Too expensive for now');
    const m = await makeTenant(S, { country: 'LB' }); assert.equal((await m.c.ok('POST', '/api/billing/portal')).url, null);
  });
  test('manual customers cancel at the end of the paid period; "delete my data" schedules deletion in 14 days', async () => {
    const t = await makeTenant(S, { country: 'LB' }); await adm.req('POST', `/api/admin/tenants/${t.id}/manual-payment`, { plan: 'growth', months: 2, amount_cents: 9000, method: 'cash', reference: 'C-9' });
    await t.c.ok('POST', '/api/billing/cancel', { reason: 'closing the shop' }); assert.equal(T(t.id).status, 'active'); assert.equal(JSON.parse(T(t.id).flags).cancel_at_period_end, 1);
    const z = await makeTenant(S, { country: 'LB' }); const r = await z.c.ok('POST', '/api/billing/cancel', { reason: 'privacy', delete_my_data: true }); assert.match(r.message, /14 days/); const d = T(z.id); assert.ok(Math.abs(Date.parse(d.delete_after) - (Date.now() + 14 * 864e5)) < 864e5); assert.equal((await z.c.get('/api/customers')).status, 200, 'can still export until deletion');
  });
  test('billing endpoints are owner-only and keep working when the workspace is read-only', async () => {
    const t = await makeTenant(S); await t.c.ok('POST', '/api/users', { name: 'E', email: 'e@x.example', role: 'EMPLOYEE', password: 'emp-pass-12345' }); const e = new HostClient(S.port, t.c.host); await e.ok('POST', '/api/auth/login', { email: 'e@x.example', password: 'emp-pass-12345' });
    assert.equal((await e.get('/api/billing/summary')).status, 403); S.control.cRun("UPDATE tenants SET status='suspended', suspended_reason='x' WHERE id=?", t.id); assert.equal((await t.c.get('/api/billing/summary')).status, 200); assert.equal((await t.c.post('/api/billing/checkout', { plan: 'growth' })).status, 200);
  });
});

describe('plan limits and feature gating (never block reading or exporting)', () => {
  const setPlan = async (code, limits = {}) => { const p = (await adm.ok('GET', '/api/admin/plans')).find((x) => x.code === code); await adm.ok('PUT', `/api/admin/plans/${p.id}`, { limits }); return p; };
  test('users: hard stop at the plan limit with an upgrade prompt', async () => {
    await setPlan('starter', { users: 2 }); const t = await makeTenant(S); await adm.req('POST', `/api/admin/tenants/${t.id}/plan`, { plan: 'starter' });
    assert.equal((await t.c.post('/api/users', { name: 'U2', email: 'u2@x.example', role: 'EMPLOYEE', password: 'emp-pass-12345' })).status, 200);
    const r = await t.c.post('/api/users', { name: 'U3', email: 'u3@x.example', role: 'EMPLOYEE', password: 'emp-pass-12345' }); assert.equal(r.status, 402); assert.equal(r.data.details.code, 'limit_users'); assert.equal(r.data.details.upgrade, true);
  });
  test('orders: warning at 80% and 100%, soft grace of 20%, then a hard stop. Reads and exports keep working', async () => {
    await setPlan('starter', { orders_month: 5, orders_grace_pct: 20, users: 2 }); const t = await makeTenant(S); await adm.req('POST', `/api/admin/tenants/${t.id}/plan`, { plan: 'starter' });
    const cu = await t.c.ok('POST', '/api/customers', { name: 'C', phone: '70 100 100' }); const mk = (st = 'Pending') => t.c.post('/api/orders', { customer_id: cu.id, status: st, items: [{ description: 'x', qty: 1, unit_price: 100 }] });
    for (let i = 0; i < 3; i++) assert.equal((await mk()).status, 200); assert.equal((await mk('Draft')).status, 200, 'drafts are free');
    assert.equal((await t.c.ok('GET', '/api/billing/summary')).usage.meters.orders.used, 3); assert.equal((await mk()).status, 200);   // 4th = 80%
    const warn = () => t.c.ok('GET', '/api/notifications?all=1').then((r) => r.rows.filter((n) => n.type === 'usage_limit')); assert.ok((await warn()).some((n) => /80%/.test(n.title)), '80% warning');
    assert.equal((await mk()).status, 200); assert.ok((await warn()).some((n) => /reached your plan limit/.test(n.title)), '100% warning'); assert.equal((await mk()).status, 200, '6th order uses the 20% grace');
    const blocked = await mk(); assert.equal(blocked.status, 402); assert.equal(blocked.data.details.code, 'limit_orders');
    assert.equal((await t.c.get('/api/orders')).status, 200); assert.equal((await t.c.get('/api/reports/orders?format=csv&range=this_year')).status, 200); assert.equal((await t.c.post('/api/payments', { customer_id: cu.id, amount: 10, method: 'Cash' })).status, 200, 'payments are never blocked');
    const m = (await t.c.ok('GET', '/api/billing/summary')).usage.meters.orders; assert.equal(m.used, 6); assert.equal(m.limit, 5); assert.equal(m.hard_limit, 6);
    await setPlan('starter', { orders_month: 300 });
  });
  test('Starter has no campaigns/segments; transactional WhatsApp still works; Growth gets them', async () => {
    await setPlan('starter', { orders_month: 300 }); const t = await makeTenant(S); await adm.req('POST', `/api/admin/tenants/${t.id}/plan`, { plan: 'starter' });
    for (const [m, u, b] of [['post', '/api/whatsapp/campaigns', { name: 'x', segment: { key: 'all' }, template_id: 1 }], ['post', '/api/whatsapp/segments', { name: 's', rules: {} }]]) { const r = await t.c[m](u, b); assert.equal(r.status, 402, u); assert.equal(r.data.details.code, 'feature_campaigns'); }
    assert.equal((await t.c.get('/api/whatsapp/templates')).status, 200); assert.equal((await t.c.get('/api/whatsapp/chat-link?customer_id=1&purpose=thank_you')).status === 404, true, 'click-to-chat is available on every plan (404 only because the customer does not exist)');
    const g = await makeTenant(S); const tpl = (await g.c.ok('GET', '/api/whatsapp/templates'))[0]; const r = await g.c.post('/api/whatsapp/campaigns', { name: 'x', segment: { key: 'all' }, template_id: tpl.id, params: {} }); assert.equal(r.status, 200);
  });
  test('plan editing takes effect immediately for existing tenants (no deploy)', async () => {
    const t = await makeTenant(S); await adm.req('POST', `/api/admin/tenants/${t.id}/plan`, { plan: 'growth' }); await setPlan('growth', { users: 1 });
    assert.equal((await t.c.post('/api/users', { name: 'U2', email: 'u2@y.example', role: 'EMPLOYEE', password: 'emp-pass-12345' })).status, 402); await setPlan('growth', { users: 5 }); assert.equal((await t.c.post('/api/users', { name: 'U2', email: 'u2@y.example', role: 'EMPLOYEE', password: 'emp-pass-12345' })).status, 200);
  });
});

describe('invoice PDF content (English and Arabic)', () => {
  test('renders real text in both languages (verified by extracting it back out of the PDF)', async (tc) => {
    let hasTool = true; try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { hasTool = false; } if (!hasTool) return tc.skip('pdftotext not installed');
    for (const [lang, expect] of [['en', /Payment receipt[\s\S]*PAID[\s\S]*Billed to/], ['ar', /[؀-ۿﹰ-﻿]{3,}/]]) {
      const t = await makeTenant(S, { language: lang, business_name: lang === 'ar' ? 'مؤسسة الزيتون' : 'Olive Co' }); const r = await adm.req('POST', `/api/admin/tenants/${t.id}/manual-payment`, { plan: 'growth', months: 1, amount_cents: 4900, method: 'whish', reference: 'PDF-' + lang });
      const num = r.data.invoice.number; const pdf = (await adm.get(`/api/admin/invoices/${num}/pdf`)).data; const f = path.join(os.tmpdir(), `inv-${lang}-${Date.now()}.pdf`); fs.writeFileSync(f, pdf); const txt = execFileSync('pdftotext', ['-layout', f, '-']).toString();
      assert.match(txt, expect, lang); assert.ok(txt.includes(num), 'invoice number present'); assert.match(txt, /49\.00 USD/); fs.rmSync(f);
    }
  });
});
