import { GET, POST, PUT, DELETE } from '../http.js';
import { all, get, run, tx, audit, allSettings, nextCounter, fxRate, recognizedSql, recDateSql } from '../db.js';
import { bad, notFound, str, num, money, oneOf, date, nowIso, todayStr, pad, escLike, phoneDigits, convert, conflict, addDays } from '../util.js';
import { hasPerm } from '../perms.js';
import { createCustomer, refreshCustomerStatus, getCustomer } from './customers.js';
import { applyMovement } from './inventory.js';
import { checkStock, notify, avgAmountBase } from './notifications.js';
import { emit } from '../events.js';

export const STATUSES = ['Draft', 'Pending', 'Confirmed', 'Processing', 'Ready', 'Out for delivery', 'Delivered', 'Completed', 'Cancelled', 'Returned'];
export const OPEN = ['Pending', 'Confirmed', 'Processing', 'Ready', 'Out for delivery'];
const RANK = { Draft: 0, Pending: 1, Confirmed: 2, Processing: 3, Ready: 4, 'Out for delivery': 5, Delivered: 6, Completed: 7 };
const DEDUCT_AT = { Confirmed: 'Confirmed', Processing: 'Processing', 'Out for delivery': 'Out for delivery', Delivered: 'Delivered', Completed: 'Completed' };
const inList = (a) => a.map((s) => `'${s}'`).join(',');

/** Pure financial calculation for an order. All values are integer minor units of the order currency. */
export function computeTotals(items, { discount = 0, additional_charges = 0, delivery_fee = 0, extra_cost = 0, tax_rate = 0 } = {}) {
  let subtotal = 0; let itemCost = 0;
  const lines = items.map((it) => {
    const line_total = Math.round(it.qty * it.unit_price); const line_cost = Math.round(it.qty * it.unit_cost);
    subtotal += line_total; itemCost += line_cost;
    return { ...it, line_total, line_cost };
  });
  if (discount > subtotal + additional_charges) throw bad('Discount cannot be larger than the order value');
  const taxable = subtotal - discount + additional_charges;
  const tax = tax_rate ? Math.round((taxable * tax_rate) / 100) : 0;
  const net_revenue = taxable + delivery_fee;           // revenue excludes tax (tax is a liability, not income)
  const total = net_revenue + tax;                       // what the customer owes
  const total_cost = itemCost + extra_cost;
  return { lines, subtotal, tax, net_revenue, total, total_cost, gross_profit: net_revenue - total_cost };
}

function buildItems(raw, currency, fx, onDate, user, existing = []) {
  if (!Array.isArray(raw) || !raw.length) throw bad('Add at least one product or service to the order');
  if (raw.length > 100) throw bad('Too many items');
  const finance = hasPerm(user, 'finance:read');
  return raw.map((r, i) => {
    const n = `Item ${i + 1}`;
    const qty = num(r.qty, `${n} quantity`, { required: true, min: 0.001, max: 1e6 });
    let product = null;
    if (r.product_id) { product = get('SELECT * FROM products WHERE id=?', r.product_id); if (!product) throw bad(`${n}: product not found`); }
    const description = str(r.description || product?.name, `${n} description`, { required: true, max: 200 });
    let cost;
    const conv = (a) => (product && product.currency !== currency ? convert(a, fxRate(product.currency, onDate), fx) : a);
    if ((r.unit_price === undefined || r.unit_price === '') && !product) throw bad(`${n}: price is required`);
    const price = r.unit_price !== undefined && r.unit_price !== '' ? money(r.unit_price, `${n} price`) : conv(product.price);
    const prev = r.id ? existing.find((e) => e.id === r.id) : null;
    if (finance && r.unit_cost !== undefined && r.unit_cost !== '') cost = money(r.unit_cost, `${n} cost`);
    else if (prev) cost = prev.unit_cost;
    else cost = product ? conv(product.cost) : 0;
    return { product_id: product?.id ?? null, description, qty, unit_price: price, unit_cost: cost };
  });
}

