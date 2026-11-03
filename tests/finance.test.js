import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client } from './helpers.js';

let t; let c; let today; let widget; let gadget; let custA; let custB;
const ok = (m, u, b, h) => c.ok(m, u, b, h);

before(async () => {
  t = await boot(); c = new Client(t.base);
  await ok('POST', '/api/auth/setup', { name: 'Owner', email: 'owner@test.com', password: 'secret-pass-1', business_name: 'Test Shop' });
  today = (await ok('GET', '/api/bootstrap')).today;
  await ok('POST', '/api/exchange-rates', { currency: 'LBP', rate_per_base: 90000, effective_date: '2020-01-01' });
  widget = await ok('POST', '/api/products', { name: 'Widget', cost: 600, price: 1000, quantity: 100, min_stock: 10, max_stock: 150 });
  gadget = await ok('POST', '/api/products', { name: 'Gadget', cost: 2000, price: 3000, quantity: 5, min_stock: 5 });
  custA = await ok('POST', '/api/customers', { name: 'Alice', phone: '+961 71 123 456' });
  custB = await ok('POST', '/api/customers', { name: 'Bob', phone: '03 555 666' });
});
after(async () => { await t.close(); });

describe('customers', () => {
  test('phone numbers are normalised and duplicates (any format) are rejected', async () => {
    assert.equal(custA.phone, '+96171123456');
    for (const p of ['71123456', '00961 71-123-456', '+96171123456']) {
      const r = await c.post('/api/customers', { name: 'Dup', phone: p });
      assert.equal(r.status, 409, p); assert.equal(r.data.details.duplicate.id, custA.id);
    }
    const r = await c.post('/api/customers', { name: 'Other', phone: '70 999 888', phone2: '71 123 456' });
    assert.equal(r.status, 409, 'secondary number may not collide either');
  });
  test('lookup by phone finds the customer', async () => {
    const r = await ok('GET', '/api/customers/lookup?phone=71123456'); assert.equal(r.found, true); assert.equal(r.customer.id, custA.id);
  });
  test('invalid phone is rejected', async () => { assert.equal((await c.post('/api/customers', { name: 'X', phone: 'abc' })).status, 400); });
  test('marketing consent needs an explicit source', async () => {
    const r = await c.post('/api/customers', { name: 'Consent', phone: '76 000 111', marketing_opt_in: true }); assert.equal(r.status, 400);
  });
});

let o1; let o2;
describe('order maths & stock', () => {
  test('order totals: revenue, cost, profit are computed server-side', async () => {
    o1 = await ok('POST', '/api/orders', {
      customer_id: custA.id, status: 'Confirmed', discount: 500, additional_charges: 200, delivery_fee: 300, extra_cost: 100,
      items: [{ product_id: widget.id, qty: 3, unit_price: 1000, unit_cost: 99999 /* ignored: cost comes from product unless finance */ }, { product_id: gadget.id, qty: 1 }],
    }, { 'Idempotency-Key': 'k-o1' });
    assert.equal(o1.subtotal, 6000); assert.equal(o1.net_revenue, 6000); assert.equal(o1.total, 6000);
    // owner has finance perm so provided cost is honoured: 3*99999 + 2000 + 100
    assert.equal(o1.total_cost, 3 * 99999 + 2000 + 100);
  });
  test('without an explicit cost the product cost snapshot is used', async () => {
    const draft = await ok('POST', '/api/orders', { customer_id: custA.id, status: 'Draft', items: [{ product_id: widget.id, qty: 2 }] });
    assert.equal(draft.total, 2000); assert.equal(draft.total_cost, 1200); assert.equal(draft.gross_profit, 800);
    await ok('DELETE', `/api/orders/${draft.id}`);
  });
  test('idempotency key prevents duplicate orders', async () => {
    const again = await c.post('/api/orders', { customer_id: custA.id, status: 'Confirmed', items: [{ product_id: widget.id, qty: 9 }] }, { 'Idempotency-Key': 'k-o1' });
    assert.equal(again.data.id, o1.id); assert.equal(again.headers.get('idempotent-replay'), 'true');
  });
  test('stock is deducted on Confirmed (configured rule) and is idempotent', async () => {
    const w = await ok('GET', `/api/products/${widget.id}`); assert.equal(w.product.quantity, 97);
    await ok('PUT', `/api/orders/${o1.id}`, { items: o1.items.map((i) => ({ id: i.id, product_id: i.product_id, qty: i.qty, unit_price: i.unit_price })) });
    assert.equal((await ok('GET', `/api/products/${widget.id}`)).product.quantity, 97, 'editing without changes must not move stock again');
  });
  test('tax, when enabled, is added to the amount due but not to revenue', async () => {
    await ok('PUT', '/api/settings', { tax_enabled: true, tax_rate: 10 });
    const o = await ok('POST', '/api/orders', { customer_id: custB.id, status: 'Draft', items: [{ description: 'Service', qty: 1, unit_price: 1000, unit_cost: 0 }] });
    assert.equal(o.tax, 100); assert.equal(o.total, 1100); assert.equal(o.net_revenue, 1000);
    await ok('DELETE', `/api/orders/${o.id}`); await ok('PUT', '/api/settings', { tax_enabled: false });
  });
  test('discount larger than the order is rejected', async () => {
    const r = await c.post('/api/orders', { customer_id: custA.id, discount: 99999, items: [{ description: 'x', qty: 1, unit_price: 100 }] }); assert.equal(r.status, 400);
  });
});

