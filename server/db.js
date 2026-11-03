import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { nowIso, safeJson } from './util.js';

/**
 * Tenant-aware database access.
 *  - In SaaS mode (APP_DOMAIN set) every call resolves the current tenant from AsyncLocalStorage and FAILS CLOSED when
 *    there is none, so code running outside a tenant context can never touch a tenant file by accident.
 *  - Without APP_DOMAIN (single-business mode) everything uses DB_PATH, exactly like before.
 * Services keep importing all/get/run/tx/... unchanged.
 */
export const als = new AsyncLocalStorage();
export class TenantUnavailable extends Error { constructor(msg, status = 503) { super(msg); this.status = status; this.tenantUnavailable = true; } }

const DEFAULT_KEY = 'default';
const pool = new Map();            // key -> connection record; Map order doubles as LRU order
const openHooks = [];              // run (inside the tenant context) every time a tenant database is opened
const failureHooks = [];
export const onTenantOpen = (fn) => openHooks.push(fn);
export const onMigrationFailure = (fn) => failureHooks.push(fn);
const failed = new Map();          // key -> error message; a tenant whose migration failed stays disabled until fixed

export const tenantKey = () => {
  const st = als.getStore();
  if (st?.tenantId) return st.tenantId;
  if (config.saas) throw new TenantUnavailable('No tenant context', 500);
  return DEFAULT_KEY;
};
export const currentTenantContext = () => als.getStore() || null;
export const withTenant = (tenantId, fn, tenant) => als.run({ ...(als.getStore() || {}), tenantId, ...(tenant ? { tenant } : {}) }, fn);
export function tenantFile(id) {
  if (id === DEFAULT_KEY && !config.saas) return config.dbPath;
  if (!/^t_[a-f0-9]{16}$/.test(id)) throw new Error('Invalid tenant id');   // ids are generated, never user-supplied: no path tricks
  return path.join(config.tenantsDir, id + '.sqlite');
}

function openConn(key) {
  if (failed.has(key)) throw new TenantUnavailable('This workspace is temporarily unavailable (maintenance).');
  const file = tenantFile(key); fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const c = { key, db: raw, depth: 0, cache: null, lastUsed: Date.now(), closed: false };
  pool.set(key, c);
  try {
    als.run({ tenantId: key, opening: true }, () => { migrate(c); for (const h of openHooks) h(key); });
  } catch (e) {
    pool.delete(key); try { raw.close(); } catch { /* ignore */ }
    if (config.saas) { failed.set(key, e.message); for (const h of failureHooks) { try { h(key, e); } catch { /* ignore */ } } throw new TenantUnavailable('This workspace is temporarily unavailable (maintenance).'); }
    throw e;
  }
  return c;
}
function evict() {
  const max = config.poolMax;
  for (const [k, c] of pool) { if (pool.size <= max) break; if (c.depth === 0) { pool.delete(k); c.closed = true; try { c.db.close(); } catch { /* ignore */ } } }
}
export function conn() {
  const key = tenantKey(); let c = pool.get(key);
  if (c && !c.closed) { pool.delete(key); pool.set(key, c); c.lastUsed = Date.now(); return c; }   // refresh LRU position
  c = openConn(key); evict(); return c;
}
export function closeTenant(key) { const c = pool.get(key); if (c) { pool.delete(key); c.closed = true; try { c.db.close(); } catch { /* ignore */ } } }
export function closeAllTenants() { for (const k of [...pool.keys()]) closeTenant(k); }
export const poolStats = () => ({ open: pool.size, max: config.poolMax, failed: [...failed.keys()] });
export const clearTenantFailure = (key) => failed.delete(key);
/** Close idle connections (not used for idleMs). */
export function closeIdle(idleMs = 5 * 60_000) { const now = Date.now(); for (const [k, c] of pool) if (c.depth === 0 && now - c.lastUsed > idleMs) closeTenant(k); }

/** `db` behaves like the current tenant's DatabaseSync (used by backup code and tests). */
export const db = new Proxy({}, { get: (_, k) => { const d = conn().db; const v = d[k]; return typeof v === 'function' ? v.bind(d) : v; } });

