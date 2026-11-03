import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import zlib from 'node:zlib';
import { boot, Client } from './helpers.js';

let t; let owner; let today; let emails = []; let smtp;
const ok = (m, u, b, h) => owner.ok(m, u, b, h);
const login = async (email, password) => { const x = new Client(t.base); const r = await x.post('/api/auth/login', { email, password }); return { x, r }; };

before(async () => {
  // minimal SMTP server (plain, no auth) to verify real email delivery
  smtp = net.createServer((s) => {
    let data = ''; let inData = false; s.write('220 test\r\n');
    s.on('data', (d) => {
      data += d.toString();
      while (true) {
        if (inData) { const i = data.indexOf('\r\n.\r\n'); if (i < 0) return; emails.push(data.slice(0, i)); data = data.slice(i + 5); inData = false; s.write('250 queued\r\n'); continue; }
        const i = data.indexOf('\r\n'); if (i < 0) return; const line = data.slice(0, i); data = data.slice(i + 2);
        if (/^EHLO/i.test(line)) s.write('250 hello\r\n'); else if (/^MAIL|^RCPT/i.test(line)) s.write('250 ok\r\n'); else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); } else if (/^QUIT/i.test(line)) { s.end('221 bye\r\n'); } else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  t = await boot({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURITY: 'none', SMTP_FROM: 'shop@test.local' });
  owner = new Client(t.base);
  await ok('POST', '/api/auth/setup', { name: 'Owner', email: 'owner@test.com', password: 'secret-pass-1', business_name: 'Sec Shop' });
  today = (await ok('GET', '/api/bootstrap')).today;
});
after(async () => { await t.close(); smtp.close(); });

describe('authentication & sessions', () => {
  test('setup can only run once; unauthenticated requests are rejected', async () => {
    const anon = new Client(t.base);
    assert.equal((await anon.post('/api/auth/setup', { name: 'Evil', email: 'e@e.com', password: 'secret-pass-2' })).status, 403);
    for (const u of ['/api/orders', '/api/customers', '/api/settings', '/api/finance/summary', '/api/backup']) assert.equal((await anon.get(u)).status, 401, u);
  });
  test('state-changing requests need the CSRF header and a same-origin Origin', async () => {
    const r = await fetch(t.base + '/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie }, body: JSON.stringify({ name: 'x', phone: '71000000' }) });
    assert.equal(r.status, 403);
    const r2 = await fetch(t.base + '/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://evil.example', Cookie: owner.cookie }, body: JSON.stringify({ name: 'x', phone: '71000000' }) });
    assert.equal(r2.status, 403);
  });
  test('cookie is HttpOnly + SameSite and security headers are sent', async () => {
    const res = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.com', password: 'secret-pass-1' }) });
    const sc = res.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff'); assert.match(res.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });
  test('wrong passwords are rejected and repeated failures are throttled', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await login('owner@test.com', 'nope' + i)).r.status, 401);
    assert.equal((await login('owner@test.com', 'secret-pass-1')).r.status, 429, 'locked out even with the right password');
  });
  test('sessions can be listed and logout invalidates the cookie', async () => {
    const x = new Client(t.base); await x.ok('POST', '/api/auth/login', { email: 'second@test.com', password: 'x' }).catch(() => {});
    const s = await ok('GET', '/api/auth/sessions'); assert.ok(s.some((x) => x.current));
    const y = new Client(t.base); y.cookie = owner.cookie; await y.ok('POST', '/api/auth/logout'); assert.equal((await owner.get('/api/orders')).status, 401);
  });
});

describe('roles & restricted financial data', () => {
  let admin; let emp; let viewer; let empId; let prod; let cust; let ord;
  before(async () => {
    // owner session was just logged out; sign in again via a fresh, un-throttled address (throttle key includes ip, so reset it via password reset flow below instead)
    const fresh = new Client(t.base); const r = await fresh.req('POST', '/api/auth/login', { email: 'owner@test.com', password: 'secret-pass-1' });
    if (r.status === 429) { // lock-out is in-memory per ip+email; restart the throttle by using a different email casing/ip is not possible, so wait it out by reusing setup session from DB
      const tok = 'test-owner-token'; const { sha256 } = await import('../server/util.js');
      t.db.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)', sha256(tok), 1, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString(), new Date().toISOString(), 'test', 'test'); owner.cookie = 'sid=' + tok;
    } else owner = fresh;
    await ok('POST', '/api/exchange-rates', { currency: 'LBP', rate_per_base: 90000 });
    prod = await ok('POST', '/api/products', { name: 'Thing', cost: 700, price: 1000, quantity: 20 });
    cust = await ok('POST', '/api/customers', { name: 'Zed', phone: '71 999 000' });
    ord = await ok('POST', '/api/orders', { customer_id: cust.id, status: 'Delivered', items: [{ product_id: prod.id, qty: 2 }] });
    await ok('POST', '/api/expenses', { category: 'Rent', description: 'rent', amount: 500, method: 'Cash' });
    for (const [name, role] of [['Adam', 'ADMIN'], ['Emma', 'EMPLOYEE'], ['Vera', 'VIEWER']]) {
      const u = await ok('POST', '/api/users', { name, email: `${name.toLowerCase()}@test.com`, role, password: 'staff-pass-1' }); if (role === 'EMPLOYEE') empId = u.id;
    }
    admin = (await login('adam@test.com', 'staff-pass-1')).x; emp = (await login('emma@test.com', 'staff-pass-1')).x; viewer = (await login('vera@test.com', 'staff-pass-1')).x;
  });
  const has = (obj, ...keys) => { const s = JSON.stringify(obj); return keys.filter((k) => s.includes(`"${k}"`)); };

  test('employee does their job but cannot see costs, profit, expenses or settings', async () => {
    assert.equal((await emp.post('/api/customers', { name: 'New', phone: '70 123 123' })).status, 200);
    const o = await emp.post('/api/orders', { customer_id: cust.id, status: 'Pending', items: [{ product_id: prod.id, qty: 1, unit_cost: 1 /* ignored: no finance permission */ }] }); assert.equal(o.status, 200);
    assert.deepEqual(has(o.data, 'unit_cost', 'total_cost', 'gross_profit', 'cost_base', 'profit_base', 'line_cost'), []);
    assert.equal(t.db.get('SELECT unit_cost FROM order_items WHERE order_id=?', o.data.id).unit_cost, 700, 'server snapshots the real product cost; the client value is ignored');
    assert.deepEqual(has((await emp.get('/api/products')).data, 'cost', 'stock_cost_value', 'margin_pct'), []);
    assert.deepEqual(has((await emp.get('/api/analytics?range=this_year')).data, 'gross_profit', 'net_profit', 'product_costs', 'opex'), []);
    for (const u of ['/api/finance/summary', '/api/finance/ledger', '/api/expenses', '/api/settings', '/api/users', '/api/audit', '/api/payments', '/api/reports/expenses', '/api/reports/product_profitability', '/api/whatsapp/campaigns', '/api/backup']) assert.equal((await emp.get(u)).status, 403, u);
    assert.equal((await emp.post('/api/products', { name: 'x' })).status, 403);
    assert.equal((await emp.post('/api/payments', { customer_id: cust.id, amount: 1, method: 'Cash' })).status, 403);
  });
  test('viewer is read-only', async () => {
    assert.equal((await viewer.get('/api/orders')).status, 200);
    for (const [m, u] of [['post', '/api/orders'], ['post', '/api/customers'], ['put', `/api/orders/${ord.id}`], ['post', `/api/orders/${ord.id}/status`]]) assert.equal((await viewer[m](u, {})).status, 403, u);
  });
  test('admin runs finance but cannot change settings or users', async () => {
    assert.equal((await admin.get('/api/finance/summary?range=this_year')).status, 200);
    assert.equal((await admin.post('/api/payments', { customer_id: cust.id, amount: 500, method: 'Cash', allocations: [{ order_id: ord.id, amount: 500 }] })).status, 200);
    assert.equal((await admin.put('/api/settings', { business_name: 'Hacked' })).status, 403); assert.equal((await admin.get('/api/users')).status, 403);
  });
  test('owner can grant an employee extra permissions, which take effect immediately', async () => {
    const perms = ['dashboard:read', 'orders:read', 'orders:write', 'customers:read', 'finance:read', 'reports:read'];
    await ok('PUT', `/api/users/${empId}`, { name: 'Emma', role: 'EMPLOYEE', permissions: perms });
    const o = await emp.get(`/api/orders/${ord.id}`); assert.ok(has(o.data, 'total_cost').length, 'now sees cost'); assert.equal((await emp.get('/api/reports/daily_sales')).status, 200);
  });
  test('deactivating a user kills their session; the last owner is protected', async () => {
    await ok('PUT', `/api/users/${empId}`, { name: 'Emma', role: 'EMPLOYEE', active: false });
    assert.equal((await emp.get('/api/orders')).status, 401); assert.equal((await login('emma@test.com', 'staff-pass-1')).r.status, 401);
    assert.equal((await owner.put('/api/users/1', { name: 'Owner', role: 'ADMIN' })).status, 400);
  });
  test('every sensitive action is audited with who/what/before/after', async () => {
    const a = await ok('GET', '/api/audit?limit=500'); const actions = new Set(a.rows.map((r) => `${r.entity}:${r.action}`));
    for (const k of ['user:create', 'order:create', 'payment:create', 'expense:create', 'product:create', 'user:update', 'user:login']) assert.ok(actions.has(k), k);
    assert.ok(a.rows.find((r) => r.entity === 'user' && r.action === 'update').before);
  });
});