describe('payments & balances', () => {
  test('partial payment updates order and customer balance', async () => {
    const p = await ok('POST', '/api/payments', { customer_id: custA.id, amount: 2500, method: 'Cash', allocations: [{ order_id: o1.id, amount: 2500 }] });
    assert.equal(p.unallocated, 0);
    const o = await ok('GET', `/api/orders/${o1.id}`); assert.equal(o.paid, 2500); assert.equal(o.balance, 3500); assert.equal(o.payment_status, 'Partially paid');
    const cu = await ok('GET', `/api/customers/${custA.id}`); assert.equal(cu.customer.outstanding, 3500); assert.equal(cu.customer.total_paid, 2500);
  });
  test('one payment can be split across several orders', async () => {
    o2 = await ok('POST', '/api/orders', { customer_id: custA.id, status: 'Confirmed', items: [{ product_id: widget.id, qty: 2 }] });
    const p = await ok('POST', '/api/payments', { customer_id: custA.id, amount: 4000, method: 'Bank transfer', allocations: [{ order_id: o1.id, amount: 3500 }, { order_id: o2.id, amount: 500 }] });
    assert.equal(p.allocations.length, 2);
    const a = await ok('GET', `/api/orders/${o1.id}`); const b = await ok('GET', `/api/orders/${o2.id}`);
    assert.equal(a.payment_status, 'Paid'); assert.equal(a.balance, 0); assert.equal(b.balance, 1500); assert.equal(b.payment_status, 'Partially paid');
  });
  test('cannot pay more than the remaining balance, or allocate more than the payment', async () => {
    assert.equal((await c.post('/api/payments', { customer_id: custA.id, amount: 5000, method: 'Cash', allocations: [{ order_id: o2.id, amount: 5000 }] })).status, 400);
    assert.equal((await c.post('/api/payments', { customer_id: custA.id, amount: 100, method: 'Cash', allocations: [{ order_id: o2.id, amount: 500 }] })).status, 400);
    assert.equal((await c.post('/api/payments', { customer_id: custB.id, amount: 100, method: 'Cash', allocations: [{ order_id: o2.id, amount: 100 }] })).status, 400, "another customer's order");
    assert.equal((await c.post('/api/payments', { customer_id: custA.id, amount: 100, method: 'Bitcoin', allocations: [] })).status, 400, 'unknown method');
  });
  test('duplicate submission with the same idempotency key records one payment', async () => {
    const body = { customer_id: custA.id, amount: 100, method: 'Cash', allocations: [{ order_id: o2.id, amount: 100 }] };
    const a = await c.post('/api/payments', body, { 'Idempotency-Key': 'pay-dup' }); const b = await c.post('/api/payments', body, { 'Idempotency-Key': 'pay-dup' });
    assert.equal(a.data.id, b.data.id);
    assert.equal((await ok('GET', `/api/orders/${o2.id}`)).balance, 1400);
    await ok('POST', `/api/payments/${a.data.id}/void`, { reason: 'test cleanup' });
    assert.equal((await ok('GET', `/api/orders/${o2.id}`)).balance, 1500);
  });
  test('auto-allocation pays oldest orders first and keeps the remainder as credit', async () => {
    const cu = await ok('POST', '/api/customers', { name: 'Carl', phone: '70 111 222' });
    const x = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', order_date: '2024-01-01', items: [{ description: 'A', qty: 1, unit_price: 1000 }] });
    const y = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', order_date: '2024-02-01', items: [{ description: 'B', qty: 1, unit_price: 1000 }] });
    const p = await ok('POST', '/api/payments', { customer_id: cu.id, amount: 1500, method: 'Cash', auto_allocate: true });
    assert.equal((await ok('GET', `/api/orders/${x.id}`)).payment_status, 'Paid');
    assert.equal((await ok('GET', `/api/orders/${y.id}`)).balance, 500);
    const p2 = await ok('POST', '/api/payments', { customer_id: cu.id, amount: 800, method: 'Cash', auto_allocate: true });
    assert.equal(p2.allocated, 500); assert.equal(p2.unallocated, 300);
    assert.equal((await ok('GET', `/api/customers/${cu.id}`)).credit[0].amount, 300);
  });
});

