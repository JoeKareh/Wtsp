import fs from 'node:fs';
import path from 'node:path';
import { GET, POST, PUT, raw } from '../http.js';
import { all, get, run, db, allSettings, setSettings, DEFAULT_SETTINGS, audit, tx } from '../db.js';
import { bad, str, num, int, oneOf, date, nowIso, todayStr } from '../util.js';
import { PERMISSIONS } from '../perms.js';
import { config } from '../config.js';
import { STATUSES } from './orders.js';
import { NOTIFICATION_TYPES, allRules } from './notifications.js';
import { waStatus } from './whatsapp.js';
import { outboxStats } from '../mail.js';

const CUR = /^[A-Z]{3}$/;
const list = (v, name, { max = 40, min = 1 } = {}) => {
  if (!Array.isArray(v)) throw bad(`${name} must be a list`);
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  if (out.length < min) throw bad(`${name} needs at least ${min} value(s)`);
  if (out.some((x) => x.length > 60) || out.length > max) throw bad(`${name} is too long`);
  return out;
};
const SCHEMA = {
  business_name: (v) => str(v, 'Business name', { required: true, max: 120 }),
  business_phone: (v) => str(v, 'Phone', { max: 40 }), business_email: (v) => str(v, 'Email', { max: 120 }), business_address: (v) => str(v, 'Address', { max: 300 }),
  logo: (v) => { if (!v) return ''; if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) throw bad('Logo must be a PNG, JPG or WEBP image'); if (v.length > 400000) throw bad('Logo must be smaller than 300 KB'); return v; },
  base_currency: (v) => { if (!CUR.test(v)) throw bad('Currency must be a 3-letter code such as USD'); return v; },
  currencies: (v) => { const l = list(v, 'Currencies', { max: 8 }); if (l.some((c) => !CUR.test(c))) throw bad('Currencies must be 3-letter codes'); return l; },
  timezone: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw bad('Unknown time zone'); } return v; },
  default_country_code: (v) => { if (!/^\d{0,4}$/.test(String(v))) throw bad('Country code must be digits only, e.g. 961'); return String(v); },
  tax_enabled: Boolean, tax_rate: (v) => num(v, 'Tax rate', { min: 0, max: 100 }), tax_label: (v) => str(v, 'Tax label', { max: 20 }) || 'Tax',
  order_prefix: (v) => str(v, 'Order prefix', { max: 10 }), revenue_recognition: (v) => oneOf(v, 'Revenue recognition', ['confirmed', 'delivered', 'completed']),
  stock_deduction: (v) => oneOf(v, 'Stock deduction', ['Confirmed', 'Processing', 'Out for delivery', 'Delivered', 'Completed']),
  payment_methods: (v) => list(v, 'Payment methods'), expense_categories: (v) => list(v, 'Expense categories'), customer_categories: (v) => list(v, 'Customer categories', { min: 0 }),
  order_status_labels: (v) => { const o = {}; for (const [k, l] of Object.entries(v || {})) if (STATUSES.includes(k) && String(l).trim()) o[k] = String(l).trim().slice(0, 30); return o; },
  at_risk_days: (v) => int(v, 'At-risk days', { min: 1, max: 3650 }), inactive_days: (v) => int(v, 'Inactive days', { min: 1, max: 3650 }),
  inactivity_periods: (v) => list(v, 'Inactivity periods', { max: 6 }).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b),
  loyal_orders: (v) => int(v, 'Loyal orders', { min: 1 }), loyal_spend: (v) => int(v, 'Loyal spend', { min: 0 }), high_value_spend: (v) => int(v, 'High-value spend', { min: 0 }),
  frequent_orders: (v) => int(v, 'Frequent orders', { min: 1 }), frequent_window_days: (v) => int(v, 'Frequent window', { min: 1 }), new_customer_days: (v) => int(v, 'New customer days', { min: 1 }), recent_active_days: (v) => int(v, 'Recent days', { min: 1 }),
  daily_sales_target: (v) => int(v, 'Daily target', { min: 0 }), monthly_sales_target: (v) => int(v, 'Monthly target', { min: 0 }),
  pending_hours_alert: (v) => int(v, 'Pending hours', { min: 1 }), unpaid_alert_days: (v) => int(v, 'Unpaid days', { min: 0 }),
  large_order_multiplier: (v) => num(v, 'Large order multiplier', { min: 1.1 }), unusual_amount_multiplier: (v) => num(v, 'Unusual amount multiplier', { min: 1.1 }),
  fast_moving_units_30d: (v) => num(v, 'Fast-moving units', { min: 1 }), slow_moving_days: (v) => int(v, 'Slow-moving days', { min: 7 }), stock_anomaly_pct: (v) => num(v, 'Stock anomaly %', { min: 1, max: 100 }), lead_time_days: (v) => int(v, 'Lead time', { min: 0, max: 365 }),
  attribution_days: (v) => int(v, 'Attribution window', { min: 1, max: 60 }), reactivation_rate_estimate: (v) => num(v, 'Reactivation rate', { min: 0, max: 1 }),
  wa_optout_keywords: (v) => list(v, 'Opt-out keywords', { min: 1 }), wa_optin_keywords: (v) => list(v, 'Opt-in keywords', { min: 1 }),
  owner_email: (v) => str(v, 'Owner email', { max: 120 }), owner_whatsapp: (v) => str(v, 'Owner WhatsApp', { max: 30 }), owner_alert_template: (v) => str(v, 'Owner alert template', { max: 10 }),
  notification_recipients: (v) => list(v, 'Recipients', { min: 0 }), email_digest_hour: (v) => int(v, 'Digest hour', { min: 0, max: 23 }),
  notification_rules: (v) => {
    const o = {};
    for (const [k, r] of Object.entries(v || {})) {
      if (!NOTIFICATION_TYPES[k]) continue;
      o[k] = { enabled: !!r.enabled, in_app: !!r.in_app, email: !!r.email, whatsapp: !!r.whatsapp, frequency: oneOf(r.frequency, 'Frequency', ['immediate', 'daily'], { def: 'immediate' }) };
    }
    return o;
  },
};
const PUBLIC_KEYS = ['business_name', 'logo', 'base_currency', 'currencies', 'timezone', 'default_country_code', 'tax_enabled', 'tax_rate', 'tax_label', 'order_prefix', 'payment_methods', 'expense_categories', 'customer_categories', 'order_status_labels', 'revenue_recognition', 'stock_deduction', 'is_demo', 'at_risk_days', 'inactive_days', 'inactivity_periods', 'business_phone', 'business_email', 'business_address'];

