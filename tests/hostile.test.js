// Pressure tests: concurrency races on money/stock/uniqueness, then hostile and malformed input.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client } from './helpers.js';

let t; let c; let prod; let cust;
const ok = (m, u, b, h) => c.ok(m, u, b, h);
const raw = (method, url, body, headers = {}) => fetch(t.base + url, { method, headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: c.cookie, ...headers }, body });
before(async () => {
  t = await boot(); c = new Client(t.base);
  await ok('POST', '/api/auth/setup', { name: 'Owner', email: 'o@t.com', password: 'secret-pass-1', business_name: 'Hostile Shop' });
  await ok('POST', '/api/exchange-rates', { currency: 'LBP', rate_per_base: 90000 });
  prod = await ok('POST', '/api/products', { name: 'Race item', cost: 100, price: 500, quantity: 100, min_stock: 5 });
  cust = await ok('POST', '/api/customers', { name: 'Racer', phone: '70 100 100' });
});
after(async () => { await t?.close(); });

describe('concurrency', () => {
  test('30 simultaneous payments against one order can never overpay it', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: cust.id, status: 'Confirmed', items: [{ description: 'x', qty: 1, unit_price: 1000, unit_cost: 0 }] });
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => c.post('/api/payments', { customer_id: cust.id, amount: 100, method: 'Cash', allocations: [{ order_id: o.id, amount: 100 }] }, { 'Idempotency-Key': 'race-' + i })));
    const okc = rs.filter((r) => r.status === 200).length;
    assert.equal(okc, 10, 'exactly balance/amount payments succeed'); assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 400), 'the rest are clean 400s, never 500s');
    const after_ = await ok('GET', `/api/orders/${o.id}`); assert.equal(after_.paid, 1000); assert.equal(after_.balance, 0); assert.equal(after_.payment_status, 'Paid');
  });
  test('20 simultaneous retries with the same idempotency key create exactly one payment', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: cust.id, status: 'Confirmed', items: [{ description: 'y', qty: 1, unit_price: 5000, unit_cost: 0 }] });
    const body = { customer_id: cust.id, amount: 700, method: 'Cash', allocations: [{ order_id: o.id, amount: 700 }] };
    const rs = await Promise.all(Array.from({ length: 20 }, () => c.post('/api/payments', body, { 'Idempotency-Key': 'same-key-1' })));
    assert.equal(new Set(rs.map((r) => r.data.id)).size, 1); assert.equal((await ok('GET', `/api/orders/${o.id}`)).paid, 700);
  });
  test('50 simultaneous orders get unique, gap-free sequential numbers', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => c.post('/api/orders', { customer_id: cust.id, status: 'Draft', items: [{ description: 'n' + i, qty: 1, unit_price: 1 }] })));
    assert.ok(rs.every((r) => r.status === 200)); const nums = rs.map((r) => r.data.number); assert.equal(new Set(nums).size, 50);
    const seq = nums.map((n) => Number(n.split('-')[1])).sort((a, b) => a - b); assert.equal(seq.at(-1) - seq[0], 49, 'no gaps');
  });
  test('simultaneous creation of the same customer phone yields exactly one customer', async () => {
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => c.post('/api/customers', { name: 'Twin ' + i, phone: i % 2 ? '+961 71 555 000' : '71555000' })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
  });
  test('30 simultaneous stock-consuming orders keep the stock ledger exact', async () => {
    const before_ = (await ok('GET', `/api/products/${prod.id}`)).product.quantity;
    const rs = await Promise.all(Array.from({ length: 30 }, () => c.post('/api/orders', { customer_id: cust.id, status: 'Confirmed', items: [{ product_id: prod.id, qty: 5 }] })));
    assert.ok(rs.every((r) => r.status === 200));
    const p = await ok('GET', `/api/products/${prod.id}`); assert.equal(p.product.quantity, before_ - 150);
  });
  test('GLOBAL INVARIANTS hold after all that: balances, allocations and stock all reconcile', async () => {
    const q = (sql) => t.db.all(sql);
    assert.deepEqual(q(`SELECT o.id FROM v_orders o WHERE o.paid <> COALESCE((SELECT SUM(a.applied_amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.order_id=o.id AND p.voided=0),0)`), [], 'paid == sum of live allocations');
    assert.deepEqual(q("SELECT id FROM v_orders_fin WHERE status NOT IN ('Cancelled','Returned','Draft') AND paid > amount_due"), [], 'no order is overpaid');
    assert.deepEqual(q('SELECT p.id FROM payments p WHERE p.amount < COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0)'), [], 'no payment over-allocated');
    assert.deepEqual(q('SELECT p.id FROM products p WHERE ABS(p.quantity - COALESCE((SELECT SUM(qty_change) FROM inventory_movements WHERE product_id=p.id),0)) > 0.0001'), [], 'stock == sum of movements');
    assert.deepEqual(q('SELECT number FROM orders GROUP BY number HAVING COUNT(*)>1'), [], 'unique order numbers');
    assert.deepEqual(q('PRAGMA foreign_key_check'), [], 'no dangling foreign keys');
    assert.equal(t.db.get('PRAGMA integrity_check').integrity_check, 'ok');
  });
});

