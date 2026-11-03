import { GET, POST, PUT } from '../http.js';
import { all, get, run, tx, audit, allSettings, nextCounter, fxRate } from '../db.js';
import { bad, notFound, str, money, oneOf, date, nowIso, todayStr, pad, escLike, phoneDigits, addDays, conflict } from '../util.js';
import { notify, avgAmountBase } from './notifications.js';
import { emit } from '../events.js';

const BASE_SQL = 'CAST(ROUND(p.amount*1.0/p.fx_rate) AS INTEGER)';

function parsePayment(b, cur) {
  const st = allSettings();
  const paid_at = date(b.paid_at ?? cur?.paid_at ?? todayStr(st.timezone), 'Payment date', { required: true });
  if (paid_at > addDays(todayStr(st.timezone), 1)) throw bad('Payment date cannot be in the future');
  const currency = oneOf(b.currency ?? cur?.currency ?? st.base_currency, 'Currency', st.currencies);
  const method = oneOf(b.method ?? cur?.method, 'Payment method', st.payment_methods);
  const amount = money(b.amount ?? cur?.amount, 'Amount', { required: true });
  if (amount <= 0) throw bad('Amount must be greater than zero');
  return { paid_at, currency, method, amount, reference: str(b.reference ?? cur?.reference ?? '', 'Reference', { max: 100 }), notes: str(b.notes ?? cur?.notes ?? '', 'Notes', { max: 500 }) };
}

/** Auto-allocate oldest-first. Returns [{order_id, amount}] in payment currency. */
function autoAllocate(customerId, amount, payFx, type) {
  const out = []; let left = amount;
  const orders = type === 'refund'
    ? all("SELECT id, paid, fx_rate FROM v_orders_fin WHERE customer_id=? AND paid>0 ORDER BY order_date DESC, id DESC", customerId)
    : all("SELECT id, balance, fx_rate FROM v_orders_fin WHERE customer_id=? AND balance>0 AND status NOT IN ('Draft','Cancelled','Returned') ORDER BY order_date, id", customerId);
  for (const o of orders) {
    if (left <= 0) break;
    const room = type === 'refund' ? o.paid : o.balance;               // order currency
    const roomInPay = Math.round((room / o.fx_rate) * payFx);         // payment currency
    const take = Math.min(left, roomInPay);
    if (take > 0) { out.push({ order_id: o.id, amount: take }); left -= take; }
  }
  return out;
}

/** Validate and write allocations for a payment (payment row must exist, with its old allocations already removed). */
function writeAllocations(payment, allocs) {
  let sum = 0; const seen = new Set();
  for (const a of allocs) {
    const amt = money(a.amount, 'Allocation amount'); if (amt <= 0) continue;
    const o = get('SELECT * FROM v_orders_fin WHERE id=?', Number(a.order_id)); if (!o) throw bad('Allocated order not found');
    if (o.customer_id !== payment.customer_id) throw bad(`Order ${o.number} belongs to a different customer`);
    if (seen.has(o.id)) throw bad(`Order ${o.number} is listed twice`); seen.add(o.id);
    let applied = Math.round((amt / payment.fx_rate) * o.fx_rate);
    if (payment.type === 'payment') {
      if (['Draft', 'Cancelled', 'Returned'].includes(o.status)) throw bad(`Order ${o.number} is ${o.status.toLowerCase()} and cannot receive payments`);
      if (applied > o.balance) { if (applied - o.balance <= 2) applied = o.balance; else throw bad(`Payment exceeds the remaining balance of ${o.number} (${(o.balance / 100).toFixed(2)} ${o.currency})`); }
    } else {
      if (applied > o.paid) { if (applied - o.paid <= 2) applied = o.paid; else throw bad(`Refund exceeds the amount paid on ${o.number} (${(o.paid / 100).toFixed(2)} ${o.currency})`); }
      applied = -applied;
    }
    sum += amt;
    if (applied === 0) continue;
    run('INSERT INTO payment_allocations(payment_id,order_id,amount,applied_amount) VALUES (?,?,?,?)', payment.id, o.id, amt, applied);
  }
  if (sum > payment.amount) throw bad('Allocated amount is larger than the payment amount');
  return sum;
}

