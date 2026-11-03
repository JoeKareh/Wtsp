// Workspace-level account features: language, CSV import, data export, onboarding, support.
import { GET, POST, PUT, raw } from '../http.js';
import { all, get, run, audit, allSettings, setSettings, currentTenantContext, tenantKey } from '../db.js';
import { parseCsv, mapRows, parseNumber, toCsvText } from '../csv.js';
import { zip } from '../export.js';
import { createCustomer } from './customers.js';
import { createProduct } from './inventory.js';
import { sanitizedDbCopy } from './settings.js';
import { hasPerm } from '../perms.js';
import { getSecrets } from '../secrets.js';
import { sendPlatformEmail } from '../platformmail.js';
import { cGet, paudit, planById } from '../control.js';
import { recentErrors } from '../http.js';
import { allow } from '../ratelimit.js';
import { HttpError, bad, oneOf, str, nowIso, safeJson, normPhone } from '../util.js';
import { LANGUAGES } from '../countries.js';
import { config } from '../config.js';

const ALWAYS = { lifecycle: 'always' };

PUT('/api/auth/language', { ...ALWAYS }, (ctx) => { const l = oneOf(ctx.body.language, 'Language', LANGUAGES); run('UPDATE users SET language=? WHERE id=?', l, ctx.user.id); return { language: l }; });

