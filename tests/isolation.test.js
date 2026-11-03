// TENANT ISOLATION SUITE. Any failure here is a release blocker.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootSaas, HostClient, makeTenant, DOMAIN } from './saas-helpers.js';

let S; let A; let B; const MARK = 'ZZ-SECRET-OF-TENANT-B';
const PDF = Buffer.from('%PDF-1.4 B-private-receipt').toString('base64');
before(async () => {
  S = await bootSaas(); A = await makeTenant(S, { business_name: 'Alpha Shop' }); B = await makeTenant(S, { business_name: 'Beta Shop' });
  // B has real data with an unmistakable marker; A is empty so that any appearance of B's data in A is obvious.
  const cu = await B.c.ok('POST', '/api/customers', { name: MARK + ' Customer', phone: '71 999 888', notes: MARK });
  const pr = await B.c.ok('POST', '/api/products', { name: MARK + ' Product', cost: 100, price: 500, quantity: 50 });
  const o = await B.c.ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', notes: MARK, items: [{ product_id: pr.id, qty: 3 }] });
  await B.c.ok('POST', '/api/payments', { customer_id: cu.id, amount: 700, method: 'Cash', reference: MARK, allocations: [{ order_id: o.id, amount: 700 }] });
  await B.c.ok('POST', '/api/expenses', { category: 'Rent', description: MARK + ' rent', amount: 900, method: 'Cash', attachment: { name: '../../evil.pdf', data_base64: PDF } });
  await B.c.ok('POST', '/api/users', { name: MARK + ' staff', email: 'staff@beta.example', role: 'EMPLOYEE', password: 'staff-pass-123' });
  A.c2 = null;
});
after(async () => { await S?.close(); });
const hostB = () => `${B.sub}.${DOMAIN}`;
const LISTS = ['/api/customers', '/api/orders', '/api/orders/pending', '/api/payments', '/api/expenses', '/api/products', '/api/inventory/movements', '/api/inventory/summary', '/api/finance/ledger', '/api/finance/receivables', '/api/finance/summary?range=this_year', '/api/notifications?all=1', '/api/users', '/api/audit', '/api/whatsapp/templates', '/api/whatsapp/messages', '/api/whatsapp/suppression', '/api/whatsapp/consents', '/api/recommendations?refresh=1', '/api/analytics?range=this_year', '/api/reports/orders?range=this_year', '/api/reports/customer_activity', '/api/reports/payments?range=this_year', '/api/reports/expenses?range=this_year', '/api/reports/inventory', '/api/bootstrap', '/api/settings', '/api/exchange-rates'];

describe('sessions and identity', () => {
  test("tenant A's session cookie sent to tenant B is useless (both cookie names)", async () => {
    const jar = { ...A.c.cookies }; assert.ok(Object.keys(jar).length);
    for (const name of ['sid', '__Host-sid']) {
      const forged = new HostClient(S.port, hostB()); forged.cookies = { [name]: jar.sid };
      for (const u of ['/api/customers', '/api/orders', '/api/users', '/api/auth/me', '/api/settings']) assert.equal((await forged.get(u)).status, 401, `${name} ${u}`);
    }
  });
  test('forging the Host header with A\'s cookie cannot reach B; B\'s own host still needs B\'s login', async () => {
    const withA = new HostClient(S.port, DOMAIN); withA.cookies = { ...A.c.cookies };
    for (const host of [hostB(), hostB().toUpperCase(), `${hostB()}:80`, `${hostB()}.`]) { const r = await new HostClient(S.port, host).req('GET', '/api/customers', undefined, { Cookie: `sid=${A.c.cookies.sid}` }); assert.equal(r.status, 401, host); }
  });
  test('tenant-selecting headers are ignored: only the Host decides the tenant', async () => {
    const base = JSON.stringify((await A.c.ok('GET', '/api/customers')).rows);
    for (const h of [{ 'X-Forwarded-Host': hostB() }, { 'X-Tenant': B.id }, { 'X-Tenant-Id': B.id }, { 'X-Original-Host': hostB() }, { Forwarded: `host=${hostB()}` }, { 'X-Forwarded-Server': hostB() }, { Origin: `http://${hostB()}` }]) {
      const r = await A.c.get('/api/customers', h); assert.ok(r.status === 200 || r.status === 403, JSON.stringify(h)); if (r.status === 200) assert.equal(JSON.stringify(r.data.rows), base, JSON.stringify(h)); assert.ok(!JSON.stringify(r.data).includes(MARK));
    }
  });
  test('unknown, lookalike and raw-IP hosts get 404 and never fall back to any tenant', async () => {
    for (const host of ['evil.com', `${A.sub}.${DOMAIN}.evil.com`, `evil${DOMAIN}`, `x.y.${DOMAIN}`, '127.0.0.1', 'localhost', '', `-bad.${DOMAIN}`, `${'a'.repeat(40)}.${DOMAIN}`, `nosuch.${DOMAIN}`]) {
      const r = await new HostClient(S.port, host).req('GET', '/api/auth/status'); assert.ok([404, 400].includes(r.status), `${host} -> ${r.status}`);
    }
  });
  test('a password-reset or support token minted for one tenant does nothing on another', async () => {
    const link = await B.c.ok('POST', `/api/users/${(await B.c.ok('GET', '/api/users'))[0].id}/reset-link`); const tok = /token=([0-9a-f]+)/.exec(link.link)[1];
    assert.equal((await new HostClient(S.port, `${A.sub}.${DOMAIN}`).post('/api/auth/reset', { token: tok, password: 'brand-new-pass-1' })).status, 400);
  });
});