/** Voiding or lowering a payment must never leave refunds exceeding what the customer actually paid. */
function assertNotOverRefunded(customerId) {
  const neg = get("SELECT number FROM v_orders WHERE customer_id=? AND paid < 0 AND status NOT IN ('Cancelled','Returned') LIMIT 1", customerId);
  if (neg) throw bad(`This would leave order ${neg.number} with more refunded than paid. Refunds were already issued against it: void or reduce the refund first.`);
  const net = get(`SELECT COALESCE(SUM(CASE type WHEN 'payment' THEN 1 ELSE -1 END * CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)),0) n FROM payments WHERE customer_id=? AND voided=0`, customerId).n;
  if (net < -1) throw bad('This would leave the customer with more refunded than paid in total. Void or reduce the related refund first.');
}

export function getPayment(id) {
  const p = get(`SELECT p.*, c.name AS customer_name, c.code AS customer_code, ${BASE_SQL} AS amount_base FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, id);
  if (!p) return null;
  const allocations = all('SELECT a.id, a.order_id, o.number, a.amount, a.applied_amount, o.currency AS order_currency FROM payment_allocations a JOIN orders o ON o.id=a.order_id WHERE a.payment_id=?', id);
  const allocated = allocations.reduce((s, a) => s + a.amount, 0);
  return { ...p, voided: !!p.voided, allocations, allocated, unallocated: p.amount - allocated, base_currency: allsettingsBase() };
}
const allsettingsBase = () => allSettings().base_currency;

export function createPayment(b, user) {
  const customerId = Number(b.customer_id);
  const cust = get('SELECT * FROM customers WHERE id=?', customerId); if (!cust) throw bad('Choose a customer');
  const type = oneOf(b.type, 'Type', ['payment', 'refund'], { def: 'payment' });
  const v = parsePayment(b);
  return tx(() => {
    const fx = fxRate(v.currency, v.paid_at);
    let allocs = Array.isArray(b.allocations) ? b.allocations : [];
    if (b.auto_allocate) allocs = autoAllocate(customerId, v.amount, fx, type);
    if (type === 'refund') {
      const net = get(`SELECT COALESCE(SUM(CASE type WHEN 'payment' THEN 1 ELSE -1 END * CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)),0) n FROM payments WHERE customer_id=? AND voided=0`, customerId).n;
      if (Math.round(v.amount / fx) > net + 1) throw bad('Refund is larger than the total this customer has paid');
    }
    const code = (type === 'refund' ? 'REF-' : 'PAY-') + pad(nextCounter('payment'));
    const id = run(`INSERT INTO payments(code,customer_id,type,amount,currency,fx_rate,method,paid_at,reference,notes,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, customerId, type, v.amount, v.currency, fx, v.method, v.paid_at, v.reference, v.notes, user?.id ?? null, nowIso(), nowIso()).lastInsertRowid;
    writeAllocations({ id, customer_id: customerId, type, amount: v.amount, fx_rate: fx }, allocs);
    audit(user, 'create', 'payment', id, null, { code, type, customer: cust.code, ...v, allocations: allocs });
    const pay = getPayment(id);
    flagPayment(pay, cust);
    emit('payment.created', pay);
    return pay;
  });
}
function flagPayment(p, cust) {
  const st = allSettings();
  if (p.type === 'payment') notify({ type: 'payment_received', title: `Payment ${p.code} from ${cust.name}`, body: `${(p.amount / 100).toFixed(2)} ${p.currency} via ${p.method}`, link: `#/payments?open=${p.id}`, entity_type: 'payment', entity_id: p.id });
  const avg = avgAmountBase(`SELECT AVG(${BASE_SQL}) avg, COUNT(*) n FROM payments p WHERE type='payment' AND voided=0 AND id<>? AND paid_at>=?`, p.id, addDays(todayStr(st.timezone), -90));
  const big = p.type === 'payment' && avg && p.amount_base > avg * Number(st.unusual_amount_multiplier);
  if (p.type === 'refund' || big) notify({ type: 'unusual_transaction', title: p.type === 'refund' ? `Refund ${p.code} recorded` : `Unusually large payment ${p.code}`, body: `${cust.name}: ${(p.amount / 100).toFixed(2)} ${p.currency}${big ? ` (${(p.amount_base / avg).toFixed(1)}x the recent average)` : ''}`, link: `#/payments?open=${p.id}`, entity_type: 'payment', entity_id: p.id, dedupe_key: `unusual_pay:${p.id}` });
}