describe('edge cases: edit, void, cancel, refund', () => {
  let cu; let ord;
  before(async () => {
    cu = await ok('POST', '/api/customers', { name: 'Dina', phone: '78 222 333' });
    ord = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', items: [{ description: 'Consulting', qty: 1, unit_price: 5000 }] });
  });
  test('editing a payment re-computes balances; voiding restores them', async () => {
    const p = await ok('POST', '/api/payments', { customer_id: cu.id, amount: 3000, method: 'Cash', allocations: [{ order_id: ord.id, amount: 3000 }] });
    assert.equal((await ok('GET', `/api/orders/${ord.id}`)).balance, 2000);
    await ok('PUT', `/api/payments/${p.id}`, { amount: 4000, allocations: [{ order_id: ord.id, amount: 4000 }], reason: 'counted wrong' });
    assert.equal((await ok('GET', `/api/orders/${ord.id}`)).balance, 1000);
    await ok('POST', `/api/payments/${p.id}/void`, { reason: 'bounced' });
    const o = await ok('GET', `/api/orders/${ord.id}`); assert.equal(o.balance, 5000); assert.equal(o.payment_status, 'Unpaid');
    assert.equal((await c.post(`/api/payments/${p.id}/void`, { reason: 'again' })).status, 400, 'cannot void twice');
    assert.equal((await c.put(`/api/payments/${p.id}`, { amount: 10 })).status, 400, 'voided payments are locked');
    const audit = await ok('GET', `/api/audit?entity=payment&q=${p.id}`); assert.ok(audit.rows.length >= 3, 'create+update+void are audited');
  });
  test('cancelling a paid order turns the payment into customer credit, not negative revenue; refund settles it', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', items: [{ product_id: widget.id, qty: 1 }] });
    const stockBefore = (await ok('GET', `/api/products/${widget.id}`)).product.quantity;
    await ok('POST', '/api/payments', { customer_id: cu.id, amount: 1000, method: 'Cash', allocations: [{ order_id: o.id, amount: 1000 }] });
    const cancelled = await ok('POST', `/api/orders/${o.id}/cancel`, { reason: 'customer changed mind' });
    assert.equal(cancelled.amount_due, 0); assert.equal(cancelled.credit, 1000); assert.ok(cancelled.warning);
    assert.equal((await ok('GET', `/api/products/${widget.id}`)).product.quantity, stockBefore + 1, 'stock restored');
    assert.equal((await c.post('/api/payments', { customer_id: cu.id, type: 'refund', amount: 5000, method: 'Cash', allocations: [{ order_id: o.id, amount: 5000 }] })).status, 400, 'refund > paid');
    await ok('POST', '/api/payments', { customer_id: cu.id, type: 'refund', amount: 1000, method: 'Cash', allocations: [{ order_id: o.id, amount: 1000 }] });
    const after_ = await ok('GET', `/api/orders/${o.id}`); assert.equal(after_.payment_status, 'Refunded'); assert.equal(after_.balance, 0);
    assert.equal((await c.put(`/api/orders/${o.id}`, { notes: 'x' })).status, 400, 'cancelled orders are locked');
  });
  test('returned orders restock and owe nothing', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', items: [{ product_id: gadget.id, qty: 1 }] });
    const q1 = (await ok('GET', `/api/products/${gadget.id}`)).product.quantity;
    const r = await ok('POST', `/api/orders/${o.id}/status`, { status: 'Returned' });
    assert.equal(r.amount_due, 0); assert.equal((await ok('GET', `/api/products/${gadget.id}`)).product.quantity, q1 + 1);
    const mv = await ok('GET', `/api/inventory/movements?product_id=${gadget.id}&type=return`); assert.ok(mv.rows.length >= 1);
  });
  test('cancelled/draft/returned orders are excluded from receivables', async () => {
    const f = await ok('GET', '/api/finance/receivables');
    assert.ok(!f.orders.some((x) => ['Cancelled', 'Draft', 'Returned'].includes(x.status)));
  });
});

