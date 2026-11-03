import { GET, getDataVersion } from '../http.js';
import { all, get, allSettings, recognizedSql, recDateSql } from '../db.js';
import { resolveRange, compareRange, todayStr, diffDays, addDays, mondayOf, addMonths, startOfMonth, endOfMonth, pct } from '../util.js';
import { periodFinancials, receivablesNow, fxSnapshot } from './finance.js';

const OPEN = ['Pending', 'Confirmed', 'Processing', 'Ready', 'Out for delivery'];
const VALID = "status NOT IN ('Draft','Cancelled','Returned')";

export function makeBuckets(from, to) {
  const days = diffDays(from, to) + 1;
  const unit = days <= 62 ? 'day' : days <= 270 ? 'week' : 'month';
  const keyOf = (d) => (unit === 'day' ? d : unit === 'week' ? mondayOf(d) : d.slice(0, 7) + '-01');
  const step = (k) => (unit === 'day' ? addDays(k, 1) : unit === 'week' ? addDays(k, 7) : addMonths(k, 1));
  const list = []; let k = keyOf(from);
  while (k <= to) { list.push({ key: k, label: unit === 'month' ? k.slice(0, 7) : k.slice(5), end: unit === 'day' ? k : addDays(step(k), -1) }); k = step(k); }
  return { unit, keyOf, list, index: new Map(list.map((b, i) => [b.key, i])) };
}

function retentionRate(prev, cur) {
  const a = new Set(all(`SELECT DISTINCT customer_id id FROM orders WHERE ${VALID} AND order_date BETWEEN ? AND ?`, prev.from, prev.to).map((r) => r.id));
  if (!a.size) return { rate: null, base: 0, retained: 0 };
  const b = new Set(all(`SELECT DISTINCT customer_id id FROM orders WHERE ${VALID} AND order_date BETWEEN ? AND ?`, cur.from, cur.to).map((r) => r.id));
  let kept = 0; for (const id of a) if (b.has(id)) kept++;
  return { rate: (kept / a.size) * 100, base: a.size, retained: kept };
}

export function computeKpis(r) {
  const fin = periodFinancials(r.from, r.to);
  const pos = receivablesNow();
  const cnt = get(`SELECT COUNT(CASE WHEN status<>'Draft' THEN 1 END) total,
      COUNT(CASE WHEN status IN (${OPEN.map((s) => `'${s}'`).join(',')}) THEN 1 END) pending,
      COUNT(CASE WHEN status IN ('Delivered','Completed') THEN 1 END) completed,
      COUNT(CASE WHEN status='Cancelled' THEN 1 END) cancelled, COUNT(CASE WHEN status='Returned' THEN 1 END) returned
    FROM orders WHERE order_date BETWEEN ? AND ?`, r.from, r.to);
  const cust = get(`SELECT COUNT(CASE WHEN lifecycle='Active' THEN 1 END) active, COUNT(CASE WHEN lifecycle='At risk' THEN 1 END) at_risk, COUNT(CASE WHEN lifecycle='Inactive' THEN 1 END) inactive, COUNT(CASE WHEN lifecycle='Prospect' THEN 1 END) prospects FROM (${customerLifecycleSql()})`);
  const prev = compareRange(r, 'prev');
  return {
    total_orders: cnt.total, pending_orders: cnt.pending, completed_orders: cnt.completed, cancelled_orders: cnt.cancelled, returned_orders: cnt.returned,
    revenue: fin.revenue, collected: fin.net_collected, gross_collected: fin.collected, refunds: fin.refunds,
    outstanding: pos.receivables, product_costs: fin.direct_costs, opex: fin.opex, gross_profit: fin.gross_profit, net_profit: fin.net_profit,
    gross_margin_pct: fin.gross_margin_pct, cash_flow: fin.cash_flow, recognized_orders: fin.recognized_orders,
    avg_order_value: fin.recognized_orders ? Math.round(fin.revenue / fin.recognized_orders) : 0,
    active_customers: cust.active + cust.at_risk, inactive_customers: cust.inactive, at_risk_customers: cust.at_risk, prospects: cust.prospects,
    retention: retentionRate(prev, r), pipeline_value: pos.pipeline_value, customer_credit: pos.customer_credit,
  };
}
const customerLifecycleSql = () => {
  const st = allSettings(); const today = todayStr(st.timezone);
  return `SELECT c.id, CASE WHEN c.status='Archived' THEN 'Archived' WHEN s.last IS NULL THEN 'Prospect'
     WHEN julianday('${today}')-julianday(s.last) > ${Number(st.inactive_days)} THEN 'Inactive'
     WHEN julianday('${today}')-julianday(s.last) > ${Number(st.at_risk_days)} THEN 'At risk' ELSE 'Active' END lifecycle
   FROM customers c LEFT JOIN (SELECT customer_id, MAX(order_date) last FROM orders WHERE ${VALID} GROUP BY customer_id) s ON s.customer_id=c.id`;
};