export function updatePayment(id, b, user) {
  return tx(() => {
    const cur = get('SELECT * FROM payments WHERE id=?', id); if (!cur) throw notFound('Payment');
    if (cur.voided) throw bad('A voided payment cannot be edited');
    const before = getPayment(id);
    const v = parsePayment(b, cur);
    let fx = cur.fx_rate;
    if (v.currency !== cur.currency || v.paid_at !== cur.paid_at) fx = fxRate(v.currency, v.paid_at);
    run('DELETE FROM payment_allocations WHERE payment_id=?', id);
    run('UPDATE payments SET amount=?,currency=?,fx_rate=?,method=?,paid_at=?,reference=?,notes=?,updated_at=? WHERE id=?', v.amount, v.currency, fx, v.method, v.paid_at, v.reference, v.notes, nowIso(), id);
    let allocs = Array.isArray(b.allocations) ? b.allocations : before.allocations.map((a) => ({ order_id: a.order_id, amount: a.amount }));
    if (b.auto_allocate) allocs = autoAllocate(cur.customer_id, v.amount, fx, cur.type);
    writeAllocations({ id, customer_id: cur.customer_id, type: cur.type, amount: v.amount, fx_rate: fx }, allocs);
    assertNotOverRefunded(cur.customer_id);
    const after = getPayment(id);
    audit(user, 'update', 'payment', id, { amount: before.amount, currency: before.currency, method: before.method, paid_at: before.paid_at, allocations: before.allocations.map((a) => [a.number, a.amount]) },
      { amount: after.amount, currency: after.currency, method: after.method, paid_at: after.paid_at, allocations: after.allocations.map((a) => [a.number, a.amount]) }, str(b.reason, 'Reason', { max: 300 }));
    if (before.amount !== after.amount) notify({ type: 'unusual_transaction', title: `Payment ${after.code} was edited`, body: `Amount changed ${(before.amount / 100).toFixed(2)} → ${(after.amount / 100).toFixed(2)} ${after.currency} by ${user?.name}.`, link: `#/payments?open=${id}`, entity_type: 'payment', entity_id: id });
    return after;
  });
}

export function voidPayment(id, reason, user) {
  return tx(() => {
    const cur = get('SELECT * FROM payments WHERE id=?', id); if (!cur) throw notFound('Payment');
    if (cur.voided) throw bad('This payment is already voided');
    const why = str(reason, 'Reason', { required: true, max: 300 });
    run('UPDATE payments SET voided=1, void_reason=?, voided_at=?, voided_by=?, updated_at=? WHERE id=?', why, nowIso(), user?.id ?? null, nowIso(), id);
    if (cur.type === 'payment') assertNotOverRefunded(cur.customer_id);
    audit(user, 'void', 'payment', id, { amount: cur.amount, voided: false }, { voided: true }, why);
    notify({ type: 'unusual_transaction', title: `Payment ${cur.code} voided`, body: `${(cur.amount / 100).toFixed(2)} ${cur.currency}. Reason: ${why}`, link: `#/payments?open=${id}`, entity_type: 'payment', entity_id: id });
    return getPayment(id);
  });
}

