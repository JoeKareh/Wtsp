// Control plane: accounts, tenants, plans, subscriptions, invoices, super-admins, platform audit. One SQLite file, separate from every tenant.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { nowIso, safeJson } from './util.js';

let cdb = null;
const MIG = [`
CREATE TABLE plans (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, price_monthly INTEGER NOT NULL, price_annual INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD', limits TEXT NOT NULL, features TEXT NOT NULL, paddle_price_monthly TEXT, paddle_price_annual TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT, country TEXT, currency TEXT, language TEXT,
  billing_route TEXT NOT NULL DEFAULT 'paddle' CHECK (billing_route IN ('paddle','manual','whish')), paddle_customer_id TEXT,
  created_at TEXT NOT NULL, email_verified_at TEXT, signup_ip TEXT
);
CREATE INDEX idx_accounts_email ON accounts(email);
CREATE TABLE tenants (
  id TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), subdomain TEXT NOT NULL UNIQUE, business_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification','trialing','active','past_due','suspended','canceled','deleted')),
  plan_id INTEGER REFERENCES plans(id), billing_interval TEXT NOT NULL DEFAULT 'month',
  trial_ends_at TEXT, grace_ends_at TEXT, paid_through TEXT, canceled_at TEXT, delete_after TEXT, purge_after TEXT, purged_at TEXT,
  disabled_reason TEXT, suspended_reason TEXT, webhook_key TEXT UNIQUE, flags TEXT NOT NULL DEFAULT '{}', reminders TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, verified_at TEXT, last_activity_at TEXT, order_count INTEGER NOT NULL DEFAULT 0, db_bytes INTEGER NOT NULL DEFAULT 0, stats_at TEXT, cancel_reason TEXT
);
CREATE INDEX idx_tenants_account ON tenants(account_id);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), provider TEXT NOT NULL, provider_ref TEXT NOT NULL, status TEXT NOT NULL,
  plan_id INTEGER, interval TEXT, current_period_end TEXT, cancel_at TEXT, last_event_at TEXT, updated_at TEXT NOT NULL, UNIQUE(provider, provider_ref)
);
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), number TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, provider_ref TEXT,
  description TEXT NOT NULL, amount_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paid',
  period_start TEXT, period_end TEXT, issued_at TEXT NOT NULL, method TEXT, reference TEXT, UNIQUE(provider, provider_ref)
);
CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT, received_at TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received', error TEXT, UNIQUE(provider, event_id)
);
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, totp_secret_enc TEXT NOT NULL,
  totp_last_step INTEGER NOT NULL DEFAULT 0, recovery TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE admin_sessions (id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT NOT NULL, ip TEXT);
CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant_id TEXT, account_id INTEGER, data TEXT, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE platform_audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, tenant_id TEXT, detail TEXT, ip TEXT);
CREATE INDEX idx_paudit_tenant ON platform_audit(tenant_id, id);
CREATE TABLE platform_outbox (
  id INTEGER PRIMARY KEY, kind TEXT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, html TEXT, attachments TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
CREATE TABLE surveys (id INTEGER PRIMARY KEY, tenant_id TEXT, kind TEXT NOT NULL, answer TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE alerts_sent (key TEXT PRIMARY KEY, at TEXT NOT NULL);
`, `
CREATE TABLE passes (
  code TEXT PRIMARY KEY, plan_code TEXT NOT NULL, days INTEGER, unlimited INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1, used INTEGER NOT NULL DEFAULT 0,
  note TEXT, expires_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL
);
`];

