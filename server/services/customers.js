import { GET, POST, PUT, DELETE } from '../http.js';
import { all, get, run, tx, audit, allSettings, nextCounter } from '../db.js';
import { bad, notFound, str, oneOf, date, normPhone, phoneDigits, nowIso, todayStr, pad, escLike, conflict, diffDays } from '../util.js';

export const STATUSES = ['Active', 'Inactive', 'Potential', 'Archived'];

/** Per-customer statistics are always derived from v_orders_fin / payments — never stored. */
const STATS_JOIN = `
LEFT JOIN (SELECT customer_id, COUNT(*) orders, SUM(due_base) spend_base, SUM(MAX(balance_base,0)) outstanding_base,
                  MAX(order_date) last_purchase, MIN(order_date) first_purchase
           FROM v_orders_fin WHERE status NOT IN ('Draft','Cancelled','Returned') GROUP BY customer_id) s ON s.customer_id=c.id
LEFT JOIN (SELECT customer_id, SUM(CASE type WHEN 'payment' THEN 1 ELSE -1 END * CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)) paid_base
           FROM payments WHERE voided=0 GROUP BY customer_id) pm ON pm.customer_id=c.id`;

export function customerSelect() {
  const st = allSettings(); const today = todayStr(st.timezone);
  return `SELECT c.*, COALESCE(s.orders,0) AS total_orders, COALESCE(s.spend_base,0) AS total_spent,
    COALESCE(pm.paid_base,0) AS total_paid, COALESCE(s.outstanding_base,0) AS outstanding,
    CASE WHEN COALESCE(s.orders,0)>0 THEN CAST(ROUND(s.spend_base*1.0/s.orders) AS INTEGER) ELSE 0 END AS avg_order_value,
    s.last_purchase, s.first_purchase,
    CASE WHEN s.last_purchase IS NULL THEN NULL ELSE CAST(julianday('${today}')-julianday(s.last_purchase) AS INTEGER) END AS days_since_purchase,
    CASE WHEN c.status='Archived' THEN 'Archived' WHEN COALESCE(s.orders,0)=0 THEN 'Prospect'
         WHEN julianday('${today}')-julianday(s.last_purchase) > ${Number(st.inactive_days)} THEN 'Inactive'
         WHEN julianday('${today}')-julianday(s.last_purchase) > ${Number(st.at_risk_days)} THEN 'At risk' ELSE 'Active' END AS lifecycle,
    CASE WHEN COALESCE(s.orders,0)>=${Number(st.loyal_orders)} OR COALESCE(s.spend_base,0)>=${Number(st.loyal_spend)} THEN 1 ELSE 0 END AS is_loyal,
    (SELECT group_concat(tag, ',') FROM customer_tags t WHERE t.customer_id=c.id) AS tags,
    (SELECT status FROM customer_consent cc WHERE cc.customer_id=c.id AND cc.channel='whatsapp' AND cc.type='marketing' ORDER BY cc.id DESC LIMIT 1) AS marketing_consent
  FROM customers c ${STATS_JOIN}`;
}
const shape = (r) => ({ ...r, tags: r.tags ? r.tags.split(',') : [], is_loyal: !!r.is_loyal });

export function getCustomer(id) {
  const r = get(`SELECT * FROM (${customerSelect()}) WHERE id=?`, id);
  return r ? shape(r) : null;
}

function findDuplicate(numbers, exceptId = 0) {
  for (const n of numbers.filter(Boolean)) {
    const d = get('SELECT id, code, name, phone FROM customers WHERE id<>? AND (phone=? OR phone2=? OR whatsapp=?)', exceptId, n, n, n);
    if (d) return d;
  }
  return null;
}

