// Creates a SEPARATE demo database (data/demo.sqlite) with fictional data. Never touches your real database.
// Run:  npm run seed:demo    then   npm run start:demo   (login: demo@example.com / demo-pass-123)
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.env.DB_PATH || 'data/demo.sqlite');
if (path.basename(target) !== 'demo.sqlite' && !process.env.FORCE_DEMO_SEED) { console.error(`Refusing to seed ${target}: demo data may only be written to a file named demo.sqlite (set FORCE_DEMO_SEED=1 to override).`); process.exit(1); }
process.env.DB_PATH = target;
for (const ext of ['', '-wal', '-shm']) fs.rmSync(target + ext, { force: true });

const { run, get, all, setSettings, tx } = await import('../server/db.js');
const { ensureRoles, hashPassword } = await import('../server/auth.js');
const { createCustomer, recordConsent } = await import('../server/services/customers.js');
const { createOrder, setStatus } = await import('../server/services/orders.js');
const { createPayment } = await import('../server/services/payments.js');
const { createExpense } = await import('../server/services/expenses.js');
const { ensureDefaultTemplates } = await import('../server/services/whatsapp.js');
const { runChecks } = await import('../server/services/notifications.js');
const { refreshRecommendations } = await import('../server/services/recommendations.js');
const { refreshAllCustomerStatuses } = await import('../server/services/customers.js');
const { addDays, todayStr, nowIso } = await import('../server/util.js');

ensureRoles(); ensureDefaultTemplates();
const owner = { id: 1, name: 'Demo Owner', role: 'OWNER', permissions: ['*'] };
run('INSERT INTO users(email,name,password_hash,role_id,created_at) VALUES (?,?,?,?,?)', 'demo@example.com', 'Demo Owner', hashPassword('demo-pass-123'), get("SELECT id FROM roles WHERE name='OWNER'").id, nowIso());
setSettings({ business_name: 'Demo Olive & Soap Co. (DEMO DATA)', is_demo: true, owner_email: 'demo@example.com', daily_sales_target: 15000, monthly_sales_target: 400000, tax_enabled: false });
run('INSERT INTO exchange_rates(currency,rate_per_base,effective_date,note,created_at) VALUES (?,?,?,?,?)', 'LBP', 89500, '2020-01-01', 'Demo rate', nowIso());

let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); const pick = (a) => a[Math.floor(rnd() * a.length)]; const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const today = todayStr('Asia/Beirut');

const cats = ['Food', 'Soap & care', 'Gifts'].map((n) => run('INSERT INTO product_categories(name) VALUES (?)', n).lastInsertRowid);
const sup = run("INSERT INTO suppliers(name,phone) VALUES ('Mountain Farms','+96170111222')").lastInsertRowid;
const P = [
  ['Olive oil 1L', 0, 900, 1500, 120, 30, 200], ['Olive oil 5L', 0, 4000, 6200, 40, 10, 80], ['Thyme (zaatar) 500g', 0, 350, 700, 90, 20, 150], ['Pomegranate molasses', 0, 400, 650, 60, 15, 100],
  ['Laurel soap', 1, 120, 300, 200, 40, 300], ['Rose soap', 1, 150, 380, 8, 20, 150], ['Hand cream', 1, 250, 400, 70, 15, 120], ['Gift basket small', 2, 1500, 2600, 25, 8, 50],
  ['Gift basket large', 2, 3200, 4800, 12, 5, 30], ['Honey 500g', 0, 700, 1100, 3, 10, 80], ['Dried figs 1kg', 0, 800, 950, 55, 10, 90], ['Candle set', 2, 300, 480, 160, 30, 120],
].map(([name, c, cost, price, qty, min, max]) => {
  const id = run(`INSERT INTO products(code,name,category_id,cost,price,currency,quantity,min_stock,max_stock,supplier_id,created_at,updated_at) VALUES (?,?,?,?,?,'USD',0,?,?,?,?,?)`, 'P-' + String(all('SELECT id FROM products').length + 1).padStart(4, '0'), name, cats[c], cost, price, min, max, sup, nowIso(), nowIso()).lastInsertRowid;
  run("INSERT INTO inventory_movements(product_id,type,qty_change,qty_after,note,created_at) VALUES (?, 'initial', ?, ?, 'Opening stock', ?)", id, qty * 12, qty * 12, nowIso()); run('UPDATE products SET quantity=? WHERE id=?', qty * 12, id); return id;
});
const names = ['Sara Haddad', 'Karim Nasr', 'Layal Khoury', 'Omar Fares', 'Nour Saade', 'Rami Abboud', 'Maya Aoun', 'Elie Gemayel', 'Dina Sleiman', 'Fadi Mansour', 'Hala Younes', 'Tony Chahine', 'Rita Karam', 'Jad Bassil', 'Joelle Matar', 'Walid Zein', 'Nadine Issa', 'Samir Hamdan', 'Carla Rizk', 'Georges Tabet', 'Mira Daher', 'Ziad Hobeika', 'Lina Bitar', 'Charbel Eid', 'Yara Salameh', 'Hadi Frem', 'Tala Obeid', 'Mazen Kassab', 'Rawan Harb', 'Peter Azar', 'Aya Mouawad', 'Bilal Kanaan', 'Cynthia Nader', 'Anis Daou', 'Reem Jaber'];
const places = ['Beirut', 'Jounieh', 'Tripoli', 'Saida', 'Zahle', 'Byblos'];
const customers = names.map((n, i) => createCustomer({ name: n, phone: `+9617${i % 2 ? 1 : 6}${String(100000 + i * 7919).slice(0, 6)}`, location: pick(places), category: pick(['Retail', 'Retail', 'Wholesale', 'VIP']), status: 'Potential', marketing_opt_in: i % 3 !== 0, consent_source: 'Demo: verbal consent at the shop' }, owner));
// a few explicit opt-outs
recordConsent(customers[3].id, 'opted_out', 'Demo: asked to stop', null, owner); recordConsent(customers[9].id, 'opted_out', 'Demo: replied STOP', null, owner);

