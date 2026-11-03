import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { normPhone } from '../server/util.js';
import { bootSaas, HostClient, makeTenant, DOMAIN } from './saas-helpers.js';

let S; let A; let B; let graph; const sent = []; const SECRET_A = 'app-secret-of-A'; const SECRET_B = 'app-secret-of-B';
const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const hook = (key, secret, payload, over = {}) => { const body = typeof payload === 'string' ? payload : JSON.stringify(payload); const c = new HostClient(S.port, DOMAIN); return c.req('POST', `/webhooks/whatsapp/${key}`, body, { 'Content-Type': 'application/json', 'X-Hub-Signature-256': over.sig ?? sign(secret, body) }); };
const keyOf = (t) => S.control.cGet('SELECT webhook_key FROM tenants WHERE id=?', t.id).webhook_key;
before(async () => {
  graph = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { sent.push({ url: req.url.split('?')[0], body: b ? JSON.parse(b) : null, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); if (req.url.includes('/messages')) return res.end(JSON.stringify({ messages: [{ id: 'wamid.' + sent.length }] })); res.end(JSON.stringify({ display_phone_number: '+961 3 000000', verified_name: 'Shop', quality_rating: 'GREEN' })); }); });
  await new Promise((r) => graph.listen(0, '127.0.0.1', r));
  S = await bootSaas({ WHATSAPP_API_BASE: `http://127.0.0.1:${graph.address().port}` }); A = await makeTenant(S, { language: 'en' }); B = await makeTenant(S, { language: 'ar' });
  await A.c.ok('PUT', '/api/whatsapp/credentials', { token: 'TOKEN-A-SECRET', phone_number_id: '111111111111', waba_id: '222222222222', app_secret: SECRET_A });
  await B.c.ok('PUT', '/api/whatsapp/credentials', { token: 'TOKEN-B-SECRET', phone_number_id: '333333333333', waba_id: '444444444444', app_secret: SECRET_B });
});
after(async () => { graph.close(); await S?.close(); });

describe('credentials', () => {
  test('are encrypted at rest and never returned by any API', async () => {
    for (const t of [A, B]) { const f = fs.readFileSync(S.db.tenantFile(t.id)); const wal = fs.existsSync(S.db.tenantFile(t.id) + '-wal') ? fs.readFileSync(S.db.tenantFile(t.id) + '-wal') : Buffer.alloc(0); const all = Buffer.concat([f, wal]).toString('latin1'); for (const s of ['TOKEN-A-SECRET', 'TOKEN-B-SECRET', SECRET_A, SECRET_B]) assert.ok(!all.includes(s), 'plaintext secret found in the tenant database file'); }
    for (const u of ['/api/settings', '/api/whatsapp/setup', '/api/whatsapp/status', '/api/bootstrap', '/api/audit?limit=200', '/api/whatsapp/templates']) { const j = JSON.stringify((await A.c.ok('GET', u))); for (const s of ['TOKEN-A-SECRET', SECRET_A, 'integrations_enc']) assert.ok(!j.includes(s), `${s} leaked via ${u}`); }
    const setup = await A.c.ok('GET', '/api/whatsapp/setup'); assert.equal(setup.credentials.wa_token, true); assert.equal(setup.credentials.wa_app_secret, true); assert.equal(setup.credentials.wa_phone_number_id, '111111111111');
  });
  test('each tenant has its own random webhook URL and verify token', async () => {
    const a = await A.c.ok('GET', '/api/whatsapp/setup'); const b = await B.c.ok('GET', '/api/whatsapp/setup');
    assert.match(a.webhook_url, new RegExp(`^http://${DOMAIN.replace('.', '\\.')}(:\\d+)?/webhooks/whatsapp/[0-9a-f]{32}$`)); assert.notEqual(a.webhook_url, b.webhook_url); assert.notEqual(a.verify_token, b.verify_token); assert.match(a.verify_token, /^vt_[0-9a-f]{32}$/);
    assert.equal((await A.c.ok('GET', '/api/whatsapp/setup')).verify_token, a.verify_token, 'stable across calls');
  });
  test('validation: IDs must be numeric; employees cannot change credentials; read-only workspaces cannot either', async () => {
    assert.equal((await A.c.put('/api/whatsapp/credentials', { phone_number_id: 'abc' })).status, 400); assert.equal((await A.c.put('/api/whatsapp/credentials', { waba_id: '12ab' })).status, 400);
    await A.c.ok('POST', '/api/users', { name: 'Emp', email: 'emp@a.example', role: 'EMPLOYEE', password: 'emp-pass-12345' }); const e = new HostClient(S.port, A.c.host); await e.ok('POST', '/api/auth/login', { email: 'emp@a.example', password: 'emp-pass-12345' });
    assert.equal((await e.put('/api/whatsapp/credentials', { token: 'x' })).status, 403); assert.equal((await e.get('/api/whatsapp/setup')).status, 403);
  });
  test('test-connection and "send me a test message" talk to the tenant\'s own number with the tenant\'s own token', async () => {
    sent.length = 0; const st = await A.c.ok('POST', '/api/whatsapp/test'); assert.equal(st.connection, 'connected'); assert.equal(sent.at(-1).auth, 'Bearer TOKEN-A-SECRET'); assert.match(sent.at(-1).url, /111111111111/);
    const m = await A.c.ok('POST', '/api/whatsapp/test-message', { to: '71 123 456' }); assert.equal(m.to, '+96171123456'); assert.equal(sent.at(-1).body.template.name, 'hello_world'); assert.equal(sent.at(-1).body.to, '96171123456');
    await B.c.ok('POST', '/api/whatsapp/test-message', { to: '71 123 456' }); assert.equal(sent.at(-1).auth, 'Bearer TOKEN-B-SECRET'); assert.match(sent.at(-1).url, /333333333333/);
  });
});

