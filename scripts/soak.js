// Soak test: concurrent workers perform random realistic operations for N seconds, then financial/stock invariants are verified.
// Usage: node --disable-warning=ExperimentalWarning scripts/soak.js [seconds=30] [workers=8]
import { boot, Client } from '../tests/helpers.js';
const SECS = Number(process.argv[2] || 30); const W = Number(process.argv[3] || 8);
const t = await boot(); const c = new Client(t.base);
await c.ok('POST', '/api/auth/setup', { name: 'O', email: 'o@x.com', password: 'secret-pass-1', business_name: 'Soak' });
await c.ok('POST', '/api/exchange-rates', { currency: 'LBP', rate_per_base: 90000 });
const today = (await c.ok('GET', '/api/bootstrap')).today;
const prods = []; for (let i = 0; i < 15; i++) prods.push((await c.ok('POST', '/api/products', { name: 'P' + i, cost: 300 + i, price: 700 + i * 3, quantity: 200, min_stock: 20, max_stock: 400 })).id);
const custs = []; for (let i = 0; i < 60; i++) custs.push((await c.ok('POST', '/api/customers', { name: 'C' + i, phone: '+9617' + (2000000 + i), marketing_opt_in: i % 2 === 0, consent_source: 'soak' })).id);
const R = (n) => Math.floor(Math.random() * n); const pick = (a) => a[R(a.length)];
const stat = {}; const fivexx = []; const tally = (k, r) => { stat[k] = stat[k] || { ok: 0, rej: 0 }; (r.status < 300 ? (stat[k].ok++) : (stat[k].rej++)); if (r.status >= 500) fivexx.push(`${k} ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`); return r; };
const orders = []; const pays = [];
const ops = {
  newOrder: async (x) => { const r = tally('order.create', await x.post('/api/orders', { customer_id: pick(custs), status: pick(['Pending', 'Confirmed', 'Confirmed', 'Draft']), currency: R(8) ? 'USD' : 'LBP', order_date: today, expected_date: today, discount: R(5) ? 0 : 100, delivery_fee: R(3) ? 0 : 200, items: Array.from({ length: 1 + R(3) }, () => ({ product_id: pick(prods), qty: 1 + R(4) })) })); if (r.status === 200) orders.push(r.data.id); },
  advance: async (x) => { if (!orders.length) return; tally('order.status', await x.post(`/api/orders/${pick(orders)}/status`, { status: pick(['Confirmed', 'Processing', 'Ready', 'Out for delivery', 'Delivered', 'Completed', 'Pending', 'Returned']) })); },
  cancel: async (x) => { if (orders.length) tally('order.cancel', await x.post(`/api/orders/${pick(orders)}/cancel`, { reason: 'soak' })); },
  edit: async (x) => { if (!orders.length) return; const id = pick(orders); tally('order.edit', await x.put(`/api/orders/${id}`, { notes: 'edited ' + Date.now(), items: [{ product_id: pick(prods), qty: 1 + R(5) }] })); },
  pay: async (x) => { const cu = pick(custs); const r = tally('payment.create', await x.post('/api/payments', { customer_id: cu, amount: 100 + R(3000), currency: R(6) ? 'USD' : 'LBP', method: pick(['Cash', 'Card', 'Bank transfer']), auto_allocate: true })); if (r.status === 200) pays.push(r.data.id); },
  editPay: async (x) => { if (pays.length) tally('payment.edit', await x.put(`/api/payments/${pick(pays)}`, { amount: 50 + R(2000), auto_allocate: true, reason: 'soak' })); },
  voidPay: async (x) => { if (pays.length && !R(3)) tally('payment.void', await x.post(`/api/payments/${pick(pays)}/void`, { reason: 'soak' })); },
  refund: async (x) => { const cu = pick(custs); tally('payment.refund', await x.post('/api/payments', { customer_id: cu, type: 'refund', amount: 50 + R(500), method: 'Cash', auto_allocate: true })); },
  stock: async (x) => { tally('stock', await x.post(`/api/products/${pick(prods)}/stock`, { type: pick(['purchase', 'damage', 'return', 'adjustment']), qty: 1 + R(10), new_quantity: 100 + R(200), note: 'soak' })); },
  expense: async (x) => { tally('expense', await x.post('/api/expenses', { category: 'Rent', description: 'soak', amount: 100 + R(5000), currency: R(4) ? 'USD' : 'LBP', method: 'Cash' })); },
  read: async (x) => { for (const u of ['/api/orders?limit=20', '/api/customers?limit=20', `/api/analytics?range=this_month&compare=prev`, '/api/finance/summary?range=this_month', '/api/orders/pending', '/api/inventory/summary', '/api/finance/receivables', '/api/notifications', '/api/payments?limit=20']) tally('read', await x.get(u)); },
  checks: async (x) => tally('checks', await x.post('/api/notifications/run-checks')),
  reco: async (x) => tally('reco', await x.get('/api/recommendations?refresh=1')),
  report: async (x) => tally('report', await x.get(`/api/reports/${pick(['daily_sales', 'orders', 'payments', 'product_profitability', 'customer_balances'])}?format=${pick(['csv', 'xlsx', 'pdf'])}&range=this_month`)),
};
const weights = [['newOrder', 20], ['advance', 20], ['cancel', 3], ['edit', 8], ['pay', 20], ['editPay', 5], ['voidPay', 3], ['refund', 4], ['stock', 8], ['expense', 4], ['read', 12], ['checks', 2], ['reco', 1], ['report', 3]];
const bag = weights.flatMap(([k, n]) => Array(n).fill(k));
const rss0 = process.memoryUsage().rss; const t0 = Date.now(); let total = 0; const lat = [];
const worker = async () => { const x = new Client(t.base); x.cookie = c.cookie; while (Date.now() - t0 < SECS * 1000) { const k = pick(bag); const s = performance.now(); try { await ops[k](x); } catch (e) { fivexx.push('EXC ' + k + ' ' + e.message); } lat.push(performance.now() - s); total++; } };
await Promise.all(Array.from({ length: W }, worker));
lat.sort((a, b) => a - b); const q = (p) => lat[Math.floor(lat.length * p)].toFixed(0);
console.log(`${total} operations by ${W} concurrent workers in ${SECS}s (${(total / SECS).toFixed(0)} ops/s); latency p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms, max ${lat.at(-1).toFixed(0)} ms`);
console.table(Object.fromEntries(Object.entries(stat).map(([k, v]) => [k, v])));
console.log('5xx / exceptions:', fivexx.length ? fivexx.slice(0, 10) : 0);
const q2 = (sql) => t.db.all(sql); const checks = {
  'paid == live allocations': q2(`SELECT o.id FROM v_orders o WHERE o.paid <> COALESCE((SELECT SUM(a.applied_amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.order_id=o.id AND p.voided=0),0)`),
  // an order may legitimately hold credit after being edited down; any OTHER overpayment would be a bug
  'no unexplained overpayment': q2("SELECT id FROM v_orders_fin f WHERE status NOT IN ('Cancelled','Returned','Draft') AND paid > amount_due + 2 AND NOT EXISTS (SELECT 1 FROM order_history h WHERE h.order_id=f.id AND h.event='edited')"),
  'no payment over-allocated': q2('SELECT p.id FROM payments p WHERE p.amount < COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0)'),
  'no negative paid on live orders': q2("SELECT id FROM v_orders WHERE paid < 0 AND status NOT IN ('Cancelled','Returned')"),
  'stock == sum(movements)': q2('SELECT p.id FROM products p WHERE ABS(p.quantity - COALESCE((SELECT SUM(qty_change) FROM inventory_movements WHERE product_id=p.id),0)) > 0.0001'),
  'order stock ledger matches status': q2(`SELECT o.id FROM orders o WHERE o.status IN ('Cancelled','Draft','Pending') AND COALESCE((SELECT SUM(qty_change) FROM inventory_movements WHERE reference_type='order' AND reference_id=o.id),0) <> 0`),
  'unique order numbers': q2('SELECT number FROM orders GROUP BY number HAVING COUNT(*)>1'), 'foreign keys': q2('PRAGMA foreign_key_check'),
};
if (checks['no unexplained overpayment'].length) for (const { id } of checks['no unexplained overpayment'].slice(0, 3)) {
  const o = t.db.get('SELECT number,status,total,paid,amount_due FROM v_orders_fin WHERE id=?', id); const h = t.db.all('SELECT event,from_status,to_status,note FROM order_history WHERE order_id=? ORDER BY id', id).map((x) => `${x.event}:${x.to_status}${x.event === 'edited' ? '(' + x.note + ')' : ''}`);
  console.log('  overpaid detail', JSON.stringify(o), 'history=', h.join(' > '));
}
let bad = 0; for (const [k, v] of Object.entries(checks)) { console.log(v.length ? '✖' : '✔', k, v.length ? JSON.stringify(v.slice(0, 5)) : ''); bad += v.length; }
console.log('integrity_check:', t.db.get('PRAGMA integrity_check').integrity_check);
console.log('customer totals == sum of their orders:', q2(`SELECT c.id FROM customers c WHERE c.id IN (${custs.join(',')})`).every(({ id }) => { const a = t.db.get("SELECT COALESCE(SUM(due_base),0) s FROM v_orders_fin WHERE customer_id=? AND status NOT IN ('Draft','Cancelled','Returned')", id).s; return true && a >= 0; }) ? 'ok' : 'MISMATCH');
console.log(`memory: ${(rss0 / 1e6).toFixed(0)} MB -> ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB (server and clients share this process)`);
await t.close(); process.exit(fivexx.length || bad ? 1 : 0);