// rows come back as null-prototype objects: fine for property access, JSON and spreading; copying 40k rows per query is not
export const all = (sql, ...p) => conn().db.prepare(sql).all(...p);
export const get = (sql, ...p) => { const r = conn().db.prepare(sql).get(...p); return r ? { ...r } : undefined; };
export const run = (sql, ...p) => conn().db.prepare(sql).run(...p);

/** Run fn atomically. Nested calls use savepoints. Synchronous by design: nothing can interleave inside a transaction. */
export function tx(fn) {
  const c = conn(); const d = c.db;
  if (c.depth > 0) {
    const sp = 'sp' + c.depth;
    d.exec(`SAVEPOINT ${sp}`); c.depth++;
    try { const r = fn(); d.exec(`RELEASE ${sp}`); return r; }
    catch (e) { d.exec(`ROLLBACK TO ${sp}`); d.exec(`RELEASE ${sp}`); throw e; }
    finally { c.depth--; }
  }
  d.exec('BEGIN IMMEDIATE'); c.depth++;
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  finally { c.depth--; }
}

const MIGRATIONS = [
`
CREATE TABLE roles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', permissions TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id), permissions TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT NOT NULL, ip TEXT, user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE business_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL, user_id INTEGER NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (key, user_id, route)
);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, user_name TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT, before TEXT, after TEXT, note TEXT, ip TEXT
);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_at ON audit_logs(at);

CREATE TABLE exchange_rates (
  id INTEGER PRIMARY KEY, currency TEXT NOT NULL, rate_per_base REAL NOT NULL CHECK (rate_per_base > 0),
  effective_date TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX idx_fx ON exchange_rates(currency, effective_date);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE, phone2 TEXT, whatsapp TEXT, address TEXT DEFAULT '', location TEXT DEFAULT '',
  category TEXT DEFAULT '', notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Potential' CHECK (status IN ('Active','Inactive','Potential','Archived')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, registered_on TEXT NOT NULL
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_whatsapp ON customers(whatsapp);
CREATE TABLE customer_tags (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (customer_id, tag)
);
CREATE TABLE customer_consent (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'whatsapp', type TEXT NOT NULL DEFAULT 'marketing',
  status TEXT NOT NULL CHECK (status IN ('opted_in','opted_out')),
  source TEXT NOT NULL, evidence TEXT, created_at TEXT NOT NULL, created_by INTEGER
);
CREATE INDEX idx_consent_customer ON customer_consent(customer_id, id);
CREATE TABLE suppression_list (
  id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  phone TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE product_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', email TEXT DEFAULT '', notes TEXT DEFAULT ''
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, sku TEXT UNIQUE, barcode TEXT,
  category_id INTEGER REFERENCES product_categories(id) ON DELETE SET NULL, description TEXT DEFAULT '',
  cost INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0), price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'USD', quantity REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0, max_stock REAL, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive','Discontinued')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_name ON products(name);
CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('initial','purchase','sale','return','damage','adjustment','order_cancel')),
  qty_change REAL NOT NULL, qty_after REAL NOT NULL, unit_cost INTEGER, reference_type TEXT, reference_id INTEGER,
  note TEXT, user_id INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX idx_movements_product ON inventory_movements(product_id, created_at);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id), customer_phone TEXT NOT NULL,
  order_date TEXT NOT NULL, expected_date TEXT, delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Draft','Pending','Confirmed','Processing','Ready','Out for delivery','Delivered','Completed','Cancelled','Returned')),
  currency TEXT NOT NULL, fx_rate REAL NOT NULL CHECK (fx_rate > 0),
  subtotal INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0, additional_charges INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0,
  net_revenue INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  extra_cost INTEGER NOT NULL DEFAULT 0, total_cost INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '', cancel_reason TEXT, stock_deducted INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(order_date);
CREATE INDEX idx_orders_status ON orders(status);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0), unit_price INTEGER NOT NULL CHECK (unit_price >= 0), unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  line_total INTEGER NOT NULL, line_cost INTEGER NOT NULL
);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE INDEX idx_items_product ON order_items(product_id);
CREATE TABLE order_history (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT, user_id INTEGER, user_name TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_ohist_order ON order_history(order_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL DEFAULT 'payment' CHECK (type IN ('payment','refund')),
  amount INTEGER NOT NULL CHECK (amount > 0), currency TEXT NOT NULL, fx_rate REAL NOT NULL CHECK (fx_rate > 0),
  method TEXT NOT NULL, paid_at TEXT NOT NULL, reference TEXT DEFAULT '', notes TEXT DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT, voided_at TEXT, voided_by INTEGER,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_date ON payments(paid_at);
CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount INTEGER NOT NULL CHECK (amount > 0),          -- in the payment's currency
  applied_amount INTEGER NOT NULL                      -- in the order's currency; negative for refunds
);
CREATE INDEX idx_alloc_order ON payment_allocations(order_id);
CREATE INDEX idx_alloc_payment ON payment_allocations(payment_id);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, category TEXT NOT NULL, description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), currency TEXT NOT NULL, fx_rate REAL NOT NULL CHECK (fx_rate > 0),
  paid_at TEXT NOT NULL, method TEXT NOT NULL, attachment_path TEXT, attachment_name TEXT,
  recurring TEXT CHECK (recurring IN ('weekly','monthly','yearly')), recurring_next TEXT, recurring_active INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_expenses_date ON expenses(paid_at);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical','success')),
  title TEXT NOT NULL, body TEXT DEFAULT '', link TEXT, entity_type TEXT, entity_id TEXT, dedupe_key TEXT,
  read_at TEXT, dismissed_at TEXT, resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_dedupe ON notifications(dedupe_key, resolved_at);
CREATE INDEX idx_notif_created ON notifications(created_at);
CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY, notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'immediate',
  status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);

CREATE TABLE whatsapp_templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, wa_name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'MARKETING' CHECK (category IN ('MARKETING','UTILITY')),
  purpose TEXT DEFAULT 'promotion', language TEXT NOT NULL DEFAULT 'en', body TEXT NOT NULL,
  meta_status TEXT NOT NULL DEFAULT 'LOCAL_DRAFT', meta_id TEXT, meta_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE saved_segments (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, rules TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE whatsapp_campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, segment TEXT NOT NULL, template_id INTEGER NOT NULL REFERENCES whatsapp_templates(id),
  params TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','completed','cancelled','failed')),
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, targeted INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0,
  excluded TEXT, error TEXT, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE whatsapp_messages (
  id INTEGER PRIMARY KEY, campaign_id INTEGER REFERENCES whatsapp_campaigns(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL, phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')), kind TEXT NOT NULL DEFAULT 'template',
  template_id INTEGER REFERENCES whatsapp_templates(id) ON DELETE SET NULL, body TEXT, wamid TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed','skipped','received')),
  error TEXT, reply_to_campaign_id INTEGER REFERENCES whatsapp_campaigns(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, sent_at TEXT, delivered_at TEXT, read_at TEXT
);
CREATE INDEX idx_wam_campaign ON whatsapp_messages(campaign_id);
CREATE INDEX idx_wam_customer ON whatsapp_messages(customer_id, created_at);
CREATE UNIQUE INDEX idx_wam_wamid ON whatsapp_messages(wamid) WHERE wamid IS NOT NULL;
CREATE TABLE campaign_attributions (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES whatsapp_campaigns(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE, customer_id INTEGER NOT NULL,
  message_id INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY, rkey TEXT NOT NULL UNIQUE, category TEXT NOT NULL, kind TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2,
  title TEXT NOT NULL, detected TEXT NOT NULL, data TEXT, why TEXT NOT NULL, action TEXT NOT NULL,
  benefit TEXT, benefit_basis TEXT, link TEXT, status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','completed','ignored','scheduled')),
  scheduled_for TEXT, source TEXT NOT NULL DEFAULT 'rules', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- ============ Financial views: single source of truth for order money ============
CREATE VIEW v_orders AS
SELECT o.*,
  CASE WHEN o.status IN ('Draft','Cancelled','Returned') THEN 0 ELSE o.total END AS amount_due,
  COALESCE(pa.paid, 0) AS paid,
  COALESCE(pa.refunded, 0) AS refunded
FROM orders o
LEFT JOIN (
  SELECT a.order_id, SUM(a.applied_amount) AS paid, SUM(CASE WHEN p.type = 'refund' THEN -a.applied_amount ELSE 0 END) AS refunded
  FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
  WHERE p.voided = 0 GROUP BY a.order_id
) pa ON pa.order_id = o.id;

CREATE VIEW v_orders_fin AS
SELECT v.*,
  v.amount_due - v.paid AS balance,
  CASE WHEN v.status = 'Draft' THEN 'Unpaid'
       WHEN v.refunded > 0 AND v.paid <= 0 THEN 'Refunded'
       WHEN v.paid <= 0 THEN 'Unpaid'
       WHEN v.paid < v.amount_due THEN 'Partially paid'
       ELSE 'Paid' END AS payment_status,
  CAST(ROUND(v.net_revenue * 1.0 / v.fx_rate) AS INTEGER) AS revenue_base,
  CAST(ROUND(v.total_cost * 1.0 / v.fx_rate) AS INTEGER) AS cost_base,
  CAST(ROUND(v.amount_due * 1.0 / v.fx_rate) AS INTEGER) AS due_base,
  CAST(ROUND((v.amount_due - v.paid) * 1.0 / v.fx_rate) AS INTEGER) AS balance_base
FROM v_orders v;
`,
// 2: same semantics, but paid/refunded are indexed per-row lookups instead of a GROUP BY over every allocation
// (point lookups ~60x faster, scans ~3.5x faster at 40k orders)
`
DROP VIEW IF EXISTS v_orders_fin;
DROP VIEW IF EXISTS v_orders;
CREATE VIEW v_orders AS
SELECT o.*,
  CASE WHEN o.status IN ('Draft','Cancelled','Returned') THEN 0 ELSE o.total END AS amount_due,
  COALESCE((SELECT SUM(a.applied_amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
            WHERE a.order_id = o.id AND p.voided = 0), 0) AS paid,
  COALESCE((SELECT SUM(-a.applied_amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
            WHERE a.order_id = o.id AND p.voided = 0 AND p.type = 'refund'), 0) AS refunded
FROM orders o;
CREATE VIEW v_orders_fin AS
SELECT v.*,
  v.amount_due - v.paid AS balance,
  CASE WHEN v.status = 'Draft' THEN 'Unpaid'
       WHEN v.refunded > 0 AND v.paid <= 0 THEN 'Refunded'
       WHEN v.paid <= 0 THEN 'Unpaid'
       WHEN v.paid < v.amount_due THEN 'Partially paid'
       ELSE 'Paid' END AS payment_status,
  CAST(ROUND(v.net_revenue * 1.0 / v.fx_rate) AS INTEGER) AS revenue_base,
  CAST(ROUND(v.total_cost * 1.0 / v.fx_rate) AS INTEGER) AS cost_base,
  CAST(ROUND(v.amount_due * 1.0 / v.fx_rate) AS INTEGER) AS due_base,
  CAST(ROUND((v.amount_due - v.paid) * 1.0 / v.fx_rate) AS INTEGER) AS balance_base
FROM v_orders v;
`,
// 3: SaaS: support sessions, per-user language, customer timeline events, usage counters
`
CREATE TABLE session_flags (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, impersonator TEXT, readonly INTEGER NOT NULL DEFAULT 0);
ALTER TABLE users ADD COLUMN language TEXT;
CREATE TABLE customer_events (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL, detail TEXT, user_id INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX idx_cevents ON customer_events(customer_id, id);
CREATE TABLE usage_counters (period TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (period, metric));
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
/** Apply pending migrations to one connection. A failure aborts that tenant only. */
export function migrate(c) {
  c.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(c.db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1; if (applied.has(v)) return;
    tx(() => { c.db.exec(sql); c.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(v, nowIso()); });
  });
}

// ---------------- settings ----------------
export const DEFAULT_SETTINGS = {
  business_name: 'My Business', business_phone: '', business_email: '', business_address: '', logo: '',
  base_currency: 'USD', currencies: ['USD', 'LBP'], timezone: 'Asia/Beirut', default_country_code: '961',
  tax_enabled: false, tax_rate: 0, tax_label: 'VAT',
  order_prefix: 'ORD-', revenue_recognition: 'delivered', stock_deduction: 'Confirmed',
  payment_methods: ['Cash', 'Bank transfer', 'Card'],
  expense_categories: ['Rent', 'Salaries', 'Utilities', 'Marketing', 'Transport', 'Supplies', 'Other'],
  customer_categories: ['Retail', 'Wholesale', 'VIP'],
  order_status_labels: {},
  at_risk_days: 45, inactive_days: 60, inactivity_periods: [30, 60, 90],
  loyal_orders: 5, loyal_spend: 100000, high_value_spend: 100000, frequent_orders: 3, frequent_window_days: 90,
  new_customer_days: 30, recent_active_days: 30,
  daily_sales_target: 0, monthly_sales_target: 0,
  pending_hours_alert: 24, unpaid_alert_days: 7, large_order_multiplier: 3, unusual_amount_multiplier: 5,
  fast_moving_units_30d: 20, slow_moving_days: 60, stock_anomaly_pct: 50, lead_time_days: 7,
  attribution_days: 7, reactivation_rate_estimate: 0.1,
  wa_optout_keywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'ايقاف', 'إلغاء'],
  wa_optin_keywords: ['START', 'SUBSCRIBE'],
  notification_recipients: [], owner_email: '', owner_whatsapp: '', owner_alert_template: '',
  email_digest_hour: 8, wa_last_test: null, is_demo: false,
  language: 'en', country: 'LB', business_type: '', integrations_enc: '', onboarding: {}, wa_number_state: { mode: 'byo', is_on_biz_app: false, coexistence: 'none' },
  ai_enabled: true, weekly_digest: true, usage_warned: {},
  notification_rules: {},
};
export function allSettings() {
  const c = conn();
  if (!c.cache) {
    const cache = { ...DEFAULT_SETTINGS };
    for (const r of all('SELECT key, value FROM business_settings')) cache[r.key] = safeJson(r.value, DEFAULT_SETTINGS[r.key]);
    c.cache = cache;
  }
  return c.cache;
}
export const setting = (k) => allSettings()[k];
export function setSettings(obj) {
  tx(() => {
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      run('INSERT INTO business_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v));
    }
  });
  conn().cache = null;
}

export function nextCounter(name) {
  run('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1', name);
  return get('SELECT value FROM counters WHERE name=?', name).value;
}

export function audit(user, action, entity, entityId, before, after, note) {
  run('INSERT INTO audit_logs(at,user_id,user_name,action,entity,entity_id,before,after,note,ip) VALUES (?,?,?,?,?,?,?,?,?,?)',
    nowIso(), user?.id ?? null, user?.name ?? 'system', action, entity, entityId == null ? null : String(entityId),
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note ?? null, user?.ip ?? null);
}

// ---------------- exchange rates ----------------
/** Units of `currency` per 1 base unit, effective on `onDate`. */
export function fxRate(currency, onDate) {
  const base = setting('base_currency');
  if (currency === base) return 1;
  const r = get('SELECT rate_per_base FROM exchange_rates WHERE currency=? AND effective_date<=? ORDER BY effective_date DESC, id DESC LIMIT 1', currency, onDate)
    || get('SELECT rate_per_base FROM exchange_rates WHERE currency=? ORDER BY effective_date ASC, id ASC LIMIT 1', currency);
  if (!r) throw Object.assign(new Error(`No exchange rate configured for ${currency}. Add one in Settings → Exchange rates.`), { status: 400 });
  return r.rate_per_base;
}

// ---------------- recognition helpers ----------------
export const RECOGNIZED = {
  confirmed: ['Confirmed', 'Processing', 'Ready', 'Out for delivery', 'Delivered', 'Completed'],
  delivered: ['Delivered', 'Completed'],
  completed: ['Completed'],
};
export function recognizedStatuses() { return RECOGNIZED[setting('revenue_recognition')] || RECOGNIZED.delivered; }
export const recognizedSql = (alias = 'o') => `${alias}.status IN (${recognizedStatuses().map((s) => `'${s}'`).join(',')})`;
export const recDateSql = (alias = 'o') => (setting('revenue_recognition') === 'confirmed' ? `${alias}.order_date` : `COALESCE(${alias}.delivery_date, ${alias}.order_date)`);

/** Per-tenant attachment directory. */
export const uploadsDir = () => (config.saas ? path.join(config.tenantsDir, tenantKey() + '-files') : config.uploadsDir);