describe('password reset & email', () => {
  test('owner can issue a one-time reset link; it works once and signs the user out everywhere', async () => {
    const u = await ok('POST', '/api/users', { name: 'Rita', email: 'rita@test.com', role: 'EMPLOYEE', password: 'old-pass-123' });
    const { x } = await login('rita@test.com', 'old-pass-123');
    const { link } = await ok('POST', `/api/users/${u.id}/reset-link`); const token = new URL(link.replace('/#', '/')).searchParams.get('token');
    const anon = new Client(t.base);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'new-pass-1234' })).status, 200);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'another-pass-1' })).status, 400, 'single use');
    assert.equal((await x.get('/api/orders')).status, 401, 'old sessions revoked');
    assert.equal((await login('rita@test.com', 'new-pass-1234')).r.status, 200); assert.equal((await login('rita@test.com', 'old-pass-123')).r.status, 401);
  });
  test('"forgot password" never reveals whether an email exists and sends a real email via SMTP', async () => {
    const anon = new Client(t.base); emails = [];
    const a = await anon.post('/api/auth/forgot', { email: 'nobody@nowhere.com' }); const b = await anon.post('/api/auth/forgot', { email: 'rita@test.com' });
    assert.deepEqual(a.data, b.data);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(emails.length, 1); assert.match(emails[0], /To: rita@test.com/); assert.match(emails[0], /Subject: Reset your password/);
    const body = Buffer.from(emails[0].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(); assert.match(body, /#\/reset\?token=[0-9a-f]{64}/);
  });
  test('notification emails are sent immediately or batched into a daily digest, per rule', async () => {
    await ok('PUT', '/api/settings', { owner_email: 'boss@test.com', notification_recipients: ['boss@test.com'], notification_rules: { out_of_stock: { enabled: true, in_app: true, email: true, frequency: 'immediate' }, low_stock: { enabled: true, in_app: true, email: true, frequency: 'daily' } } });
    emails = [];
    const p = await ok('POST', '/api/products', { name: 'Mailed', cost: 1, price: 2, quantity: 3, min_stock: 5 });   // low stock (daily) 
    await ok('POST', `/api/products/${p.id}/stock`, { type: 'damage', qty: 3, note: 'x' });                          // out of stock (immediate)
    const { flushOutbox } = await import('../server/mail.js'); await flushOutbox();
    assert.equal(emails.filter((e) => /Out of stock: Mailed/.test(e)).length, 1);
    assert.equal(emails.filter((e) => /Low stock: Mailed/.test(e)).length, 0, 'daily rule is held for the digest');
    const { sendDailyDigest } = await import('../server/services/notifications.js'); assert.ok(sendDailyDigest(true) >= 1); await flushOutbox();
    assert.ok(emails.some((e) => /Daily digest/.test(e)));
  });
});