describe('route scopes', () => {
  test('tenant hosts cannot reach platform or admin routes; the root and admin hosts cannot reach tenant routes', async () => {
    for (const u of ['/api/platform/plans', '/api/platform/signup', '/api/admin/tenants', '/api/admin/me', '/metrics']) assert.equal((await A.c.req(u.includes('signup') ? 'POST' : 'GET', u, u.includes('signup') ? {} : undefined)).status, 404, u);
    const root = new HostClient(S.port, DOMAIN); const admin = new HostClient(S.port, `admin.${DOMAIN}`);
    for (const u of ['/api/customers', '/api/orders', '/api/auth/login', '/api/auth/status', '/api/settings', '/api/whatsapp/status']) { assert.equal((await root.get(u)).status, 404, 'root ' + u); assert.equal((await admin.get(u)).status, 404, 'admin ' + u); }
    assert.equal((await root.get('/api/admin/tenants')).status, 404);
  });
  test('tenant cookies mean nothing to the admin host and admin routes need the admin session + TOTP', async () => {
    const admin = new HostClient(S.port, `admin.${DOMAIN}`); admin.cookies = { ...A.c.cookies };
    for (const u of ['/api/admin/tenants', '/api/admin/metrics', '/api/admin/plans', '/api/admin/audit', '/api/admin/outbox']) assert.equal((await admin.get(u)).status, 401, u);
    assert.equal((await admin.get('/metrics')).status, 401);
  });
  test('static files cannot be used to read other tenants or server files on any host', async () => {
    for (const host of [DOMAIN, `admin.${DOMAIN}`, `${A.sub}.${DOMAIN}`]) for (const p of ['/../tenants/x', `/../${B.id}.sqlite`, `/..%2fcontrol.sqlite`, '/%2e%2e/%2e%2e/etc/passwd', '/../../package.json', '/js/../../server/db.js', '/data/control.sqlite']) {
      const r = await new HostClient(S.port, host).get(p); const txt = Buffer.isBuffer(r.data) ? r.data.toString('latin1') : JSON.stringify(r.data);
      assert.ok(!txt.includes('SQLite format') && !txt.includes('DatabaseSync') && !txt.includes('"name": "bizcontrol"') && !txt.includes('root:'), `${host}${p}`);
    }
  });
});