export function series(r, b) {
  const rec = recognizedSql('o'); const rd = recDateSql('o');
  const N = b.list.length; const z = () => new Array(N).fill(0);
  const S = { revenue: z(), direct_costs: z(), gross_profit: z(), opex: z(), net_profit: z(), orders: z(), collected: z(), outstanding: z(), new_customers: z(), returning_customers: z() };
  const add = (arr, date, v) => { const i = b.index.get(b.keyOf(date)); if (i != null) arr[i] += v; };
  // everything is pre-aggregated per day in SQL, so JS only ever handles a few hundred rows
  for (const o of all(`SELECT ${rd} d, SUM(revenue_base) rev, SUM(cost_base) cost FROM v_orders_fin o WHERE ${rec} AND ${rd} BETWEEN ? AND ? GROUP BY d`, r.from, r.to)) { add(S.revenue, o.d, o.rev); add(S.direct_costs, o.d, o.cost); }
  for (const e of all('SELECT paid_at d, SUM(CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)) v FROM expenses WHERE paid_at BETWEEN ? AND ? GROUP BY d', r.from, r.to)) add(S.opex, e.d, e.v);
  for (const p of all("SELECT paid_at d, SUM(CASE type WHEN 'payment' THEN 1 ELSE -1 END * CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)) v FROM payments WHERE voided=0 AND paid_at BETWEEN ? AND ? GROUP BY d", r.from, r.to)) add(S.collected, p.d, p.v);
  for (const o of all("SELECT order_date d, COUNT(*) n FROM orders WHERE status<>'Draft' AND order_date BETWEEN ? AND ? GROUP BY d", r.from, r.to)) add(S.orders, o.d, o.n);
  for (let i = 0; i < N; i++) { S.gross_profit[i] = S.revenue[i] - S.direct_costs[i]; S.net_profit[i] = S.gross_profit[i] - S.opex[i]; }
  // receivables at the end of each bucket (current order values; allocations dated at the later of payment and order date)
  const dues = all(`SELECT order_date d, SUM(due_base) v FROM v_orders_fin WHERE ${VALID} AND order_date<=? GROUP BY d ORDER BY d`, r.to);
  const paids = all(`SELECT MAX(p.paid_at, o.order_date) d, SUM(CAST(ROUND(a.applied_amount*1.0/o.fx_rate) AS INTEGER)) v FROM payment_allocations a
      JOIN payments p ON p.id=a.payment_id AND p.voided=0 JOIN orders o ON o.id=a.order_id WHERE o.status NOT IN ('Draft','Cancelled','Returned') AND o.order_date<=? GROUP BY d ORDER BY d`, r.to);
  const today = todayStr(allSettings().timezone);
  b.list.forEach((bk, i) => {
    const at = bk.end > today ? today : bk.end;
    let due = 0; for (const o of dues) { if (o.d > at) break; due += o.v; }
    let paid = 0; for (const a of paids) { if (a.d > at) break; paid += a.v; }
    S.outstanding[i] = bk.key > today ? null : due - paid;
  });
  // new vs returning: one row per (customer, bucket) with the bucket computed in SQL
  const bkt = b.unit === 'day' ? 'order_date' : b.unit === 'week' ? "date(order_date, '-' || ((CAST(strftime('%w', order_date) AS INTEGER) + 6) % 7) || ' days')" : "substr(order_date,1,7) || '-01'";
  const first = new Map(all(`SELECT customer_id id, MIN(order_date) f FROM orders WHERE ${VALID} GROUP BY customer_id`).map((x) => [x.id, b.keyOf(x.f)]));
  for (const o of all(`SELECT customer_id id, ${bkt} k FROM orders WHERE ${VALID} AND order_date BETWEEN ? AND ? GROUP BY customer_id, k`, r.from, r.to)) {
    const i = b.index.get(o.k); if (i == null) continue;
    if (first.get(o.id) === b.list[i].key) S.new_customers[i]++; else S.returning_customers[i]++;
  }
  return S;
}