describe('multi-currency', () => {
  test('LBP order is stored with its rate; a USD payment converts without silent mixing', async () => {
    const cu = await ok('POST', '/api/customers', { name: 'Layla', phone: '79 555 444' });
    const o = await ok('POST', '/api/orders', { customer_id: cu.id, currency: 'LBP', status: 'Confirmed', items: [{ description: 'Item', qty: 1, unit_price: 9000000 }] });
    assert.equal(o.currency, 'LBP'); assert.equal(o.fx_rate, 90000); assert.equal(o.revenue_base, 100, 'LBP 90,000 = USD 1.00 = 100 cents');
    const p = await ok('POST', '/api/payments', { customer_id: cu.id, currency: 'USD', amount: 50, method: 'Cash', allocations: [{ order_id: o.id, amount: 50 }] });
    assert.equal(p.fx_rate, 1);
    let ord = await ok('GET', `/api/orders/${o.id}`); assert.equal(ord.paid, 4500000); assert.equal(ord.balance, 4500000);
    await ok('POST', '/api/payments', { customer_id: cu.id, currency: 'LBP', amount: 4500000, method: 'Cash', allocations: [{ order_id: o.id, amount: 4500000 }] });
    ord = await ok('GET', `/api/orders/${o.id}`); assert.equal(ord.payment_status, 'Paid');
    const sum = await ok('GET', '/api/finance/summary?range=this_year');
    assert.equal(sum.fx.reporting_currency, 'USD'); assert.ok(sum.current.cash_by_currency.some((x) => x.currency === 'LBP'));
  });
  test('unknown currency or missing rate is rejected', async () => {
    assert.equal((await c.post('/api/orders', { customer_id: custA.id, currency: 'EUR', items: [{ description: 'x', qty: 1, unit_price: 1 }] })).status, 400);
  });
});