function parseCustomer(b, existing) {
  const cc = allSettings().default_country_code;
  const phone = normPhone(str(b.phone ?? existing?.phone, 'Phone', { required: true }), cc);
  const phone2 = b.phone2 !== undefined ? (b.phone2 ? normPhone(b.phone2, cc) : null) : (existing?.phone2 ?? null);
  let whatsapp = b.whatsapp !== undefined ? (b.whatsapp ? normPhone(b.whatsapp, cc) : null) : (existing ? existing.whatsapp : phone);
  if (b.whatsapp_same === true) whatsapp = phone;
  return {
    name: str(b.name ?? existing?.name, 'Name', { required: true, max: 120 }),
    phone, phone2, whatsapp,
    address: str(b.address ?? existing?.address ?? '', 'Address', { max: 300 }),
    location: str(b.location ?? existing?.location ?? '', 'Location', { max: 120 }),
    category: str(b.category ?? existing?.category ?? '', 'Category', { max: 60 }),
    notes: str(b.notes ?? existing?.notes ?? '', 'Notes', { max: 2000 }),
    status: oneOf(b.status ?? existing?.status, 'Status', STATUSES, { def: 'Potential' }),
  };
}
function setTags(id, tags) {
  if (!Array.isArray(tags)) return;
  run('DELETE FROM customer_tags WHERE customer_id=?', id);
  for (const t of [...new Set(tags.map((x) => String(x).trim().slice(0, 40)).filter(Boolean))]) run('INSERT INTO customer_tags VALUES (?,?)', id, t);
}

export function recordConsent(customerId, status, source, evidence, user) {
  const c = get('SELECT id, whatsapp, phone FROM customers WHERE id=?', customerId); if (!c) throw notFound('Customer');
  if (!source) throw bad('A consent source is required (e.g. "Verbal at counter", "Signed form", "Customer WhatsApp message")');
  tx(() => {
    run('INSERT INTO customer_consent(customer_id,status,source,evidence,created_at,created_by) VALUES (?,?,?,?,?,?)', customerId, status, source, evidence || null, nowIso(), user?.id ?? null);
    const num = c.whatsapp || c.phone;
    if (status === 'opted_out') {
      run('INSERT INTO suppression_list(customer_id,phone,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(phone) DO UPDATE SET customer_id=excluded.customer_id, reason=excluded.reason, created_at=excluded.created_at', customerId, num, source, nowIso());
    } else {
      run('DELETE FROM suppression_list WHERE phone=? OR customer_id=?', num, customerId);
    }
    audit(user, status, 'consent', customerId, null, { source, evidence });
  });
}

