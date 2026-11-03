import { GET, POST } from '../http.js';
import { all, get, run, allSettings, recognizedSql, recDateSql, setting } from '../db.js';
import { nowIso, todayStr, addDays, diffDays, startOfMonth, endOfMonth, addMonths, notFound, hourIn } from '../util.js';
import { queueEmail } from '../mail.js';
import { log } from '../log.js';

const D = { enabled: true, in_app: true, email: false, whatsapp: false, frequency: 'immediate' };
export const NOTIFICATION_TYPES = {
  new_order: { label: 'New order created', severity: 'info' },
  order_pending_long: { label: 'Order pending too long', severity: 'warning' },
  order_overdue: { label: 'Order overdue', severity: 'critical' },
  unpaid_balance: { label: 'Customer has unpaid balance', severity: 'warning' },
  payment_received: { label: 'Payment received', severity: 'success' },
  low_stock: { label: 'Low stock', severity: 'warning' },
  high_stock: { label: 'Stock above maximum', severity: 'info' },
  out_of_stock: { label: 'Out of stock', severity: 'critical' },
  fast_moving: { label: 'Fast-moving product', severity: 'info' },
  slow_moving: { label: 'Slow-moving product', severity: 'info' },
  stock_anomaly: { label: 'Unusual stock change', severity: 'warning' },
  sales_target_exceeded: { label: 'Sales target reached', severity: 'success' },
  sales_below_target: { label: 'Sales below target', severity: 'warning' },
  large_order: { label: 'Unusually large order', severity: 'warning' },
  unusual_transaction: { label: 'Unusual financial transaction', severity: 'warning' },
  customer_inactive: { label: 'Customer became inactive', severity: 'info' },
  campaign_completed: { label: 'Campaign completed', severity: 'success' },
};
export function getRule(type) {
  return { ...D, ...(setting('notification_rules')?.[type] || {}) };
}
export function allRules() {
  return Object.fromEntries(Object.entries(NOTIFICATION_TYPES).map(([k, v]) => [k, { label: v.label, ...getRule(k) }]));
}

let ownerWhatsApp = null;
export const setOwnerWhatsAppSender = (fn) => { ownerWhatsApp = fn; };