describe('P&L vs cash', () => {
  test('revenue counts only recognised orders; unpaid orders are not cash; net profit = gross - opex', async () => {
    await ok('POST', `/api/orders/${o1.id}/status`, { status: 'Delivered' }); await ok('POST', `/api/orders/${o2.id}/status`, { status: 'Delivered' });
    await ok('POST', '/api/expenses', { category: 'Rent', description: 'Shop rent', amount: 1000, method: 'Cash' });
    const s = await ok('GET', `/api/finance/summary?range=custom&from=${today}&to=${today}`);
    const cur = s.current;
    // o1 and o2 recognised; other test orders are also delivered today (Dina's returned/cancelled excluded) so assert relationships
    assert.equal(cur.gross_profit, cur.revenue - cur.direct_costs);
    assert.equal(cur.net_profit, cur.gross_profit - cur.opex);
    assert.equal(cur.opex, 1000);
    assert.equal(cur.cash_flow, cur.collected - cur.refunds - cur.opex);
    assert.ok(s.position.receivables >= 1500, 'o2 still owes 1500 (accrual revenue, not cash)');
    const pays = await ok('GET', `/api/payments?from=${today}&to=${today}&limit=500`);   // voided payments are excluded from the list by default
    assert.equal(cur.net_collected, pays.summary.net_base, 'every live payment counted exactly once, voided ones never');
    assert.notEqual(cur.revenue, cur.net_collected, 'accrual revenue and cash are different measures');
  });
  test('KPIs equal the sum of the underlying orders (drill-down consistency)', async () => {
    const a = await ok('GET', `/api/analytics?range=custom&from=${today}&to=${today}`);
    const list = await ok('GET', `/api/orders?recognized=1&from=${today}&to=${today}&limit=500`);
    assert.equal(a.kpis.revenue, list.summary.revenue_base); assert.equal(a.kpis.product_costs, list.summary.cost_base);
    assert.equal(a.kpis.recognized_orders, list.summary.count);
    assert.equal(a.series.revenue.reduce((x, y) => x + y, 0), a.kpis.revenue, 'chart series sum to KPI');
    assert.equal(a.kpis.gross_profit, a.kpis.revenue - a.kpis.product_costs);
  });
  test('changing the recognition rule changes revenue (configurable accounting)', async () => {
    const before_ = (await ok('GET', `/api/analytics?range=this_year`)).kpis.revenue;
    await ok('PUT', '/api/settings', { revenue_recognition: 'completed' });
    const mid = (await ok('GET', `/api/analytics?range=this_year`)).kpis.revenue;
    await ok('PUT', '/api/settings', { revenue_recognition: 'delivered' });
    assert.ok(mid < before_ && mid === 0); assert.equal((await ok('GET', `/api/analytics?range=this_year`)).kpis.revenue, before_);
  });
});