function resolveCustomer(b, user) {
  if (b.customer_id) { const c = getCustomer(Number(b.customer_id)); if (!c) throw bad('Customer not found'); if (c.status === 'Archived') throw bad('This customer is archived'); return c; }
  if (b.customer && b.customer.phone) {
    // quick-create: reuse an existing customer with the same phone instead of creating a duplicate
    try { return createCustomer({ status: 'Potential', ...b.customer }, user); }
    catch (e) { if (e.status === 409 && e.details?.duplicate) return getCustomer(e.details.duplicate.id); throw e; }
  }
  throw bad('Choose a customer (search by phone number) or enter a new customer name and phone');
}

const shouldDeduct = (status) => {
  if (status in RANK && RANK[status] >= 1) return RANK[status] >= RANK[DEDUCT_AT[allSettings().stock_deduction] || 'Confirmed'];
  return false;
};

/** Idempotent stock ledger sync: makes stock deductions for this order equal what its status/items require. */
export function syncOrderStock(orderId, user, reason = '') {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  const want = new Map();
  if (shouldDeduct(o.status)) for (const it of all('SELECT product_id, SUM(qty) q FROM order_items WHERE order_id=? AND product_id IS NOT NULL GROUP BY product_id', orderId)) want.set(it.product_id, it.q);
  const have = new Map(all("SELECT product_id, -SUM(qty_change) q FROM inventory_movements WHERE reference_type='order' AND reference_id=? GROUP BY product_id", orderId).map((r) => [r.product_id, r.q]));
  const touched = [];
  for (const pid of new Set([...want.keys(), ...have.keys()])) {
    const diff = Math.round(((want.get(pid) || 0) - (have.get(pid) || 0)) * 1000) / 1000;
    if (diff === 0) continue;
    const type = diff > 0 ? 'sale' : (o.status === 'Returned' ? 'return' : 'order_cancel');
    applyMovement({ productId: pid, type, qtyChange: -diff, refType: 'order', refId: orderId, allowNegative: true, user, note: `${o.number}${reason ? ' - ' + reason : ''}` });
    touched.push(pid);
  }
  run('UPDATE orders SET stock_deducted=? WHERE id=?', shouldDeduct(o.status) ? 1 : 0, orderId);
  touched.forEach((p) => checkStock(p));
}

function addHistory(orderId, event, from, to, note, user) {
  run('INSERT INTO order_history(order_id,event,from_status,to_status,note,user_id,user_name,created_at) VALUES (?,?,?,?,?,?,?,?)', orderId, event, from, to, note || null, user?.id ?? null, user?.name ?? 'system', nowIso());
}

const orderRow = (id) => {
  const st = allSettings(); const today = todayStr(st.timezone);
  const r = get(`SELECT f.*, c.name AS customer_name, c.code AS customer_code, c.whatsapp AS customer_whatsapp,
      (f.revenue_base - f.cost_base) AS profit_base, (f.net_revenue - f.total_cost) AS gross_profit,
      CASE WHEN f.expected_date IS NOT NULL AND f.expected_date < ? AND f.status IN (${inList(OPEN)}) THEN 1 ELSE 0 END AS overdue,
      CASE WHEN f.balance < 0 THEN -f.balance ELSE 0 END AS credit
    FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id WHERE f.id=?`, today, id);
  return r ? { ...r, overdue: !!r.overdue } : null;
};
export function getOrder(id) {
  const o = orderRow(id); if (!o) return null;
  return {
    ...o,
    items: all('SELECT i.*, p.code AS product_code FROM order_items i LEFT JOIN products p ON p.id=i.product_id WHERE order_id=? ORDER BY i.id', id),
    history: all('SELECT * FROM order_history WHERE order_id=? ORDER BY id DESC', id),
    payments: all(`SELECT a.id, a.amount, a.applied_amount, p.id AS payment_id, p.code, p.type, p.method, p.paid_at, p.currency, p.voided, p.reference
       FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.order_id=? ORDER BY p.paid_at, p.id`, id),
    attribution: get('SELECT a.campaign_id, c.name AS campaign FROM campaign_attributions a JOIN whatsapp_campaigns c ON c.id=a.campaign_id WHERE a.order_id=?', id) || null,
  };
}