export function breakdowns(r) {
  const rec = recognizedSql('o'); const rd = recDateSql('o');
  const line = `FROM order_items i JOIN v_orders_fin o ON o.id=i.order_id LEFT JOIN products p ON p.id=i.product_id LEFT JOIN product_categories pc ON pc.id=p.category_id WHERE ${rec} AND ${rd} BETWEEN ? AND ?`;
  const rev = 'SUM(CAST(ROUND(i.line_total*1.0/o.fx_rate) AS INTEGER))'; const cost = 'SUM(CAST(ROUND(i.line_cost*1.0/o.fx_rate) AS INTEGER))';
  const products = all(`SELECT COALESCE(p.name, i.description) name, i.product_id id, SUM(i.qty) units, ${rev} revenue, ${cost} cost, ${rev}-${cost} profit ${line} GROUP BY COALESCE(i.product_id,'d'||i.description) ORDER BY revenue DESC LIMIT 50`, r.from, r.to);
  const categories = all(`SELECT COALESCE(pc.name,'Uncategorised / services') name, ${rev} revenue, ${rev}-${cost} profit ${line} GROUP BY pc.id ORDER BY revenue DESC`, r.from, r.to);
  const customers = all(`SELECT c.id, c.name, COUNT(*) orders, SUM(o.revenue_base) revenue FROM v_orders_fin o JOIN customers c ON c.id=o.customer_id WHERE ${rec} AND ${rd} BETWEEN ? AND ? GROUP BY c.id ORDER BY revenue DESC LIMIT 15`, r.from, r.to);
  const groups = all(`SELECT COALESCE(NULLIF(c.category,''),'Uncategorised') name, SUM(o.revenue_base) revenue, COUNT(DISTINCT c.id) customers FROM v_orders_fin o JOIN customers c ON c.id=o.customer_id WHERE ${rec} AND ${rd} BETWEEN ? AND ? GROUP BY 1 ORDER BY revenue DESC`, r.from, r.to);
  const expenses = all('SELECT category name, SUM(CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)) total FROM expenses WHERE paid_at BETWEEN ? AND ? GROUP BY category ORDER BY total DESC', r.from, r.to);
  const weekday = all(`SELECT CAST(strftime('%w', ${rd}) AS INTEGER) wd, SUM(revenue_base) revenue, COUNT(*) orders FROM v_orders_fin o WHERE ${rec} AND ${rd} BETWEEN ? AND ? GROUP BY wd ORDER BY wd`, r.from, r.to);
  return { products, best_sellers: [...products].sort((a, b) => b.units - a.units).slice(0, 10), categories, customers, customer_groups: groups, expenses, weekday };
}

export function monthlyRetention(to) {
  const end = startOfMonth(to); const first = addMonths(end, -12);
  // one query: which customers bought in which month
  const byMonth = new Map();
  for (const x of all(`SELECT customer_id id, substr(order_date,1,7) m FROM orders WHERE ${VALID} AND order_date>=? AND order_date<=? GROUP BY customer_id, m`, first, endOfMonth(to))) (byMonth.get(x.m) || byMonth.set(x.m, new Set()).get(x.m)).add(x.id);
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(end, -i).slice(0, 7); const pm = addMonths(end, -i - 1).slice(0, 7);
    const a = byMonth.get(pm) || new Set(); const bset = byMonth.get(m) || new Set(); let kept = 0; for (const id of a) if (bset.has(id)) kept++;
    out.push({ month: m, base: a.size, retained: kept, rate: a.size ? (kept / a.size) * 100 : null });
  }
  return out;
}

const delta = (cur, prev) => (prev ? ((cur - prev) / Math.abs(prev)) * 100 : (cur ? null : 0));
export function analytics(q) {
  const st = allSettings();
  const r = resolveRange(q, st.timezone);
  const b = makeBuckets(r.from, r.to);
  const kpis = computeKpis(r);
  const out = { range: r, bucket: b.unit, labels: b.list.map((x) => x.key), kpis, series: series(r, b), ...breakdowns(r), monthly_retention: monthlyRetention(r.to), fx: fxSnapshot(), recognition_rule: st.revenue_recognition };
  if (q.compare && q.compare !== 'none') {
    const cr = compareRange(r, q.compare); const cb = makeBuckets(cr.from, cr.to);
    const ck = computeKpis(cr);
    out.compare = { range: cr, kpis: ck, series: series(cr, cb), labels: cb.list.map((x) => x.key), deltas: Object.fromEntries(['revenue', 'collected', 'gross_profit', 'net_profit', 'total_orders', 'avg_order_value', 'opex', 'product_costs'].map((k) => [k, delta(kpis[k], ck[k])])) };
  }
  // targets
  const today = todayStr(st.timezone);
  const rev = (a, z) => get(`SELECT COALESCE(SUM(revenue_base),0) v FROM v_orders_fin o WHERE ${recognizedSql('o')} AND ${recDateSql('o')} BETWEEN ? AND ?`, a, z).v;
  out.targets = {
    daily: { target: st.daily_sales_target, actual: rev(today, today) },
    monthly: { target: st.monthly_sales_target, actual: rev(startOfMonth(today), endOfMonth(today)) },
  };
  return out;
}