export function notify({ type, title, body = '', severity, link = null, entity_type = null, entity_id = null, dedupe_key = null }) {
  const rule = getRule(type);
  if (!rule.enabled) return null;
  if (dedupe_key && get('SELECT id FROM notifications WHERE dedupe_key=? AND resolved_at IS NULL', dedupe_key)) return null;
  const sev = severity || NOTIFICATION_TYPES[type]?.severity || 'info';
  let id = null;
  if (rule.in_app || rule.email || rule.whatsapp) {
    id = run('INSERT INTO notifications(type,severity,title,body,link,entity_type,entity_id,dedupe_key,read_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      type, sev, title, body, link, entity_type, entity_id == null ? null : String(entity_id), dedupe_key, rule.in_app ? null : nowIso(), nowIso()).lastInsertRowid;
  }
  if (rule.email) {
    const st = allSettings(); const to = st.notification_recipients?.length ? st.notification_recipients : (st.owner_email ? [st.owner_email] : []);
    for (const addr of to) queueEmail({ to: addr, subject: `[${st.business_name}] ${title}`, body: `${title}\n\n${body}\n`, mode: rule.frequency === 'daily' ? 'daily' : 'immediate', notificationId: id });
  }
  if (rule.whatsapp && ownerWhatsApp) ownerWhatsApp(`${title}${body ? ' - ' + body : ''}`.slice(0, 900)).catch((e) => log.warn('owner whatsapp failed', e.message));
  return id;
}
export function resolveKey(key) {
  run('UPDATE notifications SET resolved_at=? WHERE dedupe_key=? AND resolved_at IS NULL', nowIso(), key);
}
/** Raise the alert while the condition holds, clear it when it stops holding. */
function ensure(key, cond, payload) {
  if (cond) { return notify({ ...payload, dedupe_key: key }) ? 1 : 0; }
  resolveKey(key); return 0;
}

// ---------------- scheduled checks ----------------
export function checkStock(productId) {
  const rows = productId ? all("SELECT * FROM products WHERE id=?", productId) : all("SELECT * FROM products WHERE status='Active'");
  let n = 0;
  for (const p of rows) {
    const act = p.status === 'Active';
    n += ensure(`stock_out:${p.id}`, act && p.quantity <= 0, { type: 'out_of_stock', title: `Out of stock: ${p.name}`, body: `${p.name} (${p.code}) has ${p.quantity} units.`, link: `#/products?id=${p.id}`, entity_type: 'product', entity_id: p.id });
    n += ensure(`stock_low:${p.id}`, act && p.quantity > 0 && p.min_stock > 0 && p.quantity <= p.min_stock, { type: 'low_stock', title: `Low stock: ${p.name}`, body: `${p.quantity} left, minimum is ${p.min_stock}.`, link: `#/products?id=${p.id}`, entity_type: 'product', entity_id: p.id });
    n += ensure(`stock_high:${p.id}`, act && p.max_stock != null && p.quantity > p.max_stock, { type: 'high_stock', title: `Stock above maximum: ${p.name}`, body: `${p.quantity} on hand, maximum is ${p.max_stock}.`, link: `#/products?id=${p.id}`, entity_type: 'product', entity_id: p.id });
  }
  return n;
}

export function checkMovement() {
  const st = allSettings(); const today = todayStr(st.timezone); let n = 0;
  const since = addDays(today, -30); const slowSince = addDays(today, -Number(st.slow_moving_days));
  const sales = all(`SELECT i.product_id id, SUM(CASE WHEN o.order_date>=? THEN i.qty ELSE 0 END) u30, MAX(o.order_date) last_sale
     FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status NOT IN ('Draft','Cancelled','Returned') AND i.product_id IS NOT NULL GROUP BY i.product_id`, since);
  const map = new Map(sales.map((s) => [s.id, s]));
  for (const p of all("SELECT * FROM products WHERE status='Active'")) {
    const s = map.get(p.id);
    n += ensure(`fast:${p.id}`, !!s && s.u30 >= Number(st.fast_moving_units_30d), { type: 'fast_moving', title: `Fast-moving: ${p.name}`, body: `${s?.u30} units sold in the last 30 days. Check you have enough stock.`, link: '#/products', entity_type: 'product', entity_id: p.id });
    const slow = p.quantity > 0 && (s ? s.last_sale < slowSince : p.created_at.slice(0, 10) < slowSince);
    n += ensure(`slow:${p.id}`, slow, { type: 'slow_moving', title: `Slow-moving: ${p.name}`, body: `${p.quantity} in stock with no sales in ${st.slow_moving_days} days.`, link: '#/products', entity_type: 'product', entity_id: p.id });
  }
  // unusual stock changes: manual adjustments/damage that remove a large share of stock in the last 3 days
  for (const m of all(`SELECT m.*, p.name FROM inventory_movements m JOIN products p ON p.id=m.product_id
       WHERE m.type IN ('adjustment','damage') AND m.created_at>=? AND m.qty_change<0`, new Date(Date.now() - 3 * 864e5).toISOString())) {
    const before = m.qty_after - m.qty_change;
    if (before > 0 && (-m.qty_change / before) * 100 >= Number(st.stock_anomaly_pct)) {
      n += ensure(`anomaly:${m.id}`, true, { type: 'stock_anomaly', title: `Unusual stock change: ${m.name}`, body: `${m.type} of ${m.qty_change} (${Math.round((-m.qty_change / before) * 100)}% of stock). Note: ${m.note || '-'}`, link: '#/products', entity_type: 'product', entity_id: m.product_id });
    }
  }
  return n;
}

export function checkOrders() {
  const st = allSettings(); const today = todayStr(st.timezone); let n = 0;
  const cutoff = new Date(Date.now() - Number(st.pending_hours_alert) * 3600e3).toISOString();
  const open = ['Pending', 'Confirmed', 'Processing', 'Ready', 'Out for delivery'];
  const CAP = 25; // individual alerts for the worst cases only, plus one summary: a big backlog must not bury the owner in thousands of alerts
  const capped = (type, prefix, rows, mk, summaryTitle, link) => {
    const keep = rows.slice(0, CAP);
    for (const o of keep) n += ensure(`${prefix}:${o.id}`, true, mk(o));
    const ids = keep.map((o) => String(o.id));
    run(`UPDATE notifications SET resolved_at=? WHERE type=? AND resolved_at IS NULL AND dedupe_key LIKE ? AND dedupe_key<>? AND entity_id NOT IN (${ids.length ? ids.map(() => '?').join(',') : "''"})`, nowIso(), type, `${prefix}:%`, `${prefix}:summary`, ...ids);
    n += ensure(`${prefix}:summary`, rows.length > CAP, { type, title: summaryTitle(rows.length - CAP), body: 'Open the Pending orders board for the full list.', link });
  };
  capped('order_pending_long', 'pending_long', all("SELECT id, number, created_at FROM orders WHERE status='Pending' AND created_at < ? ORDER BY created_at", cutoff),
    (o) => ({ type: 'order_pending_long', title: `Order ${o.number} pending for over ${st.pending_hours_alert}h`, body: 'Confirm or cancel this order.', link: `#/orders?open=${o.id}`, entity_type: 'order', entity_id: o.id }),
    (k) => `${k} more orders have been pending for over ${st.pending_hours_alert}h`, '#/orders?tab=pending');
  capped('order_overdue', 'overdue', all(`SELECT o.id, o.number, o.expected_date, o.status, c.name FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.expected_date < ? AND o.status IN (${open.map((x) => `'${x}'`).join(',')}) ORDER BY o.expected_date`, today),
    (o) => ({ type: 'order_overdue', title: `Order ${o.number} is overdue`, body: `${o.name} - expected ${o.expected_date} (${diffDays(o.expected_date, today)} days late), status ${o.status}.`, link: `#/orders?open=${o.id}`, entity_type: 'order', entity_id: o.id }),
    (k) => `${k} more orders are overdue`, '#/orders?overdue=1');
  // unpaid balances older than N days, grouped per customer
  const cut = addDays(today, -Number(st.unpaid_alert_days));
  const rows = all(`SELECT c.id, c.name, SUM(f.balance_base) bal, MIN(f.order_date) oldest FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id
     WHERE f.balance>0 AND f.order_date<=? AND f.status NOT IN ('Draft','Cancelled','Returned') GROUP BY c.id ORDER BY bal DESC`, cut);
  // One alert per customer for the biggest debts only: importing a large history must not bury the owner in thousands of alerts.
  const have = new Set();
  for (const r of rows.slice(0, CAP)) { have.add(r.id); n += ensure(`unpaid:${r.id}`, true, { type: 'unpaid_balance', title: `${r.name} has an unpaid balance`, body: `Outstanding ${(r.bal / 100).toFixed(2)} ${st.base_currency}; oldest order ${r.oldest}.`, link: `#/customers?open=${r.id}`, entity_type: 'customer', entity_id: r.id }); }
  for (const r of all("SELECT DISTINCT entity_id FROM notifications WHERE type='unpaid_balance' AND dedupe_key LIKE 'unpaid:%' AND resolved_at IS NULL")) if (!have.has(Number(r.entity_id))) resolveKey(`unpaid:${r.entity_id}`);
  const rest = rows.slice(CAP);
  n += ensure('unpaid:summary', rest.length > 0, { type: 'unpaid_balance', title: `${rest.length} more customers have unpaid balances`, body: `Together ${(rest.reduce((a, x) => a + x.bal, 0) / 100).toFixed(2)} ${st.base_currency}. See Payments & Finances → Receivables for the full list.`, link: '#/payments?tab=receivables' });
  return n;
}

function revenueBetween(a, b) {
  return get(`SELECT COALESCE(SUM(revenue_base),0) r FROM v_orders_fin o WHERE ${recognizedSql('o')} AND ${recDateSql('o')} BETWEEN ? AND ?`, a, b).r;
}
export function checkTargets() {
  const st = allSettings(); const today = todayStr(st.timezone); let n = 0;
  const cur = (v) => `${(v / 100).toFixed(2)} ${st.base_currency}`;
  if (st.daily_sales_target > 0) {
    const t = revenueBetween(today, today);
    n += ensure(`target_daily:${today}`, t >= st.daily_sales_target, { type: 'sales_target_exceeded', title: 'Daily sales target reached', body: `Today's sales ${cur(t)} (target ${cur(st.daily_sales_target)}).`, link: '#/dashboard' });
    const y = addDays(today, -1); const ty = revenueBetween(y, y);
    if (get('SELECT 1 x FROM orders WHERE order_date<=? LIMIT 1', y)) n += ensure(`below_daily:${y}`, ty < st.daily_sales_target, { type: 'sales_below_target', title: `Daily sales were below target (${y})`, body: `${cur(ty)} vs target ${cur(st.daily_sales_target)}.`, link: '#/analytics' });
  }
  if (st.monthly_sales_target > 0) {
    const ms = startOfMonth(today); const t = revenueBetween(ms, endOfMonth(today));
    n += ensure(`target_monthly:${ms}`, t >= st.monthly_sales_target, { type: 'sales_target_exceeded', title: 'Monthly sales target reached', body: `This month ${cur(t)} (target ${cur(st.monthly_sales_target)}).`, link: '#/dashboard' });
    const pm = addMonths(today, -1); const tp = revenueBetween(pm, endOfMonth(pm));
    if (get('SELECT 1 x FROM orders WHERE order_date<=? LIMIT 1', endOfMonth(pm))) n += ensure(`below_monthly:${pm}`, tp < st.monthly_sales_target, { type: 'sales_below_target', title: `Monthly sales were below target (${pm.slice(0, 7)})`, body: `${cur(tp)} vs target ${cur(st.monthly_sales_target)}.`, link: '#/analytics' });
  }
  return n;
}

export function checkInactive() {
  const st = allSettings(); const today = todayStr(st.timezone); let n = 0;
  const hi = addDays(today, -Number(st.inactive_days)); const lo = addDays(today, -Number(st.inactive_days) - 7);
  for (const c of all(`SELECT c.id, c.name, MAX(o.order_date) last FROM customers c JOIN orders o ON o.customer_id=c.id
      WHERE o.status NOT IN ('Draft','Cancelled','Returned') AND c.status<>'Archived' GROUP BY c.id HAVING last < ? AND last >= ?`, hi, lo)) {
    n += ensure(`inactive:${c.id}:${c.last}`, true, { type: 'customer_inactive', title: `${c.name} became inactive`, body: `Last purchase ${c.last}. Consider a reactivation message.`, link: `#/customers?open=${c.id}`, entity_type: 'customer', entity_id: c.id });
  }
  return n;
}

export function runChecks() {
  const out = { stock: checkStock(), movement: checkMovement(), orders: checkOrders(), targets: checkTargets(), inactive: checkInactive() };
  return out;
}

/** Event helpers called by the order/payment/expense services. */
export function avgAmountBase(sql, ...p) {
  const r = get(sql, ...p); return r && r.n >= 5 ? r.avg : null;
}
export function sendDailyDigest(force = false) {
  const st = allSettings(); const today = todayStr(st.timezone);
  if (!force && hourIn(st.timezone) !== Number(st.email_digest_hour)) return 0;
  const key = get("SELECT value FROM business_settings WHERE key='digest_last'")?.value;
  if (!force && key === JSON.stringify(today)) return 0;
  const rows = all("SELECT * FROM email_outbox WHERE mode='daily' AND status='pending' ORDER BY id");
  run("INSERT INTO business_settings(key,value) VALUES('digest_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(today));
  if (!rows.length) return 0;
  const byTo = {};
  for (const r of rows) (byTo[r.to_addr] ||= []).push(r);
  for (const [to, list] of Object.entries(byTo)) {
    queueEmail({ to, subject: `[${st.business_name}] Daily digest - ${list.length} alert(s)`, body: list.map((r) => `- ${r.subject.replace(/^\[.*?\]\s*/, '')}\n  ${r.body.split('\n').slice(2).join(' ').trim()}`).join('\n\n') });
  }
  run("UPDATE email_outbox SET status='sent', sent_at=?, error='included in daily digest' WHERE mode='daily' AND status='pending'", nowIso());
  return rows.length;
}

// ---------------- routes ----------------
const NR = { perm: 'notifications:read' };
GET('/api/notifications', NR, (ctx) => {
  const w = []; const p = [];
  if (ctx.query.unread === '1') w.push('read_at IS NULL');
  if (ctx.query.all !== '1') w.push('dismissed_at IS NULL');
  if (ctx.query.type) { w.push('type=?'); p.push(ctx.query.type); }
  if (ctx.query.severity) { w.push('severity=?'); p.push(ctx.query.severity); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Number(ctx.query.limit) || 100, 300);
  return { rows: all(`SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ?`, ...p, limit), types: Object.fromEntries(Object.entries(NOTIFICATION_TYPES).map(([k, v]) => [k, v.label])) };
});
GET('/api/notifications/unread-count', NR, () => ({ count: get('SELECT COUNT(*) c FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL').c }));
POST('/api/notifications/read-all', NR, () => { run('UPDATE notifications SET read_at=? WHERE read_at IS NULL', nowIso()); return { ok: true }; });
POST('/api/notifications/run-checks', NR, () => ({ created: runChecks() }));
POST('/api/notifications/:id/read', NR, (ctx) => { if (!get('SELECT id FROM notifications WHERE id=?', ctx.params.id)) throw notFound('Notification'); run('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?', nowIso(), ctx.params.id); return { ok: true }; });
POST('/api/notifications/:id/dismiss', NR, (ctx) => { run('UPDATE notifications SET read_at=COALESCE(read_at,?), dismissed_at=? WHERE id=?', nowIso(), nowIso(), ctx.params.id); return { ok: true }; });
GET('/api/notifications/rules', { perm: 'notifications:read' }, () => ({ rules: allRules() }));
GET('/api/notifications/outbox', { perm: 'settings:write' }, () => all('SELECT id,to_addr,subject,mode,status,error,created_at,sent_at FROM email_outbox ORDER BY id DESC LIMIT 50'));