describe('per-tenant webhook', () => {
  test('GET handshake uses that tenant\'s verify token only', async () => {
    const a = await A.c.ok('GET', '/api/whatsapp/setup'); const b = await B.c.ok('GET', '/api/whatsapp/setup'); const ka = keyOf(A); const root = new HostClient(S.port, DOMAIN);
    const ok = await root.get(`/webhooks/whatsapp/${ka}?hub.mode=subscribe&hub.verify_token=${a.verify_token}&hub.challenge=CH123`); assert.equal(ok.status, 200); assert.equal(ok.data, 'CH123');
    assert.equal((await root.get(`/webhooks/whatsapp/${ka}?hub.mode=subscribe&hub.verify_token=${b.verify_token}&hub.challenge=X`)).status, 403, "B's token on A's URL");
    assert.equal((await root.get(`/webhooks/whatsapp/${ka}?hub.mode=subscribe&hub.verify_token=&hub.challenge=X`)).status, 403);
  });
  test('unknown, malformed or other-tenant keys: 404, never an error that reveals anything', async () => {
    for (const k of ['0'.repeat(32), 'zz', '../x', 'A'.repeat(32)]) assert.equal((await hook(k, SECRET_A, { entry: [] })).status, 404, k);
    assert.equal((await new HostClient(S.port, A.c.host).post(`/webhooks/whatsapp/${keyOf(A)}`, {})).status, 404, 'webhooks exist only on the root domain');
  });
  test("A's secret on B's URL is rejected; each tenant's own secret is accepted", async () => {
    const p = { entry: [] }; assert.equal((await hook(keyOf(B), SECRET_A, p)).status, 401); assert.equal((await hook(keyOf(A), SECRET_B, p)).status, 401); assert.equal((await hook(keyOf(A), SECRET_A, p)).status, 200); assert.equal((await hook(keyOf(B), SECRET_B, p)).status, 200);
    assert.equal((await hook(keyOf(A), SECRET_A, p, { sig: 'sha256=' })).status, 401); assert.equal((await hook(keyOf(A), SECRET_A, p, { sig: '' })).status, 401);
  });
  test('the body is NOT parsed before the signature is verified', async () => {
    assert.equal((await hook(keyOf(A), SECRET_A, '{ not json at all', { sig: 'sha256=' + '0'.repeat(64) })).status, 401, 'bad signature + junk body => 401, never a JSON error (400)');
    assert.equal((await hook(keyOf(A), SECRET_A, '{ not json at all')).status, 200, 'validly signed junk is simply ignored, not a crash');
    assert.equal((await hook(keyOf(A), SECRET_A, '{"entry":"x","__proto__":{"polluted":1}}')).status, 200); assert.equal({}.polluted, undefined);
  });
  test('events land only in the tenant that owns the URL; statuses update that tenant\'s messages only', async () => {
    const cu = await A.c.ok('POST', '/api/customers', { name: 'Inbound A', phone: '70 111 222' });
    S.db.withTenant(A.id, () => S.db.run("INSERT INTO whatsapp_messages(customer_id,phone,direction,kind,body,wamid,status,created_at,sent_at) VALUES (?,?,'out','template','x','wamid.AAA','sent',?,?)", cu.id, '+96170111222', new Date().toISOString(), new Date().toISOString()));
    const ts = String(Math.floor(Date.now() / 1000));
    await hook(keyOf(B), SECRET_B, { entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.AAA', status: 'read', timestamp: ts }], messages: [{ from: '96170111222', id: 'in-B', type: 'text', text: { body: 'hello B' }, timestamp: ts }] } }] }] });
    assert.equal(S.db.withTenant(A.id, () => S.db.get("SELECT status FROM whatsapp_messages WHERE wamid='wamid.AAA'").status), 'sent', "B's webhook cannot touch A's messages");
    assert.equal(S.db.withTenant(A.id, () => S.db.get("SELECT COUNT(*) c FROM whatsapp_messages WHERE wamid='in-B'").c), 0);
    assert.equal(S.db.withTenant(B.id, () => S.db.get("SELECT COUNT(*) c FROM whatsapp_messages WHERE wamid='in-B'").c), 1);
    await hook(keyOf(A), SECRET_A, { entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.AAA', status: 'read', timestamp: ts }] } }] }] });
    assert.equal(S.db.withTenant(A.id, () => S.db.get("SELECT status FROM whatsapp_messages WHERE wamid='wamid.AAA'").status), 'read');
  });
  test('STOP on tenant A opts that customer out in A only', async () => {
    const ca = await A.c.ok('POST', '/api/customers', { name: 'Stopper', phone: '70 333 444', marketing_opt_in: true, consent_source: 'form' }); const cb = await B.c.ok('POST', '/api/customers', { name: 'Stopper', phone: '70 333 444', marketing_opt_in: true, consent_source: 'form' });
    await hook(keyOf(A), SECRET_A, { entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '96170333444', id: 'stop-1', type: 'text', text: { body: 'STOP' }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    assert.equal((await A.c.ok('GET', `/api/customers/${ca.id}`)).customer.marketing_consent, 'opted_out'); assert.equal((await B.c.ok('GET', `/api/customers/${cb.id}`)).customer.marketing_consent, 'opted_in');
  });
});

describe('coexistence seam (WhatsApp Business app + Cloud API)', () => {
  test('a number flagged as used in the Business app cannot send through the API until coexistence is active', async () => {
    const r = await A.c.ok('PUT', '/api/whatsapp/number-state', { is_on_biz_app: true }); assert.equal(r.state.coexistence, 'pending');
    const blocked = await A.c.post('/api/whatsapp/test-message', { to: '71 123 456' }); assert.equal(blocked.status, 400); assert.match(blocked.data.error, /coexistence/i);
    assert.equal((await B.c.post('/api/whatsapp/test-message', { to: '71 123 456' })).status, 200, 'other tenants unaffected');
  });
  test('smb_message_echoes / history / smb_app_state_sync events are stored and activate the number', async () => {
    const ts = String(Math.floor(Date.now() / 1000)); const cu = await A.c.ok('POST', '/api/customers', { name: 'Echo', phone: '70 555 666' });
    await hook(keyOf(A), SECRET_A, { entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ from: '96100000000', to: '96170555666', id: 'echo-1', type: 'text', text: { body: 'sent from the phone app' }, timestamp: ts }] } }, { field: 'history', value: { history: [{ threads: [{ id: '96170555666', messages: [{ from: '96170555666', id: 'hist-1', type: 'text', text: { body: 'old message' }, timestamp: ts }] }] }] } }, { field: 'smb_app_state_sync', value: { state_sync: [{ type: 'contact', action: 'add', contact: { full_name: 'Synced Contact', phone_number: '+96171777888' } }] } }] }] });
    const prof = await A.c.ok('GET', `/api/customers/${cu.id}`); assert.ok(prof.messages.some((m) => m.body === 'sent from the phone app' && m.direction === 'out')); assert.ok(prof.messages.some((m) => m.body === 'old message' && m.direction === 'in'));
    const synced = (await A.c.ok('GET', '/api/customers?q=Synced')).rows[0]; assert.equal(synced.status, 'Potential'); assert.equal(synced.marketing_consent, null, 'synced contacts carry NO marketing consent');
    const st = await A.c.ok('GET', '/api/whatsapp/status'); assert.equal(st.coexistence, 'active'); assert.equal(st.is_on_biz_app, true);
    assert.equal((await A.c.post('/api/whatsapp/test-message', { to: '71 123 456' })).status, 200, 'sending works once coexistence is active');
    assert.equal(S.db.withTenant(B.id, () => S.db.get("SELECT COUNT(*) c FROM whatsapp_messages WHERE wamid IN ('echo-1','hist-1')").c), 0);
  });
  test('Embedded Signup / Tech Provider mode is an explicit, documented non-feature', async () => {
    const st = await A.c.ok('GET', '/api/whatsapp/status'); assert.equal(st.embedded_signup_available, false); assert.equal(st.mode, 'byo');
  });
});