function fields(b, cur, user) {
  const st = allSettings(); const finance = hasPerm(user, 'finance:read');
  const order_date = date(b.order_date ?? cur?.order_date ?? todayStr(st.timezone), 'Order date', { required: true });
  const expected_date = b.expected_date !== undefined ? date(b.expected_date || null, 'Expected delivery date') : (cur?.expected_date ?? null);
  if (expected_date && expected_date < order_date) throw bad('Expected delivery date cannot be before the order date');
  const currency = oneOf(b.currency ?? cur?.currency ?? st.base_currency, 'Currency', st.currencies);
  return {
    order_date, expected_date, currency,
    discount: money(b.discount ?? cur?.discount ?? 0, 'Discount'),
    additional_charges: money(b.additional_charges ?? cur?.additional_charges ?? 0, 'Additional charges'),
    delivery_fee: money(b.delivery_fee ?? cur?.delivery_fee ?? 0, 'Delivery fee'),
    extra_cost: finance && b.extra_cost !== undefined ? money(b.extra_cost, 'Additional costs') : (cur?.extra_cost ?? 0),
    notes: str(b.notes ?? cur?.notes ?? '', 'Notes', { max: 2000 }),
    tax_rate: cur ? cur.tax_rate : (st.tax_enabled && !b.no_tax ? Number(st.tax_rate) : 0),
  };
}

function writeOrder(orderId, f, items) {
  const fx = fxRate(f.currency, f.order_date);
  const t = computeTotals(items, f);
  run('DELETE FROM order_items WHERE order_id=?', orderId);
  for (const l of t.lines) run('INSERT INTO order_items(order_id,product_id,description,qty,unit_price,unit_cost,line_total,line_cost) VALUES (?,?,?,?,?,?,?,?)', orderId, l.product_id, l.description, l.qty, l.unit_price, l.unit_cost, l.line_total, l.line_cost);
  run(`UPDATE orders SET order_date=?,expected_date=?,currency=?,fx_rate=?,subtotal=?,discount=?,additional_charges=?,delivery_fee=?,tax_rate=?,tax=?,net_revenue=?,total=?,extra_cost=?,total_cost=?,notes=?,updated_at=? WHERE id=?`,
    f.order_date, f.expected_date, f.currency, fx, t.subtotal, f.discount, f.additional_charges, f.delivery_fee, f.tax_rate, t.tax, t.net_revenue, t.total, f.extra_cost, t.total_cost, f.notes, nowIso(), orderId);
  return t;
}