// ---------------- CSV import ----------------
const CUSTOMER_ALIASES = { name: ['name', 'full name', 'customer', 'customer name', 'الاسم', 'اسم العميل'], phone: ['phone', 'mobile', 'tel', 'telephone', 'phone number', 'primary phone', 'الهاتف', 'رقم الهاتف', 'الجوال', 'الموبايل'], phone2: ['phone2', 'secondary phone', 'phone 2', 'هاتف آخر', 'هاتف ثان'], whatsapp: ['whatsapp', 'whatsapp number', 'واتساب', 'رقم الواتساب'], address: ['address', 'العنوان'], location: ['city', 'location', 'area', 'المدينة', 'الموقع', 'المنطقة'], category: ['category', 'type', 'الفئة', 'التصنيف'], notes: ['notes', 'note', 'ملاحظات'], tags: ['tags', 'الوسوم'] };
const PRODUCT_ALIASES = { name: ['name', 'product', 'product name', 'item', 'الاسم', 'المنتج', 'اسم المنتج'], sku: ['sku', 'code', 'barcode', 'الرمز', 'الباركود'], category: ['category', 'الفئة', 'التصنيف'], cost: ['cost', 'purchase cost', 'cost price', 'التكلفة', 'سعر الشراء'], price: ['price', 'selling price', 'sale price', 'السعر', 'سعر البيع'], quantity: ['quantity', 'qty', 'stock', 'in stock', 'الكمية', 'المخزون'], min_stock: ['min stock', 'minimum stock', 'min', 'الحد الأدنى'], max_stock: ['max stock', 'maximum stock', 'max', 'الحد الأعلى'], supplier: ['supplier', 'vendor', 'المورد'], description: ['description', 'الوصف'], currency: ['currency', 'العملة'] };
const TEMPLATES = {
  customers: { headers: ['name', 'phone', 'phone2', 'whatsapp', 'address', 'location', 'category', 'notes', 'tags'], sample: [{ name: 'Sara Haddad', phone: '71 123 456', location: 'Beirut', category: 'Retail', tags: 'vip;friend' }, { name: 'Karim Nasr', phone: '03 555 666', whatsapp: '03 555 666', location: 'Saida' }] },
  products: { headers: ['name', 'sku', 'category', 'cost', 'price', 'quantity', 'min_stock', 'max_stock', 'supplier', 'description'], sample: [{ name: 'Olive oil 1L', sku: 'OIL-1L', category: 'Food', cost: '9.00', price: '15.00', quantity: 40, min_stock: 10, max_stock: 120, supplier: 'Mountain Farms' }, { name: 'Laurel soap', sku: 'SOAP-LAU', category: 'Soap', cost: '1.20', price: '3.00', quantity: 200, min_stock: 40 }] },
};
GET('/api/import/template', { perm: ['customers:write', 'products:write'] }, (ctx) => { const t = TEMPLATES[oneOf(ctx.query.type, 'Type', ['customers', 'products'])]; return raw(toCsvText(t.sample, t.headers), 'text/csv; charset=utf-8', `${ctx.query.type}-template.csv`); });
POST('/api/import', { perm: ['customers:write', 'products:write'], idem: true }, (ctx) => {
  const type = oneOf(ctx.body.type, 'Type', ['customers', 'products']); const dry = ctx.body.dry_run === true;
  if (type === 'customers' && !hasPerm(ctx.user, 'customers:write')) throw new HttpError(403, 'You cannot import customers'); if (type === 'products' && !hasPerm(ctx.user, 'products:write')) throw new HttpError(403, 'You cannot import products');
  const text = String(ctx.body.csv || ''); if (text.length > 2_000_000) throw bad('The file is too large (max about 2 MB). Split it into parts.');
  const rows = parseCsv(text); if (rows.length < 2) throw bad('The file has no data rows. Download the template to see the expected format.');
  const { records, unknown, missing } = mapRows(rows, type === 'customers' ? CUSTOMER_ALIASES : PRODUCT_ALIASES);
  if (records.length > 5000) throw bad('Too many rows (max 5,000 per import).');
  const required = type === 'customers' ? ['name', 'phone'] : ['name']; const lacking = required.filter((f) => missing.includes(f)); if (lacking.length) throw bad(`The file needs a "${lacking.join('" and "')}" column. Download the template to see the expected headers.`);
  const errors = []; let created = 0; const finance = hasPerm(ctx.user, 'finance:read'); const seenPhones = new Set();
  const money = (v, name) => { if (v === undefined || v === '') return 0; const n = parseNumber(v); if (n === null || n < 0) throw bad(`${name} "${v}" is not a valid amount`); return Math.round(n * 100); };
  const catId = (n) => { if (!n) return null; const ex = get('SELECT id FROM product_categories WHERE name=?', n); return ex ? ex.id : run('INSERT INTO product_categories(name) VALUES (?)', n).lastInsertRowid; };
  const supId = (n) => { if (!n) return null; const ex = get('SELECT id FROM suppliers WHERE name=?', n); return ex ? ex.id : run('INSERT INTO suppliers(name) VALUES (?)', n).lastInsertRowid; };
  for (const r of records) {
    try {
      if (!r.name) throw bad('Name is empty');
      if (type === 'customers') {
        if (!r.phone) throw bad('Phone is empty');
        const b = { name: r.name, phone: r.phone, phone2: r.phone2 || undefined, whatsapp: r.whatsapp || undefined, address: r.address, location: r.location, category: r.category, notes: r.notes, status: 'Potential', tags: r.tags ? r.tags.split(/[;,|]/).map((x) => x.trim()).filter(Boolean) : [] };
        validateCustomerDry(b); const k = normPhone(b.phone, allSettings().default_country_code); if (seenPhones.has(k)) throw bad('This phone number appears twice in the file'); if (!dry) createCustomer(b, ctx.user); seenPhones.add(k);
      } else {
        const qty = r.quantity === undefined || r.quantity === '' ? 0 : parseNumber(r.quantity); if (qty === null || qty < 0) throw bad(`Quantity "${r.quantity}" is not valid`);
        const b = { name: r.name, sku: r.sku || undefined, description: r.description || '', cost: finance ? money(r.cost, 'Cost') : 0, price: money(r.price, 'Price'), quantity: qty, min_stock: parseNumber(r.min_stock) ?? 0, max_stock: r.max_stock ? parseNumber(r.max_stock) : null, currency: (r.currency || allSettings().base_currency).toUpperCase() };
        if (r.sku && get('SELECT 1 x FROM products WHERE sku=?', r.sku)) throw bad(`SKU "${r.sku}" already exists`);
        if (!dry) { b.category_id = catId(r.category); b.supplier_id = supId(r.supplier); createProduct(b, ctx.user); }
      }
      created++;
    } catch (e) { errors.push({ row: r.rowNumber, name: r.name || '', error: e.message, ...(e.details?.duplicate ? { duplicate_of: e.details.duplicate.code } : {}) }); }
  }
  if (!dry) audit(ctx.user, 'import', type, null, null, { created, errors: errors.length });
  return { type, dry_run: dry, total: records.length, ok: created, failed: errors.length, errors: errors.slice(0, 500), ignored_columns: unknown, error_report_csv: errors.length ? toCsvText(errors, ['row', 'name', 'error']) : null };
});
function validateCustomerDry(b) {   // same validation as creation, without writing
  const cc = allSettings().default_country_code; normPhone(b.phone, cc); if (b.phone2) normPhone(b.phone2, cc); if (b.whatsapp) normPhone(b.whatsapp, cc);
  const n = normPhone(b.phone, cc); const d = get('SELECT code, name FROM customers WHERE phone=? OR phone2=? OR whatsapp=?', n, n, n); if (d) throw Object.assign(bad(`Already exists as ${d.name} (${d.code})`), { details: { duplicate: d } });
}

