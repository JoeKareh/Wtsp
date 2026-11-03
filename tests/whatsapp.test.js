import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { boot, Client } from './helpers.js';

const SECRET = 'app-secret'; let t; let c; let graph; let sent = []; let approved = new Set(); let wamidN = 0; let wa; let tplByName; let templates;
const ok = (m, u, b, h) => c.ok(m, u, b, h);
const messages = () => sent.filter((r) => r.url.endsWith('/123/messages') && r.method === 'POST');
const sign = (body) => ({ 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex') });
const hook = (body, h = sign(body)) => c.post('/webhooks/whatsapp', body, h);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  graph = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const rec = { method: req.method, url: req.url.split('?')[0], body: b ? JSON.parse(b) : null, auth: req.headers.authorization }; sent.push(rec);
      res.setHeader('content-type', 'application/json');
      if (rec.url.endsWith('/123') && req.method === 'GET') return res.end(JSON.stringify({ display_phone_number: '+1 555 000', verified_name: 'Test Biz', quality_rating: 'GREEN' }));
      if (rec.url.endsWith('/123/messages')) return res.end(JSON.stringify({ messages: [{ id: 'wamid.' + ++wamidN }] }));
      if (rec.url.endsWith('/456/message_templates') && req.method === 'POST') return res.end(JSON.stringify({ id: 'meta-' + rec.body.name, status: 'PENDING' }));
      if (rec.url.endsWith('/456/message_templates')) return res.end(JSON.stringify({ data: [...approved].map((n) => ({ name: n, language: 'en', status: 'APPROVED', id: 'meta-' + n })) }));
      res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'unknown' } }));
    });
  });
  await new Promise((r) => graph.listen(0, '127.0.0.1', r));
  t = await boot({ WHATSAPP_API_BASE: `http://127.0.0.1:${graph.address().port}` }); c = new Client(t.base);
  wa = await import('../server/services/whatsapp.js');
  await ok('POST', '/api/auth/setup', { name: 'Owner', email: 'o@t.com', password: 'secret-pass-1', business_name: 'Olive Shop' });
});
after(async () => { graph.close(); await t?.close(); });

const mkCust = async (name, phone, extra = {}) => ok('POST', '/api/customers', { name, phone, ...extra });
const optIn = (id) => ok('POST', `/api/customers/${id}/consent`, { status: 'opted_in', source: 'Signed form' });
const optOut = (id) => ok('POST', `/api/customers/${id}/consent`, { status: 'opted_out', source: 'Asked to stop' });

describe('integration status is honest', () => {
  test('not configured: nothing is claimed to be connected and sending is blocked with a clear message', async () => {
    const s = await ok('GET', '/api/whatsapp/status'); assert.equal(s.connection, 'not_configured'); assert.ok(s.missing.includes('WHATSAPP_TOKEN'));
    const r = await c.post('/api/whatsapp/test', {}); assert.equal(r.status, 400); assert.match(r.data.error, /WHATSAPP_TOKEN/);
  });
  test('configured but untested is not "connected" until a real call succeeds', async () => {
    Object.assign(process.env, { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_BUSINESS_ACCOUNT_ID: '456', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'vt' });
    assert.equal((await ok('GET', '/api/whatsapp/status')).connection, 'untested');
    const s = await ok('POST', '/api/whatsapp/test'); assert.equal(s.connection, 'connected'); assert.equal(s.last_test.verified_name, 'Test Biz');
    assert.equal(sent.at(-1).auth, 'Bearer tok');
  });
  test('webhook verification handshake & signature enforcement', async () => {
    const good = await fetch(`${t.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc123`); assert.equal(await good.text(), 'abc123');
    assert.equal((await fetch(`${t.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`)).status, 403);
    assert.equal((await hook({ entry: [] }, { 'X-Hub-Signature-256': 'sha256=bad' })).status, 401);
    assert.equal((await hook({ entry: [] }, {})).status, 401);
  });
});

