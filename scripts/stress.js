// Load test: bulk-loads a large synthetic dataset into a throw-away DB, then times key endpoints (serial and concurrent).
// Usage: node --disable-warning=ExperimentalWarning scripts/stress.js [customers=5000] [orders=40000]
import { boot, Client } from '../tests/helpers.js';
const NC = Number(process.argv[2] || 5000); const NO = Number(process.argv[3] || 40000);
const t = await boot(); const c = new Client(t.base); const { run, get, tx } = t.db;
await c.ok('POST', '/api/auth/setup', { name: 'O', email: 'o@x.com', password: 'secret-pass-1', business_name: 'Load' });
const today = (await c.ok('GET', '/api/bootstrap')).today; const now = new Date().toISOString();
const day = (n) => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
let t0 = Date.now();
tx(() => {
  for (let i = 1; i <= 40; i++) run("INSERT INTO products(code,name,cost,price,currency,quantity,min_stock,status,created_at,updated_at) VALUES (?,?,?,?,'USD',1000,10,'Active',?,?)", 'P-' + i, 'Product ' + i, 500 + i * 10, 900 + i * 20, now, now);
  for (let i = 1; i <= NC; i++) run("INSERT INTO customers(code,name,phone,whatsapp,status,category,location,created_at,updated_at,registered_on) VALUES (?,?,?,?, 'Active',?,?,?,?,?)", 'C-' + i, 'Customer ' + i, '+9617' + String(1000000 + i), '+9617' + String(1000000 + i), ['Retail', 'Wholesale', 'VIP'][i % 3], ['Beirut', 'Saida', 'Tripoli'][i % 3], now, now, day(300));
  const st = ['Delivered', 'Delivered', 'Delivered', 'Completed', 'Pending', 'Confirmed', 'Cancelled'];
  for (let i = 1; i <= NO; i++) {
    const total = 1000 + (i % 50) * 137; const status = st[i % st.length]; const d = day(i % 360);
    const oid = run("INSERT INTO orders(number,customer_id,customer_phone,order_date,expected_date,delivery_date,status,currency,fx_rate,subtotal,net_revenue,total,total_cost,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'USD',1,?,?,?,?,1,?,?)", 'ORD-' + i, 1 + (i % NC), '+x', d, d, ['Delivered', 'Completed'].includes(status) ? d : null, status, total, total, total, Math.round(total * 0.6), now, now).lastInsertRowid;
    run('INSERT INTO order_items(order_id,product_id,description,qty,unit_price,unit_cost,line_total,line_cost) VALUES (?,?,?,?,?,?,?,?)', oid, 1 + (i % 40), 'Product', 1, total, Math.round(total * 0.6), total, Math.round(total * 0.6));
    if (i % 3 !== 0 && !['Cancelled', 'Pending'].includes(status)) { const pid = run("INSERT INTO payments(code,customer_id,type,amount,currency,fx_rate,method,paid_at,created_at,updated_at) VALUES (?,?, 'payment',?, 'USD',1,'Cash',?,?,?)", 'PAY-' + i, 1 + (i % NC), total, d, now, now).lastInsertRowid; run('INSERT INTO payment_allocations(payment_id,order_id,amount,applied_amount) VALUES (?,?,?,?)', pid, oid, total, total); }
  }
});
console.log(`loaded ${NC} customers / ${NO} orders in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const time = async (name, url, n = 1) => { const t1 = Date.now(); const rs = await Promise.all(Array.from({ length: n }, () => c.get(url))); const bad = rs.filter((r) => r.status !== 200).length; console.log(`${name.padEnd(34)} ${n > 1 ? `${n} concurrent: ` : ''}${Date.now() - t1} ms${bad ? `  !! ${bad} non-200` : ''}`); };
const R = 'range=this_year&compare=prev';
for (const [n, u] of [['orders list (page 1)', '/api/orders?limit=50'], ['orders search by name', '/api/orders?q=Customer%20123'], ['orders search by phone', '/api/orders?q=71000123'], ['orders recognized + range', `/api/orders?recognized=1&from=${day(90)}&to=${today}`], ['customers list (lifecycle calc)', '/api/customers?limit=50'], ['customers filter Inactive', '/api/customers?lifecycle=Inactive&limit=50'], ['customers sort spend', '/api/customers?sort=total_spent&limit=50'], ['customer profile', '/api/customers/5'], ['dashboard/analytics this year', `/api/analytics?${R}`], ['finance summary', `/api/finance/summary?${R}`], ['receivables', '/api/finance/receivables'], ['pending board', '/api/orders/pending'], ['inventory summary', '/api/inventory/summary'], ['payments list', '/api/payments?limit=50'], ['report daily_sales', '/api/reports/daily_sales?range=this_year'], ['report customer_activity xlsx', '/api/reports/customer_activity?format=xlsx'], ['report orders pdf', `/api/reports/orders?format=pdf&range=custom&from=${day(30)}&to=${today}`], ['WA segments (all customers)', '/api/whatsapp/segments']]) await time(n, u);
let t2 = Date.now(); const rec = await c.get('/api/recommendations?refresh=1'); console.log(`recommendations refresh`.padEnd(34), Date.now() - t2, 'ms', rec.status);
t2 = Date.now(); const chk = await c.post('/api/notifications/run-checks'); console.log(`alert checks`.padEnd(34), Date.now() - t2, 'ms', chk.status);
await time('dashboard x20 concurrent', `/api/analytics?${R}`, 20); await time('orders list x50 concurrent', '/api/orders?limit=50', 50);
console.log('db size MB', (await import('node:fs')).statSync(t.dir + '/test.sqlite').size / 1e6);
await t.close(); process.exit(0);