// ---------------- data export (owners can always export, whatever the workspace state) ----------------
const EXPORT_TABLES = ['customers', 'customer_tags', 'customer_consent', 'suppression_list', 'suppliers', 'product_categories', 'products', 'inventory_movements', 'orders', 'order_items', 'order_history', 'payments', 'payment_allocations', 'expenses', 'whatsapp_templates', 'whatsapp_messages', 'notifications', 'exchange_rates', 'customer_events', 'audit_logs'];
GET('/api/export/all', { perm: 'users:manage', ...ALWAYS }, (ctx) => {
  if (!allow('export:' + tenantKey(), 10, 3600e3)) throw new HttpError(429, 'Please wait before exporting again.');
  const files = [];
  for (const t of EXPORT_TABLES) { const rows = all(`SELECT * FROM ${t}${t === 'audit_logs' ? ' ORDER BY id DESC LIMIT 50000' : ''}`); const headers = rows.length ? Object.keys(rows[0]) : (all(`PRAGMA table_info(${t})`).map((c) => c.name)); files.push([`${t}.csv`, toCsvText(rows.map((r) => (t === 'expenses' ? { ...r, attachment_path: r.attachment_path ? '(attached file)' : '' } : r)), headers.filter((h) => !(t === 'expenses' && h === 'attachment_path') || true))]); }
  files.push(['users.csv', toCsvText(all('SELECT u.id,u.email,u.name,r.name AS role,u.active,u.created_at,u.last_login_at FROM users u JOIN roles r ON r.id=u.role_id'), ['id', 'email', 'name', 'role', 'active', 'created_at', 'last_login_at'])]);
  files.push(['README.txt', `Data export of "${allSettings().business_name}" generated ${nowIso()}.\nAmounts are integers in 1/100 of the currency unit (e.g. 1250 = 12.50). Dates are YYYY-MM-DD, timestamps are UTC.\nOne CSV per table. Passwords, sessions and integration credentials are never included.\nTo import customers/products into a new system, start from customers.csv and products.csv.\n`]);
  audit(ctx.user, 'export', 'data', null, null, { format: 'zip' }); if (config.saas) paudit('tenant:' + currentTenantContext().tenant.subdomain, 'data_export', currentTenantContext().tenantId);
  return raw(zip(files.map(([n, d]) => [n, Buffer.from(d, 'utf8')])), 'application/zip', `workspace-export-${nowIso().slice(0, 10)}.zip`);
});
GET('/api/export/sqlite', { perm: 'users:manage', ...ALWAYS }, async (ctx) => {
  if (!allow('exportdb:' + tenantKey(), 3, 3600e3)) throw new HttpError(429, 'Please wait before exporting again.');
  audit(ctx.user, 'export', 'data', null, null, { format: 'sqlite' }); return raw(await sanitizedDbCopy(), 'application/octet-stream', `workspace-${nowIso().slice(0, 10)}.sqlite`);
});