describe('inventory & alerts', () => {
  const notifs = async (type) => (await ok('GET', '/api/notifications?all=1&limit=300')).rows.filter((n) => n.type === type);
  test('low-stock alert is raised once (no duplicates while unresolved) and resolves after restock', async () => {
    await ok('POST', '/api/notifications/run-checks'); await ok('POST', '/api/notifications/run-checks');
    const low = (await notifs('low_stock')).filter((n) => n.dedupe_key === `stock_low:${gadget.id}`);
    assert.equal(low.length, 1); assert.equal(low[0].resolved_at, null);
    await ok('POST', `/api/products/${gadget.id}/stock`, { type: 'purchase', qty: 50, note: 'restock' });
    assert.ok((await notifs('low_stock')).filter((n) => n.dedupe_key === `stock_low:${gadget.id}`)[0].resolved_at, 'resolved after restock');
  });
  test('high stock alert fires above max and out-of-stock fires at zero', async () => {
    await ok('POST', `/api/products/${widget.id}/stock`, { type: 'purchase', qty: 500 });
    assert.equal((await notifs('high_stock')).filter((n) => n.dedupe_key === `stock_high:${widget.id}` && !n.resolved_at).length, 1);
    const p = await ok('POST', '/api/products', { name: 'Rare', cost: 1, price: 2, quantity: 1, min_stock: 0 });
    await ok('POST', `/api/products/${p.id}/stock`, { type: 'damage', qty: 1, note: 'broken' });
    assert.equal((await notifs('out_of_stock')).filter((n) => n.dedupe_key === `stock_out:${p.id}` && !n.resolved_at).length, 1);
    const mv = await ok('GET', `/api/products/${p.id}`); assert.deepEqual(mv.movements.map((m) => m.type).reverse(), ['initial', 'damage']);
  });
  test('stock adjustment sets the counted quantity and cannot go negative manually', async () => {
    const p = await ok('POST', '/api/products', { name: 'Counted', cost: 1, price: 2, quantity: 10 });
    const a = await ok('POST', `/api/products/${p.id}/stock`, { type: 'adjustment', new_quantity: 7, note: 'recount' }); assert.equal(a.quantity, 7);
    assert.equal((await c.post(`/api/products/${p.id}/stock`, { type: 'damage', qty: 99, note: 'x' })).status, 400);
  });
  test('overdue orders raise one alert and clear when delivered', async () => {
    const o = await ok('POST', '/api/orders', { customer_id: custB.id, status: 'Processing', expected_date: '2025-01-02', order_date: '2025-01-01', items: [{ description: 'Late', qty: 1, unit_price: 100 }] });
    await ok('POST', '/api/notifications/run-checks'); await ok('POST', '/api/notifications/run-checks');
    const n = (await notifs('order_overdue')).filter((x) => x.dedupe_key === `overdue:${o.id}`); assert.equal(n.length, 1);
    const pend = await ok('GET', '/api/orders/pending'); assert.ok(pend.groups.overdue.some((x) => x.id === o.id));
    await ok('POST', `/api/orders/${o.id}/status`, { status: 'Delivered' }); await ok('POST', '/api/notifications/run-checks');
    assert.ok((await notifs('order_overdue')).find((x) => x.dedupe_key === `overdue:${o.id}`).resolved_at);
  });
  test('new-order, payment and unusually large order events notify', async () => {
    assert.ok((await notifs('new_order')).length >= 3); assert.ok((await notifs('payment_received')).length >= 3);
    for (let i = 0; i < 5; i++) await ok('POST', '/api/orders', { customer_id: custB.id, status: 'Confirmed', items: [{ description: 'Baseline', qty: 1, unit_price: 1000 }] }); // large-order detection needs a baseline of >= 5 recent orders
    const big = await ok('POST', '/api/orders', { customer_id: custB.id, status: 'Confirmed', items: [{ description: 'Huge job', qty: 1, unit_price: 50_000_000 }] });
    assert.equal((await notifs('large_order')).filter((n) => n.dedupe_key === `large:${big.id}`).length, 1);
  });
});

describe('customer lifecycle classification', () => {
  test('active / at risk / inactive follow configurable thresholds', async () => {
    const mk = async (name, phone, daysAgo) => {
      const d = new Date(Date.parse(today + 'T00:00:00Z') - daysAgo * 864e5).toISOString().slice(0, 10);
      const cu = await ok('POST', '/api/customers', { name, phone });
      await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', order_date: d, items: [{ description: 'x', qty: 1, unit_price: 100 }] });
      return cu.id;
    };
    const a = await mk('Recent', '70 000 001', 5); const r = await mk('Risky', '70 000 002', 50); const i = await mk('Gone', '70 000 003', 100);
    const life = async (id) => (await ok('GET', `/api/customers/${id}`)).customer;
    assert.equal((await life(a)).lifecycle, 'Active'); assert.equal((await life(r)).lifecycle, 'At risk'); assert.equal((await life(i)).lifecycle, 'Inactive');
    assert.equal((await life(i)).status, 'Inactive', 'stored status follows behaviour');
    await ok('PUT', '/api/settings', { inactive_days: 120, at_risk_days: 60 });
    assert.equal((await life(i)).lifecycle, 'At risk'); assert.equal((await life(r)).lifecycle, 'Active');
    await ok('PUT', '/api/settings', { inactive_days: 60, at_risk_days: 45 });
    const list = await ok('GET', '/api/customers?lifecycle=Inactive'); assert.ok(list.rows.some((x) => x.id === i));
  });
  test('customers with history cannot be deleted, only archived', async () => {
    const r = await ok('DELETE', `/api/customers/${custA.id}`); assert.equal(r.archived, true);
    assert.equal((await ok('GET', `/api/customers/${custA.id}`)).customer.status, 'Archived');
    assert.equal((await c.post('/api/orders', { customer_id: custA.id, items: [{ description: 'x', qty: 1, unit_price: 1 }] })).status, 400);
  });
});