export function control() {
  if (cdb) return cdb;
  fs.mkdirSync(path.dirname(config.controlDbPath), { recursive: true });
  cdb = new DatabaseSync(config.controlDbPath);
  cdb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  cdb.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(cdb.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  MIG.forEach((sql, i) => { if (applied.has(i + 1)) return; cdb.exec('BEGIN'); try { cdb.exec(sql); cdb.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(i + 1, nowIso()); cdb.exec('COMMIT'); } catch (e) { cdb.exec('ROLLBACK'); throw e; } });
  seedPlans();
  return cdb;
}
export const closeControl = () => { if (cdb) { try { cdb.close(); } catch { /* ignore */ } cdb = null; } };
export const cAll = (sql, ...p) => control().prepare(sql).all(...p);
export const cGet = (sql, ...p) => { const r = control().prepare(sql).get(...p); return r ? { ...r } : undefined; };
export const cRun = (sql, ...p) => control().prepare(sql).run(...p);
let depth = 0;
export function cTx(fn) {
  const d = control();
  if (depth > 0) { const sp = 'c' + depth; d.exec(`SAVEPOINT ${sp}`); depth++; try { const r = fn(); d.exec(`RELEASE ${sp}`); return r; } catch (e) { d.exec(`ROLLBACK TO ${sp}`); d.exec(`RELEASE ${sp}`); throw e; } finally { depth--; } }
  d.exec('BEGIN IMMEDIATE'); depth++;
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { try { d.exec('ROLLBACK'); } catch { /* ignore */ } throw e; } finally { depth--; }
}
export function cCounter(name) { cRun('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1', name); return cGet('SELECT value FROM counters WHERE name=?', name).value; }
export function paudit(actor, action, tenantId, detail, ip) { cRun('INSERT INTO platform_audit(at,actor,action,tenant_id,detail,ip) VALUES (?,?,?,?,?,?)', nowIso(), actor, action, tenantId ?? null, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), ip ?? null); }

function seedPlans() {
  if (cdb.prepare('SELECT COUNT(*) c FROM plans').get().c) return;
  const ins = cdb.prepare('INSERT INTO plans(code,name,price_monthly,price_annual,currency,limits,features,sort) VALUES (?,?,?,?,?,?,?,?)');
  // Prices in minor units (USD cents). Annual = 10 x monthly (two months free). Editable by the super-admin; nothing is hard-coded elsewhere.
  ins.run('starter', 'Starter', 1900, 19000, 'USD', JSON.stringify({ users: 2, orders_month: 300, orders_grace_pct: 20, wa_marketing_month: 0, ai_credits_month: 0 }), JSON.stringify({ campaigns: false, segments: false, ai: false, api: false, multi_branch: false }), 1);
  ins.run('growth', 'Growth', 4900, 49000, 'USD', JSON.stringify({ users: 5, orders_month: 2000, orders_grace_pct: 20, wa_marketing_month: 1000, ai_credits_month: 200 }), JSON.stringify({ campaigns: true, segments: true, ai: true, api: false, multi_branch: false }), 2);
  ins.run('business', 'Business', 9900, 99000, 'USD', JSON.stringify({ users: 15, orders_month: 10000, orders_grace_pct: 20, wa_marketing_month: 5000, ai_credits_month: 1000 }), JSON.stringify({ campaigns: true, segments: true, ai: true, api: true, multi_branch: true }), 3);
}
export const planById = (id) => { const p = cGet('SELECT * FROM plans WHERE id=?', id); return p ? { ...p, limits: safeJson(p.limits, {}), features: safeJson(p.features, {}) } : null; };
export const planByCode = (code) => { const p = cGet('SELECT * FROM plans WHERE code=?', code); return p ? { ...p, limits: safeJson(p.limits, {}), features: safeJson(p.features, {}) } : null; };
export const listPlans = (activeOnly = true) => cAll(`SELECT * FROM plans ${activeOnly ? 'WHERE active=1' : ''} ORDER BY sort`).map((p) => ({ ...p, limits: safeJson(p.limits, {}), features: safeJson(p.features, {}) }));
export const tenantRow = (id) => cGet('SELECT * FROM tenants WHERE id=?', id);
export const tenantBySub = (sub) => cGet('SELECT * FROM tenants WHERE subdomain=?', sub);