describe('data access by guessed ids and enumeration', () => {
  test("A cannot read, change or delete B's records by guessing ids (B's rows have ids 1)", async () => {
    for (const u of ['/api/customers/1', '/api/orders/1', '/api/payments/1', '/api/products/1', '/api/expenses/1', '/api/expenses/1/attachment', '/api/customers/1/open-orders']) { const r = await A.c.get(u); assert.ok([404].includes(r.status) || (r.status === 200 && !JSON.stringify(r.data).includes(MARK)), `${u} -> ${r.status}`); }
    for (const [m, u, b] of [['put', '/api/customers/1', { name: 'pwned' }], ['del', '/api/customers/1'], ['post', '/api/orders/1/status', { status: 'Cancelled' }], ['post', '/api/payments/1/void', { reason: 'x' }], ['put', '/api/products/1', { name: 'pwned' }], ['del', '/api/expenses/1'], ['post', '/api/products/1/stock', { type: 'purchase', qty: 5 }]]) { const r = await A.c[m](u, b); assert.ok(r.status === 404 || r.status === 400, `${m} ${u} -> ${r.status}`); }
    const cu = await B.c.ok('GET', '/api/customers/1'); assert.match(cu.customer.name, new RegExp(MARK)); assert.equal((await B.c.ok('GET', '/api/orders/1')).status, 'Delivered'); assert.equal((await B.c.ok('GET', '/api/products/1')).product.quantity, 47);
  });
  test('creating records in A that reference B\'s ids is refused', async () => {
    assert.equal((await A.c.post('/api/orders', { customer_id: 1, items: [{ description: 'x', qty: 1, unit_price: 1 }] })).status, 400);
    assert.equal((await A.c.post('/api/payments', { customer_id: 1, amount: 100, method: 'Cash' })).status, 400);
    assert.equal((await A.c.post('/api/orders', { customer: { name: 'n', phone: '+96171999888' }, items: [{ product_id: 1, qty: 1, unit_price: 1 }] })).status, 400, "B's product id does not exist in A");
  });
  test("no list, report, dashboard or settings endpoint on A ever contains B's data", async () => {
    for (const u of LISTS) { const r = await A.c.get(u); const txt = Buffer.isBuffer(r.data) ? r.data.toString('utf8') : JSON.stringify(r.data); assert.ok(r.status < 500, `${u} ${r.status}`); assert.ok(!txt.includes(MARK) && !txt.includes('Beta Shop') && !txt.includes('staff@beta.example'), 'LEAK in ' + u); }
    for (const f of ['csv', 'xlsx', 'pdf']) for (const k of ['customer_activity', 'orders', 'payments', 'expenses', 'inventory', 'daily_sales']) { const r = await A.c.get(`/api/reports/${k}?format=${f}&range=this_year`); assert.equal(r.status, 200); assert.ok(!Buffer.from(r.data).toString('latin1').includes(MARK), `${k}.${f}`); }
  });
  test("a database backup / export from A contains none of B's bytes", async () => {
    const r = await A.c.get('/api/backup'); assert.equal(r.status, 200); assert.ok(!r.data.toString('latin1').includes(MARK)); assert.ok(!r.data.toString('latin1').includes('Beta Shop'));
  });
  test('B really has its data (the checks above are not passing because B is empty)', async () => {
    assert.ok(JSON.stringify(await B.c.ok('GET', '/api/customers')).includes(MARK)); assert.ok(JSON.stringify(await B.c.ok('GET', '/api/reports/orders?range=this_year')).includes('ORD-'));
  });
});