describe('refund safety', () => {
  test('a payment that has been refunded cannot be voided or lowered (paid can never go negative)', async () => {
    const cu = await ok('POST', '/api/customers', { name: 'Refunded Rita', phone: '70 616 161' });
    const o = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', items: [{ description: 'x', qty: 1, unit_price: 1000 }] });
    const p = await ok('POST', '/api/payments', { customer_id: cu.id, amount: 1000, method: 'Cash', allocations: [{ order_id: o.id, amount: 1000 }] });
    const rf = await ok('POST', '/api/payments', { customer_id: cu.id, type: 'refund', amount: 600, method: 'Cash', allocations: [{ order_id: o.id, amount: 600 }] });
    assert.equal((await ok('GET', `/api/orders/${o.id}`)).paid, 400);
    const v = await c.post(`/api/payments/${p.id}/void`, { reason: 'oops' }); assert.equal(v.status, 400); assert.match(v.data.error, /refunded/);
    const e = await c.put(`/api/payments/${p.id}`, { amount: 500, allocations: [{ order_id: o.id, amount: 500 }] }); assert.equal(e.status, 400);
    assert.equal((await ok('GET', `/api/orders/${o.id}`)).paid, 400, 'failed attempts changed nothing');
    assert.equal((await ok('GET', `/api/payments/${p.id}`)).voided, false);
    // raising the amount is fine; and once the refund is voided the original can be voided too
    await ok('PUT', `/api/payments/${p.id}`, { amount: 1000, allocations: [{ order_id: o.id, amount: 1000 }], reason: 'no change' });
    await ok('POST', `/api/payments/${rf.id}/void`, { reason: 'refund cancelled' }); await ok('POST', `/api/payments/${p.id}/void`, { reason: 'now fine' });
    assert.equal((await ok('GET', `/api/orders/${o.id}`)).paid, 0);
  });
  test('editing an order below what was already paid warns and turns the difference into refundable credit', async () => {
    const cu = await ok('POST', '/api/customers', { name: 'Edit Ed', phone: '70 717 171' });
    const o = await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Confirmed', items: [{ description: 'x', qty: 1, unit_price: 5000 }] });
    await ok('POST', '/api/payments', { customer_id: cu.id, amount: 5000, method: 'Cash', allocations: [{ order_id: o.id, amount: 5000 }] });
    const e = await ok('PUT', `/api/orders/${o.id}`, { items: [{ id: o.items[0].id, description: 'x', qty: 1, unit_price: 2000 }] });
    assert.equal(e.credit, 3000); assert.match(e.warning, /customer credit/);
    await ok('POST', '/api/payments', { customer_id: cu.id, type: 'refund', amount: 3000, method: 'Cash', allocations: [{ order_id: o.id, amount: 3000 }] });
    const after_ = await ok('GET', `/api/orders/${o.id}`); assert.equal(after_.balance, 0); assert.equal(after_.payment_status, 'Paid');
  });
});