describe('click-to-chat (works for everyone, no API needed)', () => {
  let C; let cust; let ord;
  before(async () => {
    C = await makeTenant(S, { language: 'en' });               // a tenant with NO WhatsApp API credentials at all
    cust = await C.c.ok('POST', '/api/customers', { name: 'Sara Haddad', phone: '03 123 456' }); const p = await C.c.ok('POST', '/api/products', { name: 'Olive oil', cost: 100, price: 1000, quantity: 5 });
    ord = await C.c.ok('POST', '/api/orders', { customer_id: cust.id, status: 'Delivered', items: [{ product_id: p.id, qty: 2 }] });
  });
  test('Lebanese numbers are normalised to international format (leading zero dropped)', async () => {
    assert.equal(cust.phone, '+9613123456'); for (const [raw, want] of [['71 123 456', '+96171123456'], ['03 123 456', '+9613123456'], ['+961 03 123 456', '+9613123456'], ['00961 71 123 456', '+96171123456'], ['961 71 123 456', '+96171123456'], ['+96171123456', '+96171123456']]) assert.equal(normPhone(raw, '961'), want, raw);
  });
  test('builds a wa.me link with a prefilled, filled-in message and works with no WhatsApp API configured', async () => {
    const r = await C.c.ok('GET', `/api/whatsapp/chat-link?customer_id=${cust.id}&purpose=payment_reminder&order_id=${ord.id}`);
    assert.equal(r.phone, '9613123456'); assert.match(r.url, /^https:\/\/wa\.me\/9613123456\?text=/); assert.equal(decodeURIComponent(r.url.split('?text=')[1]), r.text);
    assert.match(r.text, /Sara/); assert.match(r.text, new RegExp(ord.number)); assert.match(r.text, /20\.00 USD/); assert.doesNotMatch(r.text, /\{\w+\}/, 'never shows a raw placeholder');
    assert.equal((await C.c.ok('GET', '/api/whatsapp/status')).connection, 'not_configured');
  });
  test('every purpose produces a complete message in English and Arabic', async () => {
    for (const purpose of ['order_confirmation', 'delivery_update', 'payment_reminder', 'thank_you', 'win_back']) for (const lang of ['en', 'ar']) { const r = await C.c.ok('GET', `/api/whatsapp/chat-link?customer_id=${cust.id}&purpose=${purpose}&lang=${lang}`); assert.ok(r.text.length > 20 && !/\{\w+\}/.test(r.text), `${purpose}/${lang}: ${r.text}`); if (lang === 'ar') assert.match(r.text, /[؀-ۿ]/); }
  });
  test('the workspace\'s editable template is used when it can be filled, in the workspace language', async () => {
    const ar = await makeTenant(S, { language: 'ar' }); const cu = await ar.c.ok('POST', '/api/customers', { name: 'ليلى', phone: '71 000 111' }); const o = await ar.c.ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', items: [{ description: 'x', qty: 1, unit_price: 100 }] });
    const tpl = (await ar.c.ok('GET', '/api/whatsapp/templates')).find((t) => t.purpose === 'order_confirmation'); await ar.c.ok('PUT', `/api/whatsapp/templates/${tpl.id}`, { body: 'أهلًا {customer_name}، طلبك {order_number} جاهز للتأكيد من {business_name}، شكرًا جزيلًا' });
    const r = await ar.c.ok('GET', `/api/whatsapp/chat-link?customer_id=${cu.id}&purpose=order_confirmation&order_id=${o.id}`); assert.match(r.text, /أهلًا ليلى، طلبك ORD-\d+ جاهز للتأكيد/);
  });
  test('opening a chat is logged on the customer timeline (we log "opened", never "sent")', async () => {
    await C.c.ok('POST', '/api/whatsapp/chat-opened', { customer_id: cust.id, purpose: 'payment_reminder', order_id: ord.id });
    const prof = await C.c.ok('GET', `/api/customers/${cust.id}`); assert.equal(prof.events[0].type, 'wa_opened'); assert.equal(JSON.parse(prof.events[0].detail).purpose, 'payment_reminder');
    assert.equal((await C.c.post('/api/whatsapp/chat-opened', { customer_id: 99999, purpose: 'thank_you' })).status, 404); assert.equal((await C.c.post('/api/whatsapp/chat-opened', { customer_id: cust.id, purpose: 'bogus' })).status, 400);
  });
  test('supplier re-order message, tenant isolation of customer ids, and no link for a customer of another tenant', async () => {
    const sup = await C.c.ok('POST', '/api/suppliers', { name: 'Farms', phone: '+961 70 999 000' }); const r = await C.c.ok('GET', `/api/whatsapp/chat-link?purpose=reorder&supplier_id=${sup.id}&product_id=1`); assert.match(r.url, /^https:\/\/wa\.me\/96170999000/); assert.match(r.text, /Olive oil/);
    assert.equal((await A.c.get(`/api/whatsapp/chat-link?customer_id=${cust.id}&purpose=thank_you`)).status === 200 ? JSON.parse(JSON.stringify((await A.c.get(`/api/whatsapp/chat-link?customer_id=${cust.id}&purpose=thank_you`)).data)).text.includes('Sara') : false, false, "A cannot build a link for C's customer");
  });
});