export function createCustomer(b, user) {
  const v = parseCustomer(b);
  const dup = findDuplicate([v.phone, v.phone2, v.whatsapp]);
  if (dup) throw conflict(`This phone number already belongs to ${dup.name} (${dup.code})`, { duplicate: dup });
  const st = allSettings();
  return tx(() => {
    const code = 'C-' + pad(nextCounter('customer'));
    const id = run(`INSERT INTO customers(code,name,phone,phone2,whatsapp,address,location,category,notes,status,created_at,updated_at,registered_on)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, v.name, v.phone, v.phone2, v.whatsapp, v.address, v.location, v.category, v.notes, v.status, nowIso(), nowIso(), todayStr(st.timezone)).lastInsertRowid;
    setTags(id, b.tags);
    if (b.marketing_opt_in) recordConsent(id, 'opted_in', str(b.consent_source, 'Consent source', { required: true }), str(b.consent_evidence, 'evidence', { max: 300 }), user);
    audit(user, 'create', 'customer', id, null, { code, ...v });
    return getCustomer(id);
  });
}

/** Keep stored status in sync with purchase behaviour (Archived/Potential-without-orders are manual). */
export function refreshCustomerStatus(id) {
  const c = getCustomer(id); if (!c || c.status === 'Archived') return;
  const st = allSettings();
  let next = c.status;
  if (c.total_orders > 0) next = c.days_since_purchase > st.inactive_days ? 'Inactive' : 'Active';
  if (next !== c.status) run('UPDATE customers SET status=?, updated_at=? WHERE id=?', next, nowIso(), id);
}
export function refreshAllCustomerStatuses() {
  const st = allSettings();
  const rows = all(`SELECT id, status, lifecycle FROM (${customerSelect()}) WHERE status<>'Archived' AND total_orders>0`);
  let n = 0;
  for (const r of rows) {
    const next = r.lifecycle === 'Inactive' ? 'Inactive' : 'Active';
    if (next !== r.status) { run('UPDATE customers SET status=?, updated_at=? WHERE id=?', next, nowIso(), r.id); n++; }
  }
  return n;
}

const SORTS = { name: 'name COLLATE NOCASE', total_spent: 'total_spent', outstanding: 'outstanding', last_purchase: 'last_purchase', total_orders: 'total_orders', created: 'id' };
export function listCustomers(q) {
  const w = []; const p = [];
  if (q.q) {
    const digits = phoneDigits(q.q);
    const parts = ['name LIKE ? ESCAPE \'\\\'', 'code LIKE ? ESCAPE \'\\\''];
    p.push(`%${escLike(q.q)}%`, `%${escLike(q.q)}%`);
    if (digits.length >= 3) { parts.push('REPLACE(phone,\'+\',\'\') LIKE ?', 'REPLACE(COALESCE(phone2,\'\'),\'+\',\'\') LIKE ?', 'REPLACE(COALESCE(whatsapp,\'\'),\'+\',\'\') LIKE ?'); p.push(`%${digits}%`, `%${digits}%`, `%${digits}%`); }
    w.push('(' + parts.join(' OR ') + ')');
  }
  if (q.status) { w.push('status=?'); p.push(q.status); }
  if (q.lifecycle) { w.push('lifecycle=?'); p.push(q.lifecycle); }
  if (q.category) { w.push('category=?'); p.push(q.category); }
  if (q.location) { w.push('location LIKE ?'); p.push(`%${q.location}%`); }
  if (q.tag) { w.push('id IN (SELECT customer_id FROM customer_tags WHERE tag=?)'); p.push(q.tag); }
  if (q.balance === '1') w.push('outstanding>0');
  if (q.loyal === '1') w.push('is_loyal=1');
  if (q.consent) { w.push(q.consent === 'none' ? 'marketing_consent IS NULL' : 'marketing_consent=?'); if (q.consent !== 'none') p.push(q.consent); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const sort = SORTS[q.sort] || 'id'; const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(q.limit) || 50, 500); const offset = Number(q.offset) || 0;
  const base = `(${customerSelect()})`;
  return {
    total: get(`SELECT COUNT(*) c FROM ${base} ${where}`, ...p).c,
    rows: all(`SELECT * FROM ${base} ${where} ORDER BY ${sort} ${dir} NULLS LAST, id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map(shape),
  };
}

function profile(id) {
  const c = getCustomer(id); if (!c) throw notFound('Customer');
  const orders = all('SELECT id, number, order_date, expected_date, delivery_date, status, currency, total, amount_due, paid, balance, payment_status FROM v_orders_fin WHERE customer_id=? ORDER BY order_date DESC, id DESC LIMIT 200', id);
  const payments = all(`SELECT p.id, p.code, p.type, p.amount, p.currency, p.method, p.paid_at, p.reference, p.voided,
      (SELECT group_concat(o.number, ', ') FROM payment_allocations a JOIN orders o ON o.id=a.order_id WHERE a.payment_id=p.id) AS orders,
      p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0) AS unallocated
    FROM payments p WHERE p.customer_id=? ORDER BY p.paid_at DESC, p.id DESC LIMIT 200`, id);
  const products = all(`SELECT COALESCE(p.name, i.description) AS name, i.product_id, SUM(i.qty) AS qty, SUM(i.line_total) AS total, MAX(o.order_date) AS last_date, o.currency
      FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.id=i.product_id
      WHERE o.customer_id=? AND o.status NOT IN ('Draft','Cancelled','Returned') GROUP BY COALESCE(i.product_id,'x'||i.description), o.currency ORDER BY last_date DESC`, id);
  const dates = all("SELECT DISTINCT order_date d FROM orders WHERE customer_id=? AND status NOT IN ('Draft','Cancelled','Returned') ORDER BY d", id).map((r) => r.d);
  let avgInterval = null;
  if (dates.length > 1) avgInterval = Math.round(diffDays(dates[0], dates[dates.length - 1]) / (dates.length - 1));
  const messages = all('SELECT id, direction, kind, body, status, error, created_at, campaign_id FROM whatsapp_messages WHERE customer_id=? ORDER BY id DESC LIMIT 50', id);
  const consent = all('SELECT status, source, evidence, created_at FROM customer_consent WHERE customer_id=? ORDER BY id DESC', id);
  const lastInbound = get("SELECT created_at FROM whatsapp_messages WHERE customer_id=? AND direction='in' ORDER BY id DESC LIMIT 1", id)?.created_at || null;
  const candidates = [c.last_purchase, payments[0]?.paid_at, messages[0]?.created_at?.slice(0, 10)].filter(Boolean).sort();
  const credit = all(`SELECT p.currency, SUM(CASE p.type WHEN 'payment' THEN 1 ELSE -1 END * (p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=p.id),0))) AS amount
      FROM payments p WHERE p.customer_id=? AND p.voided=0 GROUP BY p.currency HAVING amount>0`, id);
  const events = all('SELECT e.id, e.type, e.detail, e.created_at, u.name AS user_name FROM customer_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.customer_id=? ORDER BY e.id DESC LIMIT 50', id);
  return {
    customer: c, orders, payments, products, messages, consent, credit, events,
    frequency: { purchase_dates: dates.length, avg_days_between_orders: avgInterval },
    last_interaction: candidates.length ? candidates[candidates.length - 1] : null,
    whatsapp_window_open: lastInbound ? Date.now() - Date.parse(lastInbound) < 24 * 3600e3 : false,
    suppressed: !!get('SELECT 1 x FROM suppression_list WHERE customer_id=? OR phone=?', id, c.whatsapp || c.phone),
  };
}

GET('/api/customers', { perm: 'customers:read' }, (ctx) => listCustomers(ctx.query));
GET('/api/customers/lookup', { perm: ['customers:read', 'orders:write'] }, (ctx) => {
  const cc = allSettings().default_country_code; let n;
  try { n = normPhone(ctx.query.phone, cc); } catch { return { found: false, valid: false }; }
  const d = get('SELECT id, code, name, phone FROM customers WHERE phone=? OR phone2=? OR whatsapp=?', n, n, n);
  return { found: !!d, valid: true, normalized: n, customer: d || null };
});
GET('/api/customers/meta', { perm: 'customers:read' }, () => ({
  categories: allSettings().customer_categories,
  locations: all("SELECT DISTINCT location FROM customers WHERE location<>'' ORDER BY location").map((r) => r.location),
  tags: all('SELECT DISTINCT tag FROM customer_tags ORDER BY tag').map((r) => r.tag),
}));
POST('/api/customers', { perm: 'customers:write', idem: true }, (ctx) => createCustomer(ctx.body, ctx.user));
GET('/api/customers/:id', { perm: 'customers:read' }, (ctx) => profile(Number(ctx.params.id)));
PUT('/api/customers/:id', { perm: 'customers:write' }, (ctx) => {
  const id = Number(ctx.params.id); const cur = get('SELECT * FROM customers WHERE id=?', id); if (!cur) throw notFound('Customer');
  const v = parseCustomer(ctx.body, cur);
  const dup = findDuplicate([v.phone, v.phone2, v.whatsapp], id);
  if (dup) throw conflict(`This phone number already belongs to ${dup.name} (${dup.code})`, { duplicate: dup });
  tx(() => {
    run(`UPDATE customers SET name=?,phone=?,phone2=?,whatsapp=?,address=?,location=?,category=?,notes=?,status=?,updated_at=? WHERE id=?`,
      v.name, v.phone, v.phone2, v.whatsapp, v.address, v.location, v.category, v.notes, v.status, nowIso(), id);
    setTags(id, ctx.body.tags);
    audit(ctx.user, 'update', 'customer', id, cur, v);
  });
  return getCustomer(id);
});
DELETE('/api/customers/:id', { perm: 'customers:write' }, (ctx) => {
  const id = Number(ctx.params.id); const cur = get('SELECT * FROM customers WHERE id=?', id); if (!cur) throw notFound('Customer');
  const used = get('SELECT (SELECT COUNT(*) FROM orders WHERE customer_id=?) + (SELECT COUNT(*) FROM payments WHERE customer_id=?) AS n', id, id).n;
  if (used) {
    run("UPDATE customers SET status='Archived', updated_at=? WHERE id=?", nowIso(), id);
    audit(ctx.user, 'archive', 'customer', id, cur, { status: 'Archived' });
    return { archived: true, message: 'Customer has orders or payments, so they were archived instead of deleted.' };
  }
  tx(() => { run('DELETE FROM customers WHERE id=?', id); audit(ctx.user, 'delete', 'customer', id, cur, null); });
  return { deleted: true };
});
POST('/api/customers/:id/consent', { perm: 'marketing:write' }, (ctx) => {
  const status = oneOf(ctx.body.status, 'Status', ['opted_in', 'opted_out']);
  recordConsent(Number(ctx.params.id), status, str(ctx.body.source, 'Source', { required: true, max: 200 }), str(ctx.body.evidence, 'Evidence', { max: 300 }), ctx.user);
  return getCustomer(Number(ctx.params.id));
});
