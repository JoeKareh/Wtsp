import { GET, POST, PUT, DELETE } from '../http.js';
import { all, get, run, tx, audit, allSettings, nextCounter, fxRate } from '../db.js';
import { bad, notFound, str, int, num, money, oneOf, nowIso, pad, escLike, todayStr, addDays, convert, conflict } from '../util.js';
import { checkStock } from './notifications.js';

const PRODUCT_STATUSES = ['Active', 'Inactive', 'Discontinued'];

/** Low-level stock movement. All stock changes in the system go through here. */
export function applyMovement({ productId, type, qtyChange, unitCost = null, refType = null, refId = null, note = '', user = null, allowNegative = false }) {
  const p = get('SELECT * FROM products WHERE id=?', productId); if (!p) throw notFound('Product');
  const after = Math.round((p.quantity + qtyChange) * 1000) / 1000;
  if (after < 0 && !allowNegative) throw bad(`Not enough stock of "${p.name}" (have ${p.quantity}, need ${-qtyChange})`);
  run('UPDATE products SET quantity=?, updated_at=? WHERE id=?', after, nowIso(), productId);
  run('INSERT INTO inventory_movements(product_id,type,qty_change,qty_after,unit_cost,reference_type,reference_id,note,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    productId, type, qtyChange, after, unitCost, refType, refId, note || null, user?.id ?? null, nowIso());
  return after;
}

function parseProduct(b, cur) {
  const st = allSettings();
  const v = {
    name: str(b.name ?? cur?.name, 'Name', { required: true, max: 160 }),
    sku: str(b.sku ?? cur?.sku ?? '', 'SKU', { max: 60 }) || null,
    barcode: str(b.barcode ?? cur?.barcode ?? '', 'Barcode', { max: 60 }) || null,
    category_id: b.category_id === '' || b.category_id === null ? null : (b.category_id ?? cur?.category_id ?? null),
    description: str(b.description ?? cur?.description ?? '', 'Description', { max: 1000 }),
    cost: money(b.cost ?? cur?.cost ?? 0, 'Purchase cost'),
    price: money(b.price ?? cur?.price ?? 0, 'Selling price'),
    currency: oneOf(b.currency ?? cur?.currency ?? st.base_currency, 'Currency', st.currencies),
    min_stock: num(b.min_stock ?? cur?.min_stock ?? 0, 'Minimum stock', { min: 0 }),
    max_stock: (b.max_stock === '' || b.max_stock === null) ? null : (b.max_stock !== undefined ? num(b.max_stock, 'Maximum stock', { min: 0 }) : (cur?.max_stock ?? null)),
    supplier_id: b.supplier_id === '' || b.supplier_id === null ? null : (b.supplier_id ?? cur?.supplier_id ?? null),
    status: oneOf(b.status ?? cur?.status, 'Status', PRODUCT_STATUSES, { def: 'Active' }),
  };
  if (v.max_stock != null && v.max_stock < v.min_stock) throw bad('Maximum stock must be at least the minimum stock');
  return v;
}

const productSelect = `SELECT p.*, pc.name AS category, s.name AS supplier,
  CAST(p.quantity * p.cost AS INTEGER) AS stock_cost_value,
  CASE WHEN p.quantity <= 0 THEN 'out' WHEN p.min_stock > 0 AND p.quantity <= p.min_stock THEN 'low'
       WHEN p.max_stock IS NOT NULL AND p.quantity > p.max_stock THEN 'high' ELSE 'ok' END AS stock_state,
  CASE WHEN p.price > 0 THEN ROUND((p.price - p.cost) * 100.0 / p.price, 1) END AS margin_pct
  FROM products p LEFT JOIN product_categories pc ON pc.id=p.category_id LEFT JOIN suppliers s ON s.id=p.supplier_id`;

export const getProduct = (id) => get(`${productSelect} WHERE p.id=?`, id);

export function listProducts(q) {
  const w = []; const p = [];
  if (q.q) { w.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\')"); const l = `%${escLike(q.q)}%`; p.push(l, l, l, l); }
  if (q.category_id) { w.push('p.category_id=?'); p.push(q.category_id); }
  if (q.status) { w.push('p.status=?'); p.push(q.status); }
  if (q.active === '1') w.push("p.status='Active'");
  if (q.stock) { w.push('stock_state=?'); p.push(q.stock); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Number(q.limit) || 200, 1000); const offset = Number(q.offset) || 0;
  const base = `(${productSelect}) p`;
  const w2 = where.replaceAll('p.', 'p.');
  return {
    total: get(`SELECT COUNT(*) c FROM (SELECT * FROM (${productSelect}) p ${where.replace(/stock_state/g, 'p.stock_state')})`, ...p).c,
    rows: all(`SELECT * FROM (${productSelect}) p ${where.replace(/stock_state/g, 'p.stock_state')} ORDER BY p.name COLLATE NOCASE LIMIT ? OFFSET ?`, ...p, limit, offset),
  };
}

/** Units sold per product over a window (valid orders only). */
export function salesByProduct(fromDate, toDate) {
  return all(`SELECT i.product_id, SUM(i.qty) units, SUM(i.line_total) revenue FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.status NOT IN ('Draft','Cancelled','Returned') AND i.product_id IS NOT NULL AND o.order_date BETWEEN ? AND ? GROUP BY i.product_id`, fromDate, toDate);
}

GET('/api/products', { perm: 'products:read' }, (ctx) => listProducts(ctx.query));
GET('/api/products/meta', { perm: ['products:read', 'orders:write'] }, () => ({
  categories: all('SELECT * FROM product_categories ORDER BY name'), suppliers: all('SELECT * FROM suppliers ORDER BY name'),
}));
GET('/api/products/:id', { perm: 'products:read' }, (ctx) => {
  const p = getProduct(ctx.params.id); if (!p) throw notFound('Product');
  return { product: p, movements: all('SELECT m.*, u.name AS user_name FROM inventory_movements m LEFT JOIN users u ON u.id=m.user_id WHERE product_id=? ORDER BY m.id DESC LIMIT 200', p.id) };
});
POST('/api/products', { perm: 'products:write', idem: true }, (ctx) => {
  const v = parseProduct(ctx.body);
  const qty = num(ctx.body.quantity, 'Opening quantity', { min: 0 });
  if (v.sku && get('SELECT id FROM products WHERE sku=?', v.sku)) throw conflict('A product with this SKU already exists');
  return tx(() => {
    const code = 'P-' + pad(nextCounter('product'), 4);
    const id = run(`INSERT INTO products(code,name,sku,barcode,category_id,description,cost,price,currency,quantity,min_stock,max_stock,supplier_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`, code, v.name, v.sku, v.barcode, v.category_id, v.description, v.cost, v.price, v.currency, v.min_stock, v.max_stock, v.supplier_id, v.status, nowIso(), nowIso()).lastInsertRowid;
    if (qty > 0) applyMovement({ productId: id, type: 'initial', qtyChange: qty, unitCost: v.cost, note: 'Opening stock', user: ctx.user });
    audit(ctx.user, 'create', 'product', id, null, { code, ...v, quantity: qty });
    checkStock(id);
    return getProduct(id);
  });
});
PUT('/api/products/:id', { perm: 'products:write' }, (ctx) => {
  const cur = get('SELECT * FROM products WHERE id=?', ctx.params.id); if (!cur) throw notFound('Product');
  const v = parseProduct(ctx.body, cur);
  if (v.sku && get('SELECT id FROM products WHERE sku=? AND id<>?', v.sku, cur.id)) throw conflict('A product with this SKU already exists');
  tx(() => {
    run(`UPDATE products SET name=?,sku=?,barcode=?,category_id=?,description=?,cost=?,price=?,currency=?,min_stock=?,max_stock=?,supplier_id=?,status=?,updated_at=? WHERE id=?`,
      v.name, v.sku, v.barcode, v.category_id, v.description, v.cost, v.price, v.currency, v.min_stock, v.max_stock, v.supplier_id, v.status, nowIso(), cur.id);
    audit(ctx.user, 'update', 'product', cur.id, cur, v);
    checkStock(cur.id);
  });
  return getProduct(cur.id);
});
DELETE('/api/products/:id', { perm: 'products:write' }, (ctx) => {
  const cur = get('SELECT * FROM products WHERE id=?', ctx.params.id); if (!cur) throw notFound('Product');
  if (get('SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1', cur.id)) {
    run("UPDATE products SET status='Discontinued', updated_at=? WHERE id=?", nowIso(), cur.id);
    audit(ctx.user, 'discontinue', 'product', cur.id, cur, { status: 'Discontinued' });
    return { archived: true, message: 'Product is used by orders, so it was marked Discontinued instead of deleted.' };
  }
  tx(() => { run('DELETE FROM products WHERE id=?', cur.id); audit(ctx.user, 'delete', 'product', cur.id, cur, null); });
  return { deleted: true };
});

/** Manual stock actions: purchase (add), return (customer return to stock), damage (write-off), adjustment (set count). */
POST('/api/products/:id/stock', { perm: 'products:write', idem: true }, (ctx) => {
  const cur = get('SELECT * FROM products WHERE id=?', ctx.params.id); if (!cur) throw notFound('Product');
  const type = oneOf(ctx.body.type, 'Type', ['purchase', 'return', 'damage', 'adjustment']);
  const note = str(ctx.body.note, 'Note', { max: 300, required: type === 'adjustment' || type === 'damage' });
  return tx(() => {
    let change;
    if (type === 'adjustment') { const target = num(ctx.body.new_quantity, 'Counted quantity', { required: true, min: 0 }); change = target - cur.quantity; if (change === 0) throw bad('Counted quantity equals current quantity'); }
    else { const q = num(ctx.body.qty, 'Quantity', { required: true, min: 0.001 }); change = type === 'damage' ? -q : q; }
    const unitCost = type === 'purchase' && ctx.body.unit_cost !== undefined && ctx.body.unit_cost !== '' ? money(ctx.body.unit_cost, 'Unit cost') : null;
    applyMovement({ productId: cur.id, type, qtyChange: change, unitCost, note, user: ctx.user });
    if (type === 'purchase' && unitCost != null && ctx.body.update_cost) {
      const newCost = cur.quantity > 0 ? Math.round((cur.quantity * cur.cost + change * unitCost) / (cur.quantity + change)) : unitCost; // weighted average
      run('UPDATE products SET cost=? WHERE id=?', newCost, cur.id);
    }
    audit(ctx.user, type, 'product_stock', cur.id, { quantity: cur.quantity }, { change, note });
    checkStock(cur.id);
    return getProduct(cur.id);
  });
});

GET('/api/inventory/movements', { perm: 'products:read' }, (ctx) => {
  const w = []; const p = [];
  if (ctx.query.product_id) { w.push('m.product_id=?'); p.push(ctx.query.product_id); }
  if (ctx.query.type) { w.push('m.type=?'); p.push(ctx.query.type); }
  if (ctx.query.from) { w.push('substr(m.created_at,1,10)>=?'); p.push(ctx.query.from); }
  if (ctx.query.to) { w.push('substr(m.created_at,1,10)<=?'); p.push(ctx.query.to); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Number(ctx.query.limit) || 100, 500); const offset = Number(ctx.query.offset) || 0;
  return {
    total: get(`SELECT COUNT(*) c FROM inventory_movements m ${where}`, ...p).c,
    rows: all(`SELECT m.*, p.name AS product, p.code, u.name AS user_name FROM inventory_movements m JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset),
  };
});

/** Inventory intelligence: state, demand rate, cover, fast/slow flags. */
export function inventoryInsights() {
  const st = allSettings(); const today = todayStr(st.timezone);
  const s30 = new Map(salesByProduct(addDays(today, -29), today).map((r) => [r.product_id, r.units]));
  const sPrev = new Map(salesByProduct(addDays(today, -59), addDays(today, -30)).map((r) => [r.product_id, r.units]));
  const last = new Map(all(`SELECT i.product_id id, MAX(o.order_date) d FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status NOT IN ('Draft','Cancelled','Returned') GROUP BY i.product_id`).map((r) => [r.id, r.d]));
  const slowSince = addDays(today, -Number(st.slow_moving_days));
  return all(`${productSelect} WHERE p.status='Active'`).map((p) => {
    const u30 = s30.get(p.id) || 0; const daily = u30 / 30; const ls = last.get(p.id) || null;
    return {
      ...p, sold_30d: u30, sold_prev_30d: sPrev.get(p.id) || 0, daily_demand: daily, last_sale: ls,
      days_cover: daily > 0 ? Math.max(0, Math.round(p.quantity / daily)) : null,   // never negative: oversold stock has 0 days of cover
      fast_moving: u30 >= Number(st.fast_moving_units_30d),
      slow_moving: p.quantity > 0 && (ls ? ls < slowSince : p.created_at.slice(0, 10) < slowSince),
      shortage_risk: daily > 0 && p.quantity / daily < Number(st.lead_time_days),
    };
  });
}
GET('/api/inventory/summary', { perm: 'products:read' }, () => {
  const rows = inventoryInsights();
  return {
    totals: {
      products: rows.length, out: rows.filter((r) => r.stock_state === 'out').length, low: rows.filter((r) => r.stock_state === 'low').length,
      high: rows.filter((r) => r.stock_state === 'high').length, fast: rows.filter((r) => r.fast_moving).length, slow: rows.filter((r) => r.slow_moving).length,
      shortage_risk: rows.filter((r) => r.shortage_risk).length, stock_cost_value: rows.reduce((a, r) => a + convert(r.stock_cost_value, fxRate(r.currency, todayStr(allSettings().timezone)), 1), 0),
    },
    rows,
  };
});

// ----- categories & suppliers -----
POST('/api/product-categories', { perm: 'products:write' }, (ctx) => {
  const name = str(ctx.body.name, 'Name', { required: true, max: 80 });
  if (get('SELECT id FROM product_categories WHERE name=?', name)) throw conflict('Category already exists');
  const id = run('INSERT INTO product_categories(name) VALUES (?)', name).lastInsertRowid; audit(ctx.user, 'create', 'product_category', id, null, { name });
  return get('SELECT * FROM product_categories WHERE id=?', id);
});
PUT('/api/product-categories/:id', { perm: 'products:write' }, (ctx) => {
  const name = str(ctx.body.name, 'Name', { required: true, max: 80 });
  run('UPDATE product_categories SET name=? WHERE id=?', name, ctx.params.id); audit(ctx.user, 'update', 'product_category', ctx.params.id, null, { name }); return { ok: true };
});
DELETE('/api/product-categories/:id', { perm: 'products:write' }, (ctx) => { run('DELETE FROM product_categories WHERE id=?', ctx.params.id); audit(ctx.user, 'delete', 'product_category', ctx.params.id); return { ok: true }; });
const supplierBody = (b) => ({ name: str(b.name, 'Name', { required: true, max: 120 }), phone: str(b.phone, 'Phone', { max: 40 }), email: str(b.email, 'Email', { max: 120 }), notes: str(b.notes, 'Notes', { max: 500 }) });
POST('/api/suppliers', { perm: 'products:write' }, (ctx) => {
  const v = supplierBody(ctx.body); if (get('SELECT id FROM suppliers WHERE name=?', v.name)) throw conflict('Supplier already exists');
  const id = run('INSERT INTO suppliers(name,phone,email,notes) VALUES (?,?,?,?)', v.name, v.phone, v.email, v.notes).lastInsertRowid; audit(ctx.user, 'create', 'supplier', id, null, v);
  return get('SELECT * FROM suppliers WHERE id=?', id);
});
PUT('/api/suppliers/:id', { perm: 'products:write' }, (ctx) => {
  const v = supplierBody(ctx.body); run('UPDATE suppliers SET name=?,phone=?,email=?,notes=? WHERE id=?', v.name, v.phone, v.email, v.notes, ctx.params.id); audit(ctx.user, 'update', 'supplier', ctx.params.id, null, v); return { ok: true };
});
DELETE('/api/suppliers/:id', { perm: 'products:write' }, (ctx) => { run('DELETE FROM suppliers WHERE id=?', ctx.params.id); audit(ctx.user, 'delete', 'supplier', ctx.params.id); return { ok: true }; });