export function createOrder(b, user) {
  const st = allSettings();
  return tx(() => {
    const customer = resolveCustomer(b, user);
    const status = oneOf(b.status, 'Status', STATUSES, { def: 'Pending' });
    if (status === 'Cancelled' || status === 'Returned') throw bad('A new order cannot start as Cancelled or Returned');
    const f = fields(b, null, user);
    const fx = fxRate(f.currency, f.order_date);
    const items = buildItems(b.items, f.currency, fx, f.order_date, user);
    const number = (st.order_prefix || 'ORD-') + pad(nextCounter('order'));
    const id = run(`INSERT INTO orders(number,customer_id,customer_phone,order_date,status,currency,fx_rate,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, number, customer.id, customer.phone, f.order_date, status, f.currency, fx, user?.id ?? null, nowIso(), nowIso()).lastInsertRowid;
    writeOrder(id, f, items);
    if (RANK[status] >= RANK.Delivered) run('UPDATE orders SET delivery_date=? WHERE id=?', b.delivery_date || f.order_date, id);
    addHistory(id, 'created', null, status, null, user);
    syncOrderStock(id, user);
    refreshCustomerStatus(customer.id);
    audit(user, 'create', 'order', id, null, { number, customer: customer.code, status, ...f });
    const o = getOrder(id);
    if (status !== 'Draft') afterCreate(o);
    return o;
  });
}
function afterCreate(o) {
  const st = allSettings();
  notify({ type: 'new_order', title: `New order ${o.number}`, body: `${o.customer_name} - ${(o.total / 100).toFixed(2)} ${o.currency}`, link: `#/orders?open=${o.id}`, entity_type: 'order', entity_id: o.id });
  const avg = avgAmountBase("SELECT AVG(due_base) avg, COUNT(*) n FROM v_orders_fin WHERE status NOT IN ('Draft','Cancelled','Returned') AND id<>? AND order_date>=?", o.id, addDays(todayStr(st.timezone), -90));
  if (avg && o.due_base > avg * Number(st.large_order_multiplier)) {
    notify({ type: 'large_order', title: `Unusually large order ${o.number}`, body: `${(o.due_base / 100).toFixed(2)} ${st.base_currency} is ${(o.due_base / avg).toFixed(1)}x the recent average.`, link: `#/orders?open=${o.id}`, entity_type: 'order', entity_id: o.id, dedupe_key: `large:${o.id}` });
  }
  emit('order.created', o);
}

export function updateOrder(id, b, user) {
  return tx(() => {
    const cur = get('SELECT * FROM orders WHERE id=?', id); if (!cur) throw notFound('Order');
    if (['Cancelled', 'Returned'].includes(cur.status)) throw bad(`A ${cur.status.toLowerCase()} order cannot be edited. Re-open it first by changing its status.`);
    const before = getOrder(id);
    const f = fields(b, cur, user);
    const existing = all('SELECT * FROM order_items WHERE order_id=?', id);
    const fx = fxRate(f.currency, f.order_date);
    const items = buildItems(b.items ?? existing.map((e) => ({ id: e.id, product_id: e.product_id, description: e.description, qty: e.qty, unit_price: e.unit_price })), f.currency, fx, f.order_date, user, existing);
    if (f.currency !== cur.currency && get('SELECT 1 x FROM payment_allocations WHERE order_id=? LIMIT 1', id)) throw bad('Currency cannot be changed after payments were recorded on this order');
    writeOrder(id, f, items);
    const after = get('SELECT total FROM orders WHERE id=?', id);
    const paid = get('SELECT paid FROM v_orders WHERE id=?', id).paid;
    if (paid > after.total && !['Draft'].includes(cur.status)) { /* over-paid after edit: allowed, shows as credit */ }
    addHistory(id, 'edited', cur.status, cur.status, `Total ${(before.total / 100).toFixed(2)} → ${(after.total / 100).toFixed(2)}`, user);
    syncOrderStock(id, user, 'order edited');
    if (b.status && b.status !== cur.status) setStatus(id, b.status, {}, user);
    refreshCustomerStatus(cur.customer_id);
    audit(user, 'update', 'order', id, { total: before.total, items: before.items.map((i) => [i.description, i.qty, i.unit_price]), ...pickF(before) }, { total: after.total, ...f });
    return getOrder(id);
  });
}
const pickF = (o) => ({ order_date: o.order_date, expected_date: o.expected_date, discount: o.discount, additional_charges: o.additional_charges, delivery_fee: o.delivery_fee });

export function setStatus(id, status, { note, reason, delivery_date } = {}, user) {
  oneOf(status, 'Status', STATUSES);
  return tx(() => {
    const cur = get('SELECT * FROM orders WHERE id=?', id); if (!cur) throw notFound('Order');
    if (cur.status === status) return getOrder(id);
    const today = todayStr(allSettings().timezone);
    let del = cur.delivery_date;
    if (status === 'Delivered' || status === 'Completed') del = date(delivery_date, 'Delivery date') || cur.delivery_date || today;
    else if ((RANK[status] ?? 99) < RANK.Delivered) del = null;
    run('UPDATE orders SET status=?, delivery_date=?, cancel_reason=?, updated_at=? WHERE id=?', status, del, status === 'Cancelled' ? str(reason, 'Reason', { max: 300 }) || null : null, nowIso(), id);
    addHistory(id, 'status', cur.status, status, note || reason, user);
    syncOrderStock(id, user, `status ${status}`);
    refreshCustomerStatus(cur.customer_id);
    audit(user, 'status', 'order', id, { status: cur.status }, { status }, note || reason);
    if (cur.status === 'Draft' && status !== 'Cancelled') afterCreate(getOrder(id));
    return getOrder(id);
  });
}

function duplicate(id, user) {
  const o = getOrder(id); if (!o) throw notFound('Order');
  const st = allSettings();
  return createOrder({
    customer_id: o.customer_id, status: 'Draft', currency: o.currency, order_date: todayStr(st.timezone), discount: o.discount, additional_charges: o.additional_charges,
    delivery_fee: o.delivery_fee, extra_cost: o.extra_cost, notes: o.notes,
    items: o.items.map((i) => ({ product_id: i.product_id, description: i.description, qty: i.qty, unit_price: i.unit_price, unit_cost: i.unit_cost })),
  }, user);
}

const SORTS = { order_date: 'f.order_date', number: 'f.id', total: 'f.total', balance: 'f.balance', status: 'f.status', customer: 'c.name COLLATE NOCASE', expected: 'f.expected_date' };
export function orderFilter(q, recogSql, recDate) {
  const st = allSettings(); const today = todayStr(st.timezone);
  const w = []; const p = [];
  if (q.q) {
    const l = `%${escLike(q.q)}%`; const d = phoneDigits(q.q);
    const parts = ["f.number LIKE ? ESCAPE '\\'", "c.name LIKE ? ESCAPE '\\'"]; p.push(l, l);
    if (d.length >= 3) { parts.push("REPLACE(f.customer_phone,'+','') LIKE ?", "REPLACE(c.phone,'+','') LIKE ?"); p.push(`%${d}%`, `%${d}%`); }
    w.push('(' + parts.join(' OR ') + ')');
  }
  if (q.status) { const s = String(q.status).split(',').filter((x) => STATUSES.includes(x)); if (s.length) w.push(`f.status IN (${inList(s)})`); }
  if (q.payment_status) { w.push('f.payment_status=?'); p.push(q.payment_status); }
  if (q.customer_id) { w.push('f.customer_id=?'); p.push(Number(q.customer_id)); }
  if (q.product_id) { w.push('f.id IN (SELECT order_id FROM order_items WHERE product_id=?)'); p.push(Number(q.product_id)); }
  if (q.category_id) { w.push('f.id IN (SELECT i.order_id FROM order_items i JOIN products pr ON pr.id=i.product_id WHERE pr.category_id=?)'); p.push(Number(q.category_id)); }
  if (q.overdue === '1') { w.push(`f.expected_date < '${today}' AND f.status IN (${inList(OPEN)})`); }
  if (q.unpaid === '1') w.push('f.balance>0');
  if (q.valid === '1') w.push("f.status NOT IN ('Draft','Cancelled','Returned')");
  if (q.recognized === '1') {
    w.push(recogSql); // revenue-recognised orders, filtered on the recognition date
    if (q.from) { w.push(`${recDate}>=?`); p.push(q.from); }
    if (q.to) { w.push(`${recDate}<=?`); p.push(q.to); }
  } else {
    if (q.from) { w.push('f.order_date>=?'); p.push(q.from); }
    if (q.to) { w.push('f.order_date<=?'); p.push(q.to); }
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}
export function listOrders(q) {
  const st = allSettings(); const today = todayStr(st.timezone);
  const { where, p } = orderFilter(q, recognizedSql('f'), recDateSql('f'));
  const sort = SORTS[q.sort] || 'f.id'; const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(q.limit) || 50, 1000); const offset = Number(q.offset) || 0;
  const from = 'FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id';
  return {
    summary: get(`SELECT COUNT(*) count, COALESCE(SUM(f.due_base),0) due_base, COALESCE(SUM(f.revenue_base),0) revenue_base, COALESCE(SUM(f.cost_base),0) cost_base,
        COALESCE(SUM(MAX(f.balance_base,0)),0) balance_base ${from} ${where}`, ...p),
    rows: all(`SELECT f.*, c.name AS customer_name, c.code AS customer_code, (f.revenue_base - f.cost_base) AS profit_base,
        CASE WHEN f.expected_date IS NOT NULL AND f.expected_date < '${today}' AND f.status IN (${inList(OPEN)}) THEN 1 ELSE 0 END AS overdue,
        (SELECT group_concat(description || ' x' || qty, ', ') FROM order_items WHERE order_id=f.id) AS items_summary
      ${from} ${where} ORDER BY ${sort} ${dir}, f.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map((r) => ({ ...r, overdue: !!r.overdue })),
  };
}

GET('/api/orders', { perm: 'orders:read' }, (ctx) => {
  const r = listOrders(ctx.query);
  return { ...r, summary: { ...r.summary } };
});
GET('/api/orders/pending', { perm: 'orders:read' }, () => {
  const today = todayStr(allSettings().timezone);
  const base = `SELECT f.id, f.number, f.order_date, f.expected_date, f.status, f.currency, f.total, f.balance, f.payment_status, c.name AS customer_name, c.phone AS customer_phone,
     CASE WHEN f.expected_date IS NOT NULL AND f.expected_date < '${today}' THEN CAST(julianday('${today}') - julianday(f.expected_date) AS INTEGER) ELSE 0 END AS days_late,
     CAST((julianday('${today}') - julianday(f.order_date)) AS INTEGER) AS age_days
     FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id`;
  const grp = (cond) => all(`${base} WHERE ${cond} ORDER BY f.expected_date IS NULL, f.expected_date, f.id LIMIT 200`);
  const g = {
    awaiting_confirmation: grp("f.status='Pending'"),
    processing: grp("f.status IN ('Confirmed','Processing')"),
    awaiting_delivery: grp("f.status IN ('Ready','Out for delivery')"),
    overdue: grp(`f.status IN (${inList(OPEN)}) AND f.expected_date < '${today}'`),
    unpaid: grp("f.status NOT IN ('Draft','Cancelled','Returned') AND f.balance>0"),
  };
  return { groups: g, counts: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length])) };
});
POST('/api/orders', { perm: 'orders:write', idem: true }, (ctx) => createOrder(ctx.body, ctx.user));
GET('/api/orders/:id', { perm: 'orders:read' }, (ctx) => { const o = getOrder(Number(ctx.params.id)); if (!o) throw notFound('Order'); return o; });
PUT('/api/orders/:id', { perm: 'orders:write' }, (ctx) => updateOrder(Number(ctx.params.id), ctx.body, ctx.user));
POST('/api/orders/:id/status', { perm: 'orders:write' }, (ctx) => setStatus(Number(ctx.params.id), ctx.body.status, ctx.body, ctx.user));
POST('/api/orders/:id/cancel', { perm: 'orders:write' }, (ctx) => {
  const o = setStatus(Number(ctx.params.id), 'Cancelled', { reason: ctx.body.reason }, ctx.user);
  return { ...o, warning: o.credit > 0 ? 'Payments were received for this order. Record a refund to settle the customer credit.' : undefined };
});
POST('/api/orders/:id/duplicate', { perm: 'orders:write', idem: true }, (ctx) => duplicate(Number(ctx.params.id), ctx.user));
DELETE('/api/orders/:id', { perm: 'orders:write' }, (ctx) => {
  const o = get('SELECT * FROM orders WHERE id=?', ctx.params.id); if (!o) throw notFound('Order');
  if (o.status !== 'Draft') throw bad('Only draft orders can be deleted. Cancel the order instead.');
  tx(() => { run('DELETE FROM orders WHERE id=?', o.id); audit(ctx.user, 'delete', 'order', o.id, o, null); });
  return { deleted: true };
});