// orders spread over the last ~130 days; some customers stop buying early so inactivity shows up
customers.forEach((c, ci) => {
  const lastActiveDaysAgo = ci % 6 === 0 ? int(70, 110) : ci % 7 === 0 ? int(48, 58) : int(0, 20);
  const freq = ci % 4 === 0 ? int(6, 12) : int(12, 30);
  for (let d = 130; d >= lastActiveDaysAgo; d -= int(freq, freq + 10)) {
    if (d > 130 - int(0, 60) && ci % 5 === 0) continue;
    const date = addDays(today, -d); const n = int(1, 3); const items = [];
    for (let k = 0; k < n; k++) { const p = pick(P); items.push({ product_id: p, qty: int(1, 4) }); }
    const unique = [...new Map(items.map((i) => [i.product_id, i])).values()];
    const rate = rnd(); const status = d < 3 ? pick(['Pending', 'Confirmed', 'Processing']) : d < 7 && rate < 0.3 ? 'Out for delivery' : rate < 0.04 ? 'Cancelled' : 'Completed';
    try {
      const o = createOrder({ customer_id: c.id, order_date: date, expected_date: addDays(date, 2), status: status === 'Cancelled' ? 'Confirmed' : status === 'Completed' ? 'Delivered' : status, items: unique, delivery_fee: rnd() < 0.5 ? 200 : 0, discount: rnd() < 0.15 ? 300 : 0, currency: rnd() < 0.08 ? 'LBP' : 'USD' }, owner);
      if (status === 'Cancelled') { setStatus(o.id, 'Cancelled', { reason: 'Customer changed their mind' }, owner); continue; }
      if (['Pending'].includes(status)) continue;
      const pay = rnd();
      if (pay < 0.72) createPayment({ customer_id: c.id, amount: Math.round(o.total / o.fx_rate), currency: 'USD', method: pick(['Cash', 'Cash', 'Bank transfer', 'Card']), paid_at: [addDays(date, int(0, 4)), today].sort()[0], allocations: [{ order_id: o.id, amount: Math.round(o.total / o.fx_rate) }] }, owner);
      else if (pay < 0.88) createPayment({ customer_id: c.id, amount: Math.round(o.total / o.fx_rate / 2), currency: 'USD', method: 'Cash', paid_at: date, allocations: [{ order_id: o.id, amount: Math.round(o.total / o.fx_rate / 2) }] }, owner);
    } catch (e) { /* skip combos that violate rules (e.g. rounding) */ if (process.env.DEBUG_SEED) console.error(e.message); }
  }
});
// expenses
for (let m = 0; m < 5; m++) {
  const d = addDays(today, -m * 30 - 3);
  createExpense({ category: 'Rent', description: 'Shop rent', amount: 25000, method: 'Bank transfer', paid_at: d, ...(m === 0 ? { recurring: 'monthly' } : {}) }, owner);
  createExpense({ category: 'Salaries', description: 'Staff salaries', amount: 60000 + m * 500, method: 'Cash', paid_at: d }, owner);
  createExpense({ category: 'Utilities', description: 'Electricity & internet', amount: 9000 + int(0, 2500), method: 'Cash', paid_at: d }, owner);
  createExpense({ category: 'Marketing', description: 'Social media ads', amount: 6000 + (m === 0 ? 9000 : 0), method: 'Card', paid_at: d }, owner);
}
// an overdue open order for demonstration
createOrder({ customer_id: customers[1].id, order_date: addDays(today, -8), expected_date: addDays(today, -4), status: 'Processing', items: [{ product_id: P[7], qty: 2 }] }, owner);
refreshAllCustomerStatuses(); refreshRecommendations();
// the seed itself generated one notification per order/payment: start the demo with a clean inbox, then let the real checks raise current alerts
run('DELETE FROM notifications'); run('DELETE FROM email_outbox');
runChecks();
const n = (t) => get(`SELECT COUNT(*) c FROM ${t}`).c;
console.log(`Demo database created at ${target}\n  ${n('customers')} customers, ${n('products')} products, ${n('orders')} orders, ${n('payments')} payments, ${n('expenses')} expenses\n  Start it with: npm run start:demo\n  Login: demo@example.com / demo-pass-123`);