// ---------------- onboarding ----------------
const PRESETS = {
  retail: { customer_categories: ['Retail', 'Wholesale', 'VIP'], expense_categories: ['Rent', 'Salaries', 'Utilities', 'Marketing', 'Transport', 'Supplies', 'Other'] },
  food: { customer_categories: ['Dine-in', 'Takeaway', 'Catering'], expense_categories: ['Rent', 'Salaries', 'Ingredients', 'Utilities', 'Marketing', 'Equipment', 'Other'] },
  services: { customer_categories: ['Individual', 'Business', 'VIP'], expense_categories: ['Rent', 'Salaries', 'Software', 'Marketing', 'Travel', 'Equipment', 'Other'] },
  wholesale: { customer_categories: ['Retailer', 'Distributor', 'VIP'], expense_categories: ['Rent', 'Salaries', 'Utilities', 'Transport', 'Warehouse', 'Marketing', 'Other'] },
  other: { customer_categories: ['Regular', 'VIP'], expense_categories: ['Rent', 'Salaries', 'Utilities', 'Marketing', 'Other'] },
};
function onboardingState() {
  const st = allSettings(); const ob = st.onboarding || {}; const wa = (() => { try { const s = getSecrets(); return Boolean(s.wa_token && s.wa_phone_number_id); } catch { return false; } })();
  const steps = [
    { key: 'business', done: Boolean(st.business_type) || !!ob.business },
    { key: 'currency', done: st.currencies.length > 1 || !!ob.currency },
    { key: 'import', done: get('SELECT (SELECT COUNT(*) FROM customers)+(SELECT COUNT(*) FROM products) n').n > 0 || !!ob.import },
    { key: 'first_order', done: get("SELECT COUNT(*) c FROM orders WHERE status<>'Draft'").c > 0 },
    { key: 'whatsapp', done: wa || !!ob.whatsapp },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length || !!ob.dismissed, dismissed: !!ob.dismissed, business_type: st.business_type, presets: Object.keys(PRESETS) };
}
GET('/api/onboarding', ALWAYS, () => onboardingState());
PUT('/api/onboarding', ALWAYS, (ctx) => { const ob = { ...(allSettings().onboarding || {}) }; if (ctx.body.dismissed !== undefined) ob.dismissed = !!ctx.body.dismissed; if (ctx.body.skip) ob[oneOf(ctx.body.skip, 'Step', ['business', 'currency', 'import', 'whatsapp'])] = true; setSettings({ onboarding: ob }); return onboardingState(); });
POST('/api/onboarding/business-type', { perm: 'settings:write' }, (ctx) => {
  const t = oneOf(ctx.body.type, 'Business type', Object.keys(PRESETS)); const p = PRESETS[t];
  setSettings({ business_type: t, customer_categories: p.customer_categories, expense_categories: p.expense_categories }); audit(ctx.user, 'update', 'onboarding', null, null, { business_type: t }); return onboardingState();
});

// ---------------- support ----------------
POST('/api/support', ALWAYS, (ctx) => {
  const t = currentTenantContext()?.tenant; if (!allow('support:' + tenantKey(), 5, 3600e3)) throw new HttpError(429, 'You already sent several messages. We will reply soon.');
  const subject = str(ctx.body.subject, 'Subject', { required: true, max: 120 }); const message = str(ctx.body.message, 'Message', { required: true, max: 4000 });
  const info = t ? { tenant: t.id, plan: planById(t.plan_id)?.code, state: t.status } : { tenant: 'single-business' };
  const errors = recentErrors(t?.id || 'default').map((e) => `${e.at} ${e.msg}`);
  const to = process.env.SUPPORT_EMAIL || process.env.ALERT_EMAIL;
  if (to) sendPlatformEmail('support', to, { subject, email: ctx.user.email, tenant: `${info.tenant} (${info.plan || '-'}, ${info.state || '-'}) ${t?.subdomain || ''}`, message, errors }, 'en');
  if (t) paudit('tenant:' + t.subdomain, 'support_ticket', t.id, { subject, from: ctx.user.email, errors: errors.length });
  audit(ctx.user, 'create', 'support_ticket', null, null, { subject });
  return { ok: true, delivered: Boolean(to), message: to ? 'Thanks! We received your message and will reply by email.' : 'Your message was saved. (Support email is not configured on this server yet.)' };
});

// ---------------- installable app (PWA / Android wrapper) ----------------
GET('/api/manifest', { perm: 'public', lifecycle: 'always' }, () => {
  const st = allSettings(); const name = String(st.business_name || 'BizControl').slice(0, 45);
  return raw(JSON.stringify({ name, short_name: name.slice(0, 12), start_url: '/', scope: '/', display: 'standalone', background_color: '#f4f5f7', theme_color: '#2a78d6', lang: st.language || 'en', dir: st.language === 'ar' ? 'rtl' : 'ltr',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] }), 'application/manifest+json');
});