describe('reports & exports', () => {
  const dl = (fmt, key = 'daily_sales') => ok('GET', `/api/reports/${key}?format=${fmt}&range=this_year`);
  test('catalogue offers every required report', async () => {
    const keys = (await ok('GET', '/api/reports')).map((r) => r.key);
    for (const k of ['daily_sales', 'monthly_sales', 'yearly_sales', 'orders', 'pending_orders', 'customer_balances', 'payments', 'expenses', 'product_profitability', 'inventory', 'customer_activity', 'campaign_performance']) assert.ok(keys.includes(k), k);
  });
  test('every report renders as JSON, CSV, XLSX and PDF', async () => {
    for (const key of ['daily_sales', 'monthly_sales', 'yearly_sales', 'orders', 'pending_orders', 'customer_balances', 'payments', 'expenses', 'product_profitability', 'inventory', 'customer_activity', 'campaign_performance']) {
      const j = await ok('GET', `/api/reports/${key}?range=this_year`); assert.ok(Array.isArray(j.rows), key);
      assert.match((await dl('csv', key)).toString(), /^﻿/, key + ' csv');
      assert.equal((await dl('xlsx', key)).subarray(0, 2).toString(), 'PK', key + ' xlsx');
      const pdf = await dl('pdf', key); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', key + ' pdf'); assert.match(pdf.subarray(-6).toString(), /%%EOF/);
    }
  });
  test('XLSX is a valid zip containing the numbers; CSV has the totals', async () => {
    const x = await dl('xlsx'); const eocd = x.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); const count = x.readUInt16LE(eocd + 10); assert.equal(count, 6);
    const names = []; let off = x.readUInt32LE(eocd + 16); const files = {};
    for (let i = 0; i < count; i++) { const nl = x.readUInt16LE(off + 28); const name = x.subarray(off + 46, off + 46 + nl).toString(); const lho = x.readUInt32LE(off + 42); const csz = x.readUInt32LE(off + 20); const lnl = x.readUInt16LE(lho + 26); const lel = x.readUInt16LE(lho + 28); files[name] = zlib.inflateRawSync(x.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csz)).toString(); names.push(name); off += 46 + nl; }
    assert.ok(names.includes('xl/worksheets/sheet1.xml')); assert.match(files['xl/worksheets/sheet1.xml'], /Daily sales/); assert.match(files['xl/worksheets/sheet1.xml'], /<v>\d+(\.\d+)?<\/v>/);
    const csv = (await dl('csv')).toString(); assert.match(csv, /Total revenue/); assert.match(csv, /reporting cur|USD/);
  });
  test('CSV exports neutralise spreadsheet formula injection', async () => {
    const cu = await ok('POST', '/api/customers', { name: '=HYPERLINK("http://evil","x")', phone: '71 555 777' });
    const csv = (await dl('csv', 'customer_activity')).toString(); assert.ok(csv.includes(`"'=HYPERLINK`) || csv.includes("'=HYPERLINK"), 'formula is prefixed');
    void cu;
  });
  test('filters and custom ranges are honoured, and invalid ranges are rejected', async () => {
    assert.equal((await owner.get(`/api/reports/daily_sales?range=custom&from=${today}&to=2000-01-01`)).status, 400);
    const r = await ok('GET', `/api/reports/orders?range=custom&from=${today}&to=${today}&status=Delivered`); assert.ok(r.rows.every((x) => x.status === 'Delivered'));
  });
  test('database backup is a consistent SQLite file', async () => {
    const b = await ok('GET', '/api/backup'); assert.equal(b.subarray(0, 15).toString(), 'SQLite format 3');
  });
});