describe('hostile input', () => {
  test('SQL injection attempts in every filter/sort parameter are inert', async () => {
    const counts = () => ({ o: t.db.get('SELECT COUNT(*) c FROM orders').c, c: t.db.get('SELECT COUNT(*) c FROM customers').c, u: t.db.get('SELECT COUNT(*) c FROM users').c });
    const base = counts(); const inj = ["x'; DROP TABLE orders; --", "' OR 1=1 --", "1) UNION SELECT password_hash,2,3 FROM users --", 'Pending") OR ("1"="1', '%', '_', '\\'];
    const urls = (v) => { const e = encodeURIComponent(v); return [`/api/orders?q=${e}`, `/api/orders?status=${e}`, `/api/orders?sort=${e}&dir=${e}`, `/api/orders?payment_status=${e}`, `/api/orders?customer_id=${e}`, `/api/orders?product_id=${e}&from=${e}`, `/api/customers?q=${e}&sort=${e}&lifecycle=${e}&category=${e}&tag=${e}&location=${e}`, `/api/payments?q=${e}&method=${e}&from=${e}`, `/api/expenses?q=${e}&category=${e}`, `/api/products?q=${e}&stock=${e}`, `/api/audit?entity=${e}&user=${e}&q=${e}`, `/api/finance/ledger?q=${e}&kind=${e}&from=${e}`, `/api/inventory/movements?type=${e}&product_id=${e}`, `/api/notifications?type=${e}`, `/api/reports/orders?status=${e}&range=custom&from=${e}&to=${e}`, `/api/analytics?range=${e}&from=${e}`]; };
    for (const v of inj) for (const u of urls(v)) { const r = await c.get(u); assert.ok(r.status < 500, `${u} -> ${r.status}`); assert.ok(!JSON.stringify(r.data).includes('scrypt$'), 'no password hash leaked: ' + u); }
    assert.deepEqual(counts(), base, 'no data changed, no table dropped');
    assert.ok(t.db.get("SELECT name FROM sqlite_master WHERE name='orders'"));
  });
  test('malformed bodies are clean 400s, never 500s or crashes', async () => {
    const H = { 'Content-Type': 'application/json' };
    for (const body of ['{bad json', 'null', '[]', '"a string"', '42', 'true', '{"items":"nope"}']) {
      for (const url of ['/api/orders', '/api/customers', '/api/payments', '/api/expenses', '/api/products', '/api/settings']) {
        const r = await raw(url === '/api/settings' ? 'PUT' : 'POST', url, body, H); assert.ok(r.status >= 400 && r.status < 500, `${url} body=${body} -> ${r.status}`);
      }
    }
    assert.equal((await c.get('/api/health')).status, 200, 'server still alive');
  });
  test('numeric abuse (negative, zero, float, huge, NaN, strings) is rejected cleanly', async () => {
    const mk = (amount) => c.post('/api/payments', { customer_id: cust.id, amount, method: 'Cash' });
    for (const a of [-5, 0, 10.5, 1e20, 'abc', null, '1e3', NaN, [], {}, true]) { const r = await mk(a); assert.equal(r.status, 400, `amount ${JSON.stringify(a)} -> ${r.status}`); }
    for (const q of [0, -1, 1e9, 'x', null, {}]) { const r = await c.post('/api/orders', { customer_id: cust.id, items: [{ description: 'x', qty: q, unit_price: 100 }] }); assert.equal(r.status, 400, `qty ${JSON.stringify(q)} -> ${r.status}`); }
    for (const p of [-1, 1.5, 'free', 1e16]) { const r = await c.post('/api/orders', { customer_id: cust.id, items: [{ description: 'x', qty: 1, unit_price: p }] }); assert.equal(r.status, 400, `price ${JSON.stringify(p)} -> ${r.status}`); }
    assert.equal((await c.post('/api/orders', { customer_id: cust.id, discount: -100, items: [{ description: 'x', qty: 1, unit_price: 100 }] })).status, 400);
    assert.equal((await c.post('/api/orders', { customer_id: cust.id, items: Array.from({ length: 101 }, () => ({ description: 'x', qty: 1, unit_price: 1 })) })).status, 400, 'too many lines');
  });
  test('absurdly long strings are rejected', async () => {
    assert.equal((await c.post('/api/customers', { name: 'A'.repeat(100000), phone: '70 999 111' })).status, 400);
    assert.equal((await c.post('/api/customers', { name: 'ok', phone: '70 999 112', notes: 'n'.repeat(5000) })).status, 400);
  });
  test('oversized request body is refused and the server survives', async () => {
    const r = await raw('POST', '/api/customers', 'x'.repeat(13 * 1024 * 1024), { 'Content-Type': 'application/json' }).catch((e) => ({ status: 'closed:' + e.cause?.code })); assert.ok(r.status === 413 || String(r.status).startsWith('closed'), String(r.status));
    assert.equal((await c.get('/api/health')).status, 200);
  });
  test('path traversal cannot read files outside public/', async () => {
    for (const p of ['/../server/db.js', '/%2e%2e/server/db.js', '/..%2fpackage.json', '/js/../../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/js/..%5c..%5cpackage.json', '//etc/passwd', '/data/bizcontrol.sqlite']) {
      const r = await fetch(t.base + p); const txt = await r.text();
      assert.ok(!txt.includes('"name": "bizcontrol"') && !txt.includes('DatabaseSync') && !txt.includes('root:') && !txt.startsWith('SQLite format'), `leak via ${p}`);
    }
  });
  test('wrong methods / unknown routes / encoded junk in path params are handled', async () => {
    assert.equal((await c.req('PATCH', '/api/orders', {})).status, 405); assert.equal((await c.get('/api/nope')).status, 404);
    for (const id of ['abc', '-1', '99999999999999999999', '1;DROP', '%00', '../x']) { const r = await c.get('/api/orders/' + encodeURIComponent(id)); assert.ok([400, 404].includes(r.status), `${id} -> ${r.status}`); }
    assert.equal((await c.get('/api/customers/%ZZ')).status < 500, true);
  });
  test('Unicode, Arabic, emoji and HTML in data round-trip safely and export correctly', async () => {
    const name = 'سارة الحداد 🌿 <b>x</b> "q" ,;'; const cu = await ok('POST', '/api/customers', { name, phone: '70 424 242', notes: '<script>alert(1)</script>' });
    assert.equal((await ok('GET', `/api/customers/${cu.id}`)).customer.name, name);
    const csv = (await c.get('/api/reports/customer_activity?format=csv')).data.toString(); assert.ok(csv.includes('سارة الحداد 🌿'));
    assert.equal((await c.get('/api/reports/customer_activity?format=xlsx')).status, 200); assert.equal((await c.get('/api/reports/customer_activity?format=pdf')).status, 200, 'PDF must not crash on non-Latin text');
  });
  test('session cookie tampering and token guessing never authenticate', async () => {
    for (const ck of ['sid=', 'sid=abc', 'sid=' + 'a'.repeat(64), "sid=' OR '1'='1", 'sid=%00']) { const r = await fetch(t.base + '/api/orders', { headers: { Cookie: ck } }); assert.equal(r.status, 401, ck); }
  });
  test('login with injection / odd payloads fails cleanly', async () => {
    const x = new Client(t.base);
    for (const b of [{ email: "' OR 1=1 --", password: 'x' }, { email: 'o@t.com', password: { $ne: '' } }, { email: ['o@t.com'], password: 'x' }, {}, { email: 'o@t.com' }]) { const r = await x.post('/api/auth/login', b); assert.ok([400, 401, 429].includes(r.status), JSON.stringify(b) + ' -> ' + r.status); }
  });
});