describe('shared-state leaks (caches, throttles, idempotency)', () => {
  test('the dashboard cache is per tenant: same query, different numbers', async () => {
    const q = '/api/analytics?range=this_year&compare=none'; const b1 = await B.c.ok('GET', q); const a1 = await A.c.ok('GET', q);
    assert.ok(b1.kpis.revenue > 0); assert.equal(a1.kpis.revenue, 0); assert.equal((await A.c.ok('GET', q)).kpis.revenue, 0);
    const cu = await A.c.ok('POST', '/api/customers', { name: 'A cust', phone: '70 555 000' }); await A.c.ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', items: [{ description: 'x', qty: 1, unit_price: 1234, unit_cost: 0 }] });
    assert.equal((await A.c.ok('GET', q)).kpis.revenue, 1234); assert.equal((await B.c.ok('GET', q)).kpis.revenue, b1.kpis.revenue, "A's write did not touch B's cache");
  });
  test('dashboard cache cannot collide even when two tenants have identical write counters', async () => {
    const X = await makeTenant(S); const Y = await makeTenant(S);          // identical history: signup + login + exactly the same number of writes
    const sale = async (t, amt) => { const cu = await t.c.ok('POST', '/api/customers', { name: 'c', phone: '70 616 616' }); await t.c.ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', items: [{ description: 'x', qty: 1, unit_price: amt, unit_cost: 0 }] }); };
    await sale(X, 11111); await sale(Y, 22222);
    const q = '/api/analytics?range=this_year&compare=none';
    assert.equal((await X.c.ok('GET', q)).kpis.revenue, 11111); assert.equal((await Y.c.ok('GET', q)).kpis.revenue, 22222); assert.equal((await X.c.ok('GET', q)).kpis.revenue, 11111);
  });
  test('settings caches are per tenant', async () => {
    await A.c.ok('PUT', '/api/settings', { business_name: 'Alpha Renamed' }); assert.equal((await A.c.ok('GET', '/api/bootstrap')).settings.business_name, 'Alpha Renamed'); assert.equal((await B.c.ok('GET', '/api/bootstrap')).settings.business_name, 'Beta Shop');
  });
  test('login lock-out is per tenant: brute-forcing A does not lock the same email out of B', async () => {
    const x = new HostClient(S.port, `${A.sub}.${DOMAIN}`); for (let i = 0; i < 9; i++) await x.post('/api/auth/login', { email: 'shared@example.com', password: 'wrong' + i });
    assert.equal((await x.post('/api/auth/login', { email: 'shared@example.com', password: 'wrong' })).status, 429);
    const y = new HostClient(S.port, hostB()); assert.equal((await y.post('/api/auth/login', { email: 'shared@example.com', password: 'wrong' })).status, 401, 'B is not throttled by A\'s failures');
  });
  test('the same Idempotency-Key used in two tenants never returns the other tenant\'s response', async () => {
    const key = 'shared-key-123'; const a = await A.c.ok('POST', '/api/customers', { name: 'Idem A', phone: '70 700 701' }, { 'Idempotency-Key': key }); const b = await B.c.ok('POST', '/api/customers', { name: 'Idem B', phone: '70 700 702' }, { 'Idempotency-Key': key });
    assert.equal(a.name, 'Idem A'); assert.equal(b.name, 'Idem B');
  });
});

describe('files and attachments', () => {
  test("B's attachment is stored under B's own directory, not reachable from A, and the client-supplied name cannot escape", async () => {
    const e = await B.c.ok('GET', '/api/expenses?limit=5'); const id = e.rows[0].id; const r = await B.c.get(`/api/expenses/${id}/attachment`); assert.equal(r.status, 200); assert.match(Buffer.from(r.data).toString(), /B-private-receipt/);
    assert.equal((await A.c.get(`/api/expenses/${id}/attachment`)).status, 404);
    const dir = S.db.tenantFile(B.id).replace(/\.sqlite$/, '-files'); assert.ok(fs.existsSync(dir)); const files = fs.readdirSync(dir); assert.equal(files.length, 1); assert.ok(!files[0].includes('..') && !files[0].includes('/')); assert.ok(!fs.existsSync(S.db.tenantFile(A.id).replace(/\.sqlite$/, '-files')) || fs.readdirSync(S.db.tenantFile(A.id).replace(/\.sqlite$/, '-files')).length === 0);
    assert.ok(!fs.existsSync(`${S.dir}/evil.pdf`) && !fs.existsSync('/tmp/evil.pdf'));
  });
});

describe('background jobs', () => {
  test('per-tenant jobs run in the right tenant and one tenant failing does not stop the others', async () => {
    const { forEachTenant } = await import('../server/jobs.js'); const seen = []; const errors = [];
    const n = await forEachTenant('probe', async (t) => { seen.push(t.id); if (t.id === A.id) throw new Error('boom in A'); const { get } = S.db; seen.push(get('SELECT COUNT(*) c FROM customers').c); }, { onError: (t, e) => errors.push([t.id, e.message]) });
    assert.ok(seen.includes(A.id) && seen.includes(B.id)); assert.deepEqual(errors.map((x) => x[0]), [A.id]); assert.ok(n >= 2);
  });
  test('the alert job writes notifications into the correct tenant only', async () => {
    const { runChecks } = await import('../server/services/notifications.js'); const { withTenant, get, run } = S.db;
    withTenant(B.id, () => { run("UPDATE products SET min_stock=100 WHERE id=1"); runChecks(); });
    assert.ok(withTenant(B.id, () => get("SELECT COUNT(*) c FROM notifications WHERE type='low_stock'").c) >= 1); assert.equal(withTenant(A.id, () => get("SELECT COUNT(*) c FROM notifications WHERE type='low_stock'").c), 0);
  });
});