let c1; let c2; let c3; let c4; let c5; let promo; let confirmTpl;
describe('consent, segmentation & template approval', () => {
  before(async () => {
    c1 = await mkCust('Opted In', '70 000 101', { marketing_opt_in: true, consent_source: 'Signed form' });
    c2 = await mkCust('No Consent', '70 000 102');
    c3 = await mkCust('Opted Out', '70 000 103'); await optIn(c3.id); await optOut(c3.id);
    c4 = await mkCust('Archived', '70 000 104', { marketing_opt_in: true, consent_source: 'form', status: 'Archived' });
    c5 = await mkCust('No Number', '70 000 105', { whatsapp: '' }); await optIn(c5.id);
    templates = await ok('GET', '/api/whatsapp/templates');
    promo = templates.find((x) => x.name === 'Promotion / discount'); confirmTpl = templates.find((x) => x.name === 'Order confirmation');
  });
  test('default templates exist for every required purpose, with placeholders parsed', () => {
    for (const p of ['new_product', 'promotion', 'special_offer', 'seasonal', 'reactivation', 'thank_you', 'order_confirmation', 'delivery_update', 'payment_reminder', 'recommendation', 'loyalty']) assert.ok(templates.some((x) => x.purpose === p), p);
    assert.deepEqual(promo.params, ['customer_name', 'discount', 'product_name', 'business_name', 'offer_expiry']);
    for (const tpl of templates) assert.deepEqual(tpl.warnings, [], `shipped template "${tpl.name}" must pass Meta-style validation`);
    assert.equal(promo.meta_status, 'LOCAL_DRAFT'); assert.equal(promo.usable, false);
  });
  test('marketing eligibility excludes no-consent, opted-out, archived and number-less customers', async () => {
    const p = await ok('POST', '/api/whatsapp/segments/preview', { segment: { key: 'all' } });
    assert.equal(p.eligible, 1); assert.equal(p.sample[0].id, c1.id);
    assert.equal(p.excluded.no_marketing_consent, 1); assert.equal(p.excluded.suppressed_opted_out, 1); assert.equal(p.excluded.no_whatsapp_number, 1);
    assert.equal(p.targeted, 4, 'archived customers are never targeted');
  });
  test('opt-out puts the number on the suppression list; re-opt-in requires a recorded source', async () => {
    assert.ok((await ok('GET', '/api/whatsapp/suppression')).some((s) => s.customer_id === c3.id));
    assert.equal((await c.post(`/api/customers/${c3.id}/consent`, { status: 'opted_in' })).status, 400);
  });
  test('campaign cannot be sent with an unapproved template', async () => {
    const camp = await ok('POST', '/api/whatsapp/campaigns', { name: 'Autumn', segment: { key: 'all' }, template_id: promo.id, params: { discount: '10%', offer_expiry: '2030-01-01', product_name: 'Olive oil' } });
    const r = await c.post(`/api/whatsapp/campaigns/${camp.id}/send`, {}); assert.equal(r.status, 400); assert.match(r.data.error, /approved/i);
    const pv = await ok('POST', `/api/whatsapp/campaigns/${camp.id}/preview`); assert.ok(pv.send_blockers.length);
    assert.match(pv.samples[0].text, /Hello Opted In, enjoy 10% off Olive oil at Olive Shop\. The offer expires on 2030-01-01, so reply/);
  });
  test('template is submitted to Meta with numbered variables, then approval is synced', async () => {
    const r = await ok('POST', `/api/whatsapp/templates/${promo.id}/submit`); assert.equal(r.meta_status, 'PENDING');
    const req = sent.findLast((x) => x.url.endsWith('/456/message_templates') && x.method === 'POST');
    assert.match(req.body.components[0].text, /\{\{1\}\}.*\{\{2\}\}/); assert.equal(req.body.category, 'MARKETING'); assert.equal(req.body.components[0].example.body_text[0].length, promo.params.length);
    approved.add(promo.wa_name); approved.add(confirmTpl.wa_name);
    assert.equal((await ok('POST', '/api/whatsapp/templates/sync')).updated, 2);
    promo = (await ok('GET', '/api/whatsapp/templates')).find((x) => x.id === promo.id); assert.equal(promo.usable, true);
    assert.equal((await c.put(`/api/whatsapp/templates/${promo.id}`, { body: 'Changed text here for you' })).status, 400, 'approved templates are immutable');
  });
});