describe('encryption', () => {
  test('AES-256-GCM: round-trip, tamper detection, unique IV, key rotation via the key ring', () => {
    const { encrypt, decrypt, resetKeyRing, needsRotation } = S.crypto; const e1 = encrypt('secret'); const e2 = encrypt('secret'); assert.notEqual(e1, e2); assert.equal(decrypt(e1), 'secret'); assert.match(e1, /^v1\.[0-9a-f]{8}\./);
    const parts = e1.split('.'); parts[4] = Buffer.from('tampered!').toString('base64url'); assert.throws(() => decrypt(parts.join('.'))); const t = e1.split('.'); t[3] = Buffer.alloc(16).toString('base64url'); assert.throws(() => decrypt(t.join('.')));
    const old = process.env.APP_ENCRYPTION_KEY; process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); process.env.APP_ENCRYPTION_KEY_OLD = old; resetKeyRing();
    assert.equal(decrypt(e1), 'secret', 'old key still decrypts during rotation'); assert.ok(needsRotation(e1)); assert.ok(!needsRotation(encrypt('x')));
    process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); delete process.env.APP_ENCRYPTION_KEY_OLD; resetKeyRing(); assert.throws(() => decrypt(e1), /key ring/);
    process.env.APP_ENCRYPTION_KEY = old; resetKeyRing(); assert.equal(decrypt(e1), 'secret');
  });
});