describe('alert flood protection', () => {
  test('a large backlog produces at most 25 individual alerts plus one summary, and clears when fixed', async () => {
    const cu = await ok('POST', '/api/customers', { name: 'Backlog', phone: '70 555 111' }); const ids = [];
    for (let i = 0; i < 40; i++) ids.push((await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Processing', order_date: '2025-02-01', expected_date: '2025-02-03', items: [{ description: 'late', qty: 1, unit_price: 100 }] })).id);
    await ok('POST', '/api/notifications/run-checks'); await ok('POST', '/api/notifications/run-checks');
    const live = () => ok('GET', '/api/notifications?all=1&limit=300').then((r) => r.rows.filter((n) => n.type === 'order_overdue' && !n.resolved_at && ids.some((id) => n.dedupe_key === `overdue:${id}`)));
    assert.equal((await live()).length, 25, 'capped');
    const all_ = (await ok('GET', '/api/notifications?all=1&limit=300')).rows; const sum = all_.filter((n) => n.dedupe_key === 'overdue:summary' && !n.resolved_at);
    assert.equal(sum.length, 1); assert.match(sum[0].title, /more orders are overdue/);
    for (const id of ids) await ok('POST', `/api/orders/${id}/status`, { status: 'Delivered' });
    await ok('POST', '/api/notifications/run-checks');
    assert.equal((await live()).length, 0, 'individual alerts resolved'); assert.ok(!(await ok('GET', '/api/notifications?all=1&limit=300')).rows.some((n) => n.dedupe_key === 'overdue:summary' && !n.resolved_at), 'summary resolved');
  });
});

describe('dashboard cache', () => {
  test('is never stale: a write is reflected immediately in the next read', async () => {
    const q = `/api/analytics?range=custom&from=${today}&to=${today}&compare=none`;
    const a = await ok('GET', q); const a2 = await ok('GET', q); assert.deepEqual(a.kpis, a2.kpis, 'repeat read is stable');
    const cu = await ok('POST', '/api/customers', { name: 'Cache Tester', phone: '70 777 888' });
    await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', items: [{ description: 'x', qty: 1, unit_price: 12345, unit_cost: 0 }] });
    const b = await ok('GET', q); assert.equal(b.kpis.revenue, a.kpis.revenue + 12345); assert.equal(b.kpis.total_orders, a.kpis.total_orders + 1);
    await ok('POST', '/api/payments', { customer_id: cu.id, amount: 345, method: 'Cash', auto_allocate: true });
    assert.equal((await ok('GET', q)).kpis.collected, b.kpis.collected + 345);
  });
});

describe('oversold (negative) stock', () => {
  test('stock may go negative on a real sale, alerts fire, and recommendations never show negative days of cover', async () => {
    const p = await ok('POST', '/api/products', { name: 'Oversold item', cost: 100, price: 300, quantity: 1, min_stock: 1 });
    const cu = await ok('POST', '/api/customers', { name: 'Eve', phone: '70 321 321' });
    await ok('POST', '/api/orders', { customer_id: cu.id, status: 'Delivered', items: [{ product_id: p.id, qty: 4 }] });
    assert.equal((await ok('GET', `/api/products/${p.id}`)).product.quantity, -3);
    const ins = (await ok('GET', '/api/inventory/summary')).rows.find((x) => x.id === p.id);
    assert.equal(ins.stock_state, 'out'); assert.equal(ins.days_cover, 0);
    const r = (await ok('GET', '/api/recommendations?refresh=1')).rows.find((x) => x.rkey === `inventory:replenish:${p.id}`);
    assert.ok(r, 'replenishment advice exists'); assert.doesNotMatch(r.title + r.detected, /-\d+ days|-\d+ in stock/); assert.match(r.detected, /Oversold by 3/);
    assert.ok(r.data.suggested_order >= 3, 'suggested order covers the oversold quantity');
  });
});

describe('recommendations', () => {
  test('are generated from data with supporting facts and can be actioned', async () => {
    const r = await ok('GET', '/api/recommendations?refresh=1');
    assert.ok(r.rows.length > 0);
    for (const x of r.rows) { assert.ok(x.detected && x.why && x.action, x.title); if (x.benefit) assert.match(x.benefit, /estimate/i, 'benefits are labelled estimates'); }
    const first = r.rows[0];
    await ok('PUT', `/api/recommendations/${first.id}`, { status: 'scheduled', scheduled_for: '2099-01-01' });
    await ok('POST', '/api/recommendations/refresh');
    const again = (await ok('GET', '/api/recommendations')).rows.find((x) => x.id === first.id); assert.equal(again.status, 'scheduled', 'user decision survives regeneration');
    assert.equal((await c.post('/api/recommendations/ai', {})).status, 400, 'AI disabled without key');
  });
});