GET('/api/bootstrap', {}, (ctx) => {
  const s = allSettings();
  return {
    settings: Object.fromEntries(PUBLIC_KEYS.map((k) => [k, s[k]])), statuses: STATUSES,
    product_categories: all('SELECT * FROM product_categories ORDER BY name'), permission_catalog: PERMISSIONS,
    exchange_rates: all(`SELECT currency, rate_per_base, effective_date FROM exchange_rates e WHERE id=(SELECT id FROM exchange_rates WHERE currency=e.currency ORDER BY effective_date DESC, id DESC LIMIT 1)`),
    today: todayStr(s.timezone),
  };
});
GET('/api/settings', { perm: 'settings:write' }, () => ({
  settings: allSettings(), defaults: DEFAULT_SETTINGS, notification_rules: allRules(),
  integrations: { whatsapp: waStatus(), email: outboxStats(), ai: { enabled: Boolean(config.ai().key), model: config.ai().model }, base_url: config.baseUrl },
  has_data: hasData(),
}));
const hasData = () => Boolean(get('SELECT (SELECT COUNT(*) FROM orders)+(SELECT COUNT(*) FROM payments)+(SELECT COUNT(*) FROM expenses) n').n);

PUT('/api/settings', { perm: 'settings:write' }, (ctx) => {
  const cur = allSettings(); const patch = {};
  for (const [k, v] of Object.entries(ctx.body || {})) {
    if (!SCHEMA[k]) continue;
    patch[k] = SCHEMA[k](v);
  }
  const base = patch.base_currency ?? cur.base_currency; const currencies = patch.currencies ?? cur.currencies;
  if (patch.base_currency && patch.base_currency !== cur.base_currency && hasData()) throw bad('The reporting currency cannot be changed after orders, payments or expenses exist, because all stored exchange rates are relative to it.');
  if (!currencies.includes(base)) throw bad('The reporting currency must be in the currency list');
  if ((patch.inactive_days ?? cur.inactive_days) <= (patch.at_risk_days ?? cur.at_risk_days)) throw bad('"Inactive after" days must be greater than "at risk after" days');
  for (const c of currencies) if (c !== base && !get('SELECT 1 x FROM exchange_rates WHERE currency=?', c) && patch.currencies) throw bad(`Add an exchange rate for ${c} first (Settings → Exchange rates), then enable it`);
  tx(() => { setSettings(patch); audit(ctx.user, 'update', 'settings', null, Object.fromEntries(Object.keys(patch).filter((k) => k !== 'logo').map((k) => [k, cur[k]])), Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'logo'))); });
  return { settings: allSettings(), notification_rules: allRules() };
});

GET('/api/exchange-rates', { perm: ['settings:write', 'payments:read', 'finance:read'] }, () => ({ base: allSettings().base_currency, rows: all('SELECT * FROM exchange_rates ORDER BY effective_date DESC, id DESC LIMIT 200') }));
POST('/api/exchange-rates', { perm: 'settings:write' }, (ctx) => {
  const s = allSettings(); const currency = String(ctx.body.currency || '').toUpperCase();
  if (currency === s.base_currency) throw bad('The reporting currency always has a rate of 1');
  if (!CUR.test(currency)) throw bad('Enter a 3-letter currency code');
  const rate = num(ctx.body.rate_per_base, 'Rate', { required: true, min: 0.000001 });
  const eff = date(ctx.body.effective_date || todayStr(s.timezone), 'Effective date');
  const id = run('INSERT INTO exchange_rates(currency,rate_per_base,effective_date,note,created_by,created_at) VALUES (?,?,?,?,?,?)', currency, rate, eff, str(ctx.body.note, 'Note', { max: 200 }), ctx.user.id, nowIso()).lastInsertRowid;
  audit(ctx.user, 'create', 'exchange_rate', id, null, { currency, rate, eff });
  return { id };
});

GET('/api/backup', { perm: 'users:manage' }, (ctx) => {
  const dir = path.join(config.dataDir, 'tmp'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backup-${Date.now()}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const buf = fs.readFileSync(file); fs.rmSync(file, { force: true });
  audit(ctx.user, 'backup_download', 'system', null);
  return raw(buf, 'application/octet-stream', `bizcontrol-backup-${nowIso().slice(0, 10)}.sqlite`);
});
GET('/api/health', { perm: 'public' }, () => { get('SELECT 1'); return { ok: true, time: nowIso() }; });