// The dashboard is the heaviest read. Cache per query; any write request (or 30 s, for background jobs) invalidates it.
const cache = new Map();
export function cachedAnalytics(q) {
  const key = JSON.stringify([q.range, q.from, q.to, q.compare]); const hit = cache.get(key); const v = getDataVersion();
  if (hit && hit.v === v && Date.now() - hit.at < 30000) return hit.data;
  const data = analytics(q); if (cache.size > 50) cache.clear(); cache.set(key, { v, at: Date.now(), data }); return data;
}
GET('/api/analytics', { perm: ['dashboard:read', 'analytics:read'] }, (ctx) => cachedAnalytics(ctx.query));
GET('/api/kpi-definitions', { perm: ['dashboard:read', 'analytics:read'] }, () => {
  const rule = allSettings().revenue_recognition;
  const ruleText = { confirmed: 'Confirmed, Processing, Ready, Out for delivery, Delivered or Completed', delivered: 'Delivered or Completed', completed: 'Completed' }[rule];
  return [
    { key: 'revenue', name: 'Total sales revenue', formula: `Σ (qty × unit price) − discounts + additional charges + delivery fees, for orders that are recognised (${ruleText}), dated by recognition date. Tax is excluded.`, note: 'Unpaid orders still count as sales, but never as cash.' },
    { key: 'collected', name: 'Total collected', formula: 'Σ payments received − Σ refunds, by payment date (voided payments excluded).', note: 'This is actual money received, regardless of which order it pays.' },
    { key: 'outstanding', name: 'Outstanding balances (receivables)', formula: 'Σ max(0, order amount due − payments allocated) over all open, non-cancelled orders, as of today.', note: 'Cancelled/returned/draft orders owe nothing. A cancelled order that was paid shows as customer credit, not as negative receivables.' },
    { key: 'product_costs', name: 'Product costs (direct costs)', formula: 'Σ (qty × unit cost snapshot) + order additional costs, for recognised orders.', note: 'Cost is snapshotted on each order line so later price changes do not rewrite history.' },
    { key: 'gross_profit', name: 'Gross profit', formula: 'Revenue − direct costs.', note: 'Never calculated from revenue alone.' },
    { key: 'opex', name: 'Operating expenses', formula: 'Σ expenses by expense date (rent, salaries, marketing, …).', note: 'Direct product costs are not double counted here. Record stock purchases as inventory, not as expenses.' },
    { key: 'net_profit', name: 'Net profit', formula: 'Gross profit − operating expenses.', note: 'An accounting measure. Compare with cash flow.' },
    { key: 'cash_flow', name: 'Cash flow', formula: 'Payments collected − refunds − expenses paid.', note: 'Does not include stock purchases unless you record them as expenses. Differs from net profit when customers owe you money.' },
    { key: 'avg_order_value', name: 'Average order value', formula: 'Revenue ÷ number of recognised orders in the period.', note: '' },
    { key: 'total_orders', name: 'Total orders', formula: 'Orders created in the period (by order date), excluding drafts.', note: '' },
    { key: 'pending_orders', name: 'Pending orders', formula: 'Orders created in the period still in Pending, Confirmed, Processing, Ready or Out for delivery.', note: '' },
    { key: 'completed_orders', name: 'Completed orders', formula: 'Orders created in the period with status Delivered or Completed.', note: '' },
    { key: 'active_customers', name: 'Active customers', formula: `Customers whose last purchase was within ${allSettings().inactive_days} days (Active + At risk). Snapshot as of today.`, note: `At risk = no purchase for more than ${allSettings().at_risk_days} days.` },
    { key: 'inactive_customers', name: 'Inactive customers', formula: `Customers with at least one purchase whose last purchase was more than ${allSettings().inactive_days} days ago. Snapshot as of today.`, note: '' },
    { key: 'retention', name: 'Customer retention rate', formula: 'Customers who bought in the previous period of equal length AND again in this period ÷ customers who bought in the previous period.', note: 'Shown as "n/a" when there were no customers in the previous period.' },
    { key: 'fx', name: 'Currency conversion', formula: `Every amount is converted to ${allSettings().base_currency} using the exchange rate stored on the order/payment/expense when it was recorded.`, note: 'Cash received in another currency can therefore differ slightly from the base value of the order it pays (exchange gain/loss).' },
  ];
});