let camp;
describe('campaign scheduling, sending & tracking', () => {
  test('scheduled campaigns do not send before their time', async () => {
    camp = await ok('POST', '/api/whatsapp/campaigns', { name: 'Autumn promo', segment: { key: 'all' }, template_id: promo.id, params: { discount: '10%', offer_expiry: '2030-01-01', product_name: 'Olive oil' } });
    const at = new Date(Date.now() + 3600e3).toISOString();
    const s = await ok('POST', `/api/whatsapp/campaigns/${camp.id}/send`, { scheduled_at: at }); assert.equal(s.status, 'scheduled');
    await wait(50); await wa.processCampaigns(); assert.equal(messages().length, 0);
    assert.equal((await c.post(`/api/whatsapp/campaigns/${camp.id}/send`, { scheduled_at: '2001-01-01T00:00:00Z' })).status, 400, 'past');
  });
  test('when due, only eligible recipients are messaged using the approved template', async () => {
    t.db.run("UPDATE whatsapp_campaigns SET scheduled_at='2000-01-01T00:00:00.000Z' WHERE id=?", camp.id);
    await wa.processCampaigns();
    const m = messages(); assert.equal(m.length, 1); assert.equal(m[0].body.to, '70000101'.replace(/^/, '961')); assert.equal(m[0].body.type, 'template');
    assert.equal(m[0].body.template.name, promo.wa_name); assert.equal(m[0].body.template.language.code, 'en');
    assert.deepEqual(m[0].body.template.components[0].parameters.map((p) => p.text), promo.params.map((k) => ({ customer_name: 'Opted In', discount: '10%', product_name: 'Olive oil', business_name: 'Olive Shop', offer_expiry: '2030-01-01' }[k])));
    const d = await ok('GET', `/api/whatsapp/campaigns/${camp.id}`); assert.equal(d.status, 'completed'); assert.equal(d.stats.sent, 1); assert.equal(d.targeted, 4); assert.equal(d.eligible, 1);
    assert.ok((await ok('GET', '/api/notifications?all=1')).rows.some((n) => n.type === 'campaign_completed'));
  });
  test('delivery & read receipts from the webhook update statistics (monotonic)', async () => {
    const wamid = t.db.get("SELECT wamid FROM whatsapp_messages WHERE campaign_id=? AND direction='out'", camp.id).wamid;
    const st = (status) => hook({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    assert.equal((await st('delivered')).status, 200); assert.equal((await st('read')).status, 200); await st('delivered');
    const s = (await ok('GET', `/api/whatsapp/campaigns/${camp.id}`)).stats; assert.equal(s.delivered, 1); assert.equal(s.read, 1);
    assert.equal(t.db.get('SELECT status FROM whatsapp_messages WHERE wamid=?', wamid).status, 'read', 'a late "delivered" never downgrades "read"');
  });
  test('failed deliveries reported by the webhook are counted', async () => {
    t.db.run("INSERT INTO whatsapp_messages(campaign_id,customer_id,phone,direction,kind,body,wamid,status,created_at,sent_at) VALUES (?,?,?,'out','template','x','wamid.fail','sent',?,?)", camp.id, c1.id, c1.whatsapp, new Date().toISOString(), new Date().toISOString());
    await hook({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.fail', status: 'failed', errors: [{ title: 'Message undeliverable' }] }] } }] }] });
    const s = (await ok('GET', `/api/whatsapp/campaigns/${camp.id}`)).stats; assert.equal(s.failed, 1);
    t.db.run("DELETE FROM whatsapp_messages WHERE wamid='wamid.fail'");
  });
  test('orders placed by a messaged customer are attributed to the campaign', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: c1.id, status: 'Delivered', items: [{ description: 'Olive oil', qty: 2, unit_price: 1500, unit_cost: 800 }] });
    const s = (await ok('GET', `/api/whatsapp/campaigns/${camp.id}`)).stats; assert.equal(s.attributed_orders, 1); assert.equal(s.attributed_revenue, 3000);
    assert.equal((await ok('GET', `/api/orders/${o.id}`)).attribution.campaign_id, camp.id);
  });
  test('customer replies are counted, and STOP opts out immediately', async () => {
    const inbound = (text, id) => hook({ entry: [{ changes: [{ value: { messages: [{ from: '96170000101', id, type: 'text', text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    await inbound('Yes please', 'in-1'); await inbound('Yes please', 'in-1'); // duplicate delivery must not double count
    assert.equal((await ok('GET', `/api/whatsapp/campaigns/${camp.id}`)).stats.replies, 1);
    const prof = await ok('GET', `/api/customers/${c1.id}`); assert.equal(prof.whatsapp_window_open, true);
    const free = await ok('POST', '/api/whatsapp/send-text', { customer_id: c1.id, text: 'Great, delivering tomorrow' }); assert.equal(free.status, 'sent');
    await inbound('stop', 'in-2'); await wait(50);
    assert.equal((await ok('GET', `/api/customers/${c1.id}`)).customer.marketing_consent, 'opted_out');
    assert.ok((await ok('GET', '/api/whatsapp/suppression')).some((s) => s.customer_id === c1.id));
    assert.ok(messages().some((m) => m.body.type === 'text' && /unsubscribed/i.test(m.body.text.body)), 'confirmation sent');
  });
  test('opted-out customers are never messaged again, by any campaign', async () => {
    const before_ = messages().length;
    const camp2 = await ok('POST', '/api/whatsapp/campaigns', { name: 'Second', segment: { key: 'all' }, template_id: promo.id, params: { discount: '5%', offer_expiry: '2031-01-01', product_name: 'Soap' } });
    await ok('POST', `/api/whatsapp/campaigns/${camp2.id}/send`, {}); await wait(50); await wa.processCampaigns();
    assert.equal(messages().length, before_); assert.equal((await ok('GET', `/api/whatsapp/campaigns/${camp2.id}`)).status, 'completed');
  });
  test('consent is re-verified immediately before every send (opt-out while queued)', async () => {
    const a = await mkCust('Queue A', '70 000 201', { marketing_opt_in: true, consent_source: 'form' }); const b = await mkCust('Queue B', '70 000 202', { marketing_opt_in: true, consent_source: 'form' });
    const camp3 = await ok('POST', '/api/whatsapp/campaigns', { name: 'Third', segment: { key: 'all' }, template_id: promo.id, params: { discount: '5%', offer_expiry: '2031-01-01', product_name: 'Soap' } });
    // simulate a campaign that has already been materialised and is part-way through sending
    t.db.run("UPDATE whatsapp_campaigns SET status='sending', started_at=? WHERE id=?", new Date().toISOString(), camp3.id);
    for (const cu of [a, b]) t.db.run("INSERT INTO whatsapp_messages(campaign_id,customer_id,phone,direction,kind,template_id,body,status,created_at) VALUES (?,?,?,'out','template',?,'queued body','queued',?)", camp3.id, cu.id, cu.whatsapp, promo.id, new Date().toISOString());
    await optOut(b.id);                                  // B unsubscribes after the queue was built
    const before_ = messages().length;
    await wa.processCampaigns();
    const to = messages().slice(before_).map((m) => m.body.to);
    assert.deepEqual(to, ['96170000201']);
    const row = t.db.get("SELECT status, error FROM whatsapp_messages WHERE campaign_id=? AND customer_id=?", camp3.id, b.id);
    assert.equal(row.status, 'skipped'); assert.equal(row.error, 'suppressed_opted_out');
  });
  test('transactional (utility) templates do not need marketing consent but still respect opt-out', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: c2.id, status: 'Confirmed', items: [{ description: 'x', qty: 1, unit_price: 100 }] });
    const m = await ok('POST', '/api/whatsapp/send-template', { customer_id: c2.id, template_id: confirmTpl.id, order_id: o.id });
    assert.equal(m.status, 'sent'); assert.match(m.body, new RegExp(o.number));
    assert.equal((await c.post('/api/whatsapp/send-template', { customer_id: c3.id, template_id: confirmTpl.id })).status, 400, 'opted-out customer');
  });
  test('free-text is refused outside the 24-hour window', async () => {
    const r = await c.post('/api/whatsapp/send-text', { customer_id: c2.id, text: 'hi' }); assert.equal(r.status, 400); assert.match(r.data.error, /24-hour/);
  });
});