export function listPayments(q) {
  const w = []; const p = [];
  if (q.q) { const l = `%${escLike(q.q)}%`; const d = phoneDigits(q.q); const parts = ["p.code LIKE ? ESCAPE '\\'", "p.reference LIKE ? ESCAPE '\\'", "c.name LIKE ? ESCAPE '\\'"]; p.push(l, l, l); if (d.length >= 3) { parts.push("REPLACE(c.phone,'+','') LIKE ?"); p.push(`%${d}%`); } w.push('(' + parts.join(' OR ') + ')'); }
  if (q.customer_id) { w.push('p.customer_id=?'); p.push(Number(q.customer_id)); }
  if (q.order_id) { w.push('p.id IN (SELECT payment_id FROM payment_allocations WHERE order_id=?)'); p.push(Number(q.order_id)); }
  if (q.method) { w.push('p.method=?'); p.push(q.method); }
  if (q.type) { w.push('p.type=?'); p.push(q.type); }
  if (q.currency) { w.push('p.currency=?'); p.push(q.currency); }
  if (q.from) { w.push('p.paid_at>=?'); p.push(q.from); }
  if (q.to) { w.push('p.paid_at<=?'); p.push(q.to); }
  if (q.voided !== '1') w.push('p.voided=0');
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Number(q.limit) || 50, 1000); const offset = Number(q.offset) || 0;
  const from = 'FROM payments p JOIN customers c ON c.id=p.customer_id';
  return {
    summary: get(`SELECT COUNT(*) count, COALESCE(SUM(CASE WHEN p.voided=0 THEN (CASE p.type WHEN 'payment' THEN 1 ELSE -1 END)*${BASE_SQL} ELSE 0 END),0) net_base ${from} ${where}`, ...p),
    rows: all(`SELECT p.*, c.name AS customer_name, c.code AS customer_code, ${BASE_SQL} AS amount_base,
      (SELECT group_concat(o.number, ', ') FROM payment_allocations a JOIN orders o ON o.id=a.order_id WHERE a.payment_id=p.id) AS orders,
      p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS unallocated
      ${from} ${where} ORDER BY p.paid_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map((r) => ({ ...r, voided: !!r.voided })),
  };
}

GET('/api/payments', { perm: 'payments:read' }, (ctx) => listPayments(ctx.query));
GET('/api/payments/methods', { perm: ['payments:read', 'payments:write'] }, () => ({ methods: allSettings().payment_methods, currencies: allSettings().currencies, base: allSettings().base_currency }));
GET('/api/payments/:id', { perm: 'payments:read' }, (ctx) => { const p = getPayment(Number(ctx.params.id)); if (!p) throw notFound('Payment'); return p; });
POST('/api/payments', { perm: 'payments:write', idem: true }, (ctx) => createPayment(ctx.body, ctx.user));
PUT('/api/payments/:id', { perm: 'payments:write' }, (ctx) => updatePayment(Number(ctx.params.id), ctx.body, ctx.user));
POST('/api/payments/:id/void', { perm: 'payments:write' }, (ctx) => voidPayment(Number(ctx.params.id), ctx.body.reason, ctx.user));
GET('/api/customers/:id/open-orders', { perm: ['payments:write', 'payments:read', 'orders:read'] }, (ctx) => {
  const refund = ctx.query.refundable === '1';
  return all(`SELECT id, number, order_date, status, currency, fx_rate, total, amount_due, paid, balance, payment_status FROM v_orders_fin
    WHERE customer_id=? AND ${refund ? 'paid>0' : "balance>0 AND status NOT IN ('Draft','Cancelled','Returned')"} ORDER BY order_date, id`, Number(ctx.params.id));
});
