// Platform (root domain) behaviour: host -> scope/tenant resolution, signup, email verification, workspace discovery, provisioning.
import fs from 'node:fs';
import { GET, POST, setHostResolver, setLifecycleGate, setReadyCheck, setAdminResolver } from './http.js';
import { cGet, cAll, cRun, cTx, paudit, planByCode, listPlans, tenantRow, tenantBySub, control } from './control.js';
import { withTenant, run, get, setSettings, conn, tenantFile, closeTenant, poolStats, clearTenantFailure } from './db.js';
import { config } from './config.js';
import { randomToken, hashToken } from './crypto.js';
import { hashPassword, checkPassword } from './auth.js';
import { sendPlatformEmail } from './platformmail.js';
import { gate, setTenantStatus, TRIAL_DAYS, addD } from './lifecycle.js';
import { ensureDefaultTemplates } from './services/whatsapp.js';
import { COUNTRIES, countryList, LANGUAGES, CURRENCIES, RESERVED_SUBDOMAINS, DISPOSABLE_EMAIL_DOMAINS } from './countries.js';
import { checkCode, redeemCode } from './passes.js';
import { allow } from './ratelimit.js';
import { HttpError, bad, nowIso, safeJson, email as vEmail, str } from './util.js';
import { log } from './log.js';

// ---------- host resolution: the ONLY place a request is bound to a tenant ----------
const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
export function resolveHost(req) {
  if (!config.saas) return { scope: 'tenant' };
  // Only the Host header counts. X-Forwarded-Host / X-Tenant / any custom header is ignored on purpose.
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const dom = config.appDomain;
  if (host === dom || host === 'www.' + dom) return { scope: 'platform' };
  if (host === 'admin.' + dom) return { scope: 'admin' };
  if (host.endsWith('.' + dom)) {
    const sub = host.slice(0, -(dom.length + 1));
    if (!SUB_RE.test(sub)) return { scope: 'none', status: 404 };
    const t = tenantBySub(sub);
    if (!t || t.purged_at) return { scope: 'none', status: 404 };
    if (t.status === 'deleted') return { scope: 'none', status: 410 };
    return { scope: 'tenant', tenantId: t.id, tenant: t };
  }
  return { scope: 'none', status: 404 };
}

export function installPlatform({ adminResolver } = {}) {
  setHostResolver(resolveHost); setLifecycleGate(gate);
  if (adminResolver) setAdminResolver(adminResolver);
  setReadyCheck(async () => {
    const checks = {}; try { control().prepare('SELECT 1').get(); checks.control = true; } catch { checks.control = false; }
    try { const st = fs.statfsSync(config.tenantsDir.replace(/[\\/]tenants$/, '') || '.'); checks.disk_free_pct = Math.round((st.bavail / st.blocks) * 100); } catch { /* not available */ }
    const { shutdown } = await import('./shutdown.js'); if (shutdown.draining) return { ok: false, draining: true };
    return { ok: checks.control !== false && (checks.disk_free_pct ?? 100) > 3, ...checks, pool: poolStats() };
  });
}

// ---------- provisioning ----------
export const newTenantId = () => 't_' + randomToken(8);
export function validateSubdomain(sub) {
  const s = String(sub || '').trim().toLowerCase();
  if (s.length < 3 || s.length > 30) throw bad('The address must be 3–30 characters');
  if (!SUB_RE.test(s)) throw bad('Use only lowercase letters, digits and hyphens (not at the start or end)');
  if (s.includes('--')) throw bad('Please avoid double hyphens');
  if (RESERVED_SUBDOMAINS.has(s) || /^(xn--|admin|billing|support|secure|login|account)/.test(s)) throw bad('That address is reserved. Please choose another');
  return s;
}
export function provisionTenant({ business_name, owner_name, email, password, country, currency, language, subdomain, ip, flags = {}, status = 'pending_verification' }) {
  const [cName, cc, tz, defCur] = COUNTRIES[country]; void cName;
  const id = newTenantId(); const plan = planByCode('growth');
  cTx(() => {
    const acc = cRun('INSERT INTO accounts(email,name,country,currency,language,billing_route,created_at,signup_ip) VALUES (?,?,?,?,?,?,?,?)', email, owner_name, country, currency, language, country === 'LB' ? 'manual' : 'paddle', nowIso(), ip || null).lastInsertRowid;
    cRun('INSERT INTO tenants(id,account_id,subdomain,business_name,status,plan_id,webhook_key,flags,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, acc, subdomain, business_name, status, plan.id, randomToken(16), JSON.stringify(flags), nowIso());
    try {
      withTenant(id, () => {
        conn();   // creates the file, runs migrations, seeds roles
        const owner = get("SELECT id FROM roles WHERE name='OWNER'");
        const cur = currency; const base = cur;
        setSettings({ business_name, base_currency: base, currencies: [base], timezone: tz, default_country_code: cc, language, country, owner_email: email });
        run('INSERT INTO users(email,name,password_hash,role_id,language,created_at) VALUES (?,?,?,?,?,?)', email, owner_name, hashPassword(password), owner.id, language, nowIso());
        ensureDefaultTemplates(language);
      });
    } catch (e) { closeTenant(id); clearTenantFailure(id); for (const x of [tenantFile(id), tenantFile(id) + '-wal', tenantFile(id) + '-shm']) fs.rmSync(x, { force: true }); throw e; }
  });
  return id;
}

async function turnstileOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET; if (!secret) return true;
  if (!token) return false;
  try {
    const r = await fetch(process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }), signal: AbortSignal.timeout(8000) });
    return Boolean((await r.json()).success);
  } catch { return false; }
}
const P = { perm: 'public', scope: 'platform' };
const issueToken = (kind, data, hours) => { const t = randomToken(32); cRun('INSERT INTO tokens(token_hash,kind,tenant_id,account_id,data,expires_at) VALUES (?,?,?,?,?,?)', hashToken(t), kind, data.tenantId || null, data.accountId || null, JSON.stringify(data), new Date(Date.now() + hours * 3600e3).toISOString()); return t; };
const sendVerify = (t, a) => sendPlatformEmail('verify', a.email, { name: a.name, business: t.business_name, url: config.platformUrl('/verify?token=' + issueToken('verify', { tenantId: t.id, accountId: a.id }, 48)) }, a.language || 'en');

GET('/api/platform/config', P, () => ({ name: process.env.PLATFORM_NAME || 'BizControl', turnstile_site_key: process.env.TURNSTILE_SITE_KEY || null, app_domain: config.appDomain, paddle: process.env.PADDLE_CLIENT_TOKEN ? { env: process.env.PADDLE_ENV || 'sandbox', client_token: process.env.PADDLE_CLIENT_TOKEN } : null, languages: LANGUAGES, trial_days: TRIAL_DAYS }));
GET('/api/platform/plans', P, () => listPlans().map((p) => ({ code: p.code, name: p.name, price_monthly: p.price_monthly, price_annual: p.price_annual, currency: p.currency, limits: p.limits, features: p.features })));
GET('/api/platform/countries', P, () => ({ countries: countryList(), currencies: CURRENCIES, languages: LANGUAGES }));
GET('/api/platform/subdomain-check', P, (ctx) => {
  if (!allow('subcheck:' + ctx.ip, 30, 60_000)) throw new HttpError(429, 'Too many checks. Please wait a moment.');
  let s; try { s = validateSubdomain(ctx.query.name); } catch (e) { return { available: false, reason: e.message }; }
  return tenantBySub(s) ? { available: false, reason: 'That address is already taken' } : { available: true, subdomain: s, url: config.tenantUrl(s) };
});

POST('/api/platform/signup', P, async (ctx) => {
  const b = ctx.body;
  if (!allow('signup-try:' + ctx.ip, 40, 3600e3)) throw new HttpError(429, 'Too many attempts from your network. Please try again later.');   // generous: honest typos must not lock anyone out
  if (!(await turnstileOk(b.turnstile_token, ctx.ip))) throw bad('Please complete the human check and try again');
  const business_name = str(b.business_name, 'Business name', { required: true, max: 80, min: 2 }); const owner_name = str(b.owner_name, 'Your name', { required: true, max: 80, min: 2 });
  const email = vEmail(b.email, 'Email', { required: true }); checkPassword(b.password);
  const domain = email.split('@')[1]; if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) throw bad('Please use a permanent email address (disposable addresses are not accepted)');
  const country = String(b.country || 'OTHER').toUpperCase(); if (!COUNTRIES[country]) throw bad('Choose your country');
  const currency = String(b.currency || COUNTRIES[country][3]).toUpperCase(); if (!CURRENCIES.includes(currency)) throw bad('Choose a supported currency');
  const language = LANGUAGES.includes(b.language) ? b.language : 'en';
  const subdomain = validateSubdomain(b.subdomain);
  if (tenantBySub(subdomain)) throw new HttpError(409, 'That address is already taken. Please choose another.');
  if (cGet('SELECT COUNT(*) c FROM accounts WHERE email=?', email).c >= 3) throw new HttpError(429, 'This email already has the maximum number of workspaces.');
  // only real creations count toward the tight limit
  if (!allow('signup:' + ctx.ip, 5, 3600e3) || !allow('signup-day:' + ctx.ip, 15, 86400e3)) throw new HttpError(429, 'Too many workspaces created from your network. Please try again later.');
  const pass = b.pass ? String(b.pass).trim().toUpperCase() : null; if (pass && !checkCode(pass)) throw bad('That pass code is not valid or was already used');
  const id = provisionTenant({ business_name, owner_name, email, password: b.password, country, currency, language, subdomain, ip: ctx.ip, flags: pass ? { pass_code: pass } : {} });
  const t = tenantRow(id); const a = cGet('SELECT * FROM accounts WHERE id=?', t.account_id);
  sendVerify(t, a); paudit('signup', 'signup', id, { email, country, subdomain }, ctx.ip);
  return { ok: true, subdomain, message: 'Check your email to confirm your address and activate your workspace.' };
});

POST('/api/platform/verify', P, (ctx) => {
  if (!allow('verify:' + ctx.ip, 30, 3600e3)) throw new HttpError(429, 'Too many attempts');
  const tok = cGet('SELECT * FROM tokens WHERE token_hash=? AND kind=?', hashToken(String(ctx.body.token || '')), 'verify');
  if (!tok || tok.used_at || tok.expires_at < nowIso()) throw bad('This confirmation link is invalid or has expired. Request a new one from the sign-up page.');
  const t = tenantRow(tok.tenant_id); if (!t) throw bad('Workspace not found');
  const a = cGet('SELECT * FROM accounts WHERE id=?', t.account_id);
  cRun('UPDATE tokens SET used_at=? WHERE token_hash=?', nowIso(), tok.token_hash);
  if (t.status === 'pending_verification') {
    // one free trial per verified email: later workspaces need a plan before they can create data
    const trialUsed = cGet("SELECT 1 x FROM tenants t JOIN accounts ac ON ac.id=t.account_id WHERE ac.email=? AND t.id<>? AND t.verified_at IS NOT NULL AND t.status<>'deleted' AND json_extract(t.flags,'$.trial_granted')=1", a.email, t.id);
    cRun("UPDATE accounts SET email_verified_at=? WHERE id=?", nowIso(), a.id);
    const flags = { ...safeJson(t.flags, {}), trial_granted: trialUsed ? 0 : 1 };
    if (trialUsed) setTenantStatus(t.id, 'suspended', { verified_at: nowIso(), suspended_reason: 'trial_used', flags: JSON.stringify(flags) }, 'system', 'email already used a trial');
    else setTenantStatus(t.id, 'trialing', { verified_at: nowIso(), trial_ends_at: addD(nowIso(), TRIAL_DAYS), flags: JSON.stringify(flags) }, 'system', 'email verified');
    const pc = safeJson(t.flags, {}).pass_code; if (pc) redeemCode(tenantRow(t.id), pc);
    const t2 = tenantRow(t.id); sendPlatformEmail('welcome', a.email, { name: a.name, business: t2.business_name, url: config.tenantUrl(t2.subdomain), date: (t2.trial_ends_at || '').slice(0, 10) }, a.language || 'en');
  }
  return { ok: true, tenant_url: config.tenantUrl(t.subdomain), subdomain: t.subdomain };
});
POST('/api/platform/resend-verification', P, (ctx) => {
  const generic = { ok: true, message: 'If that address is waiting for confirmation, we sent a new link.' };
  const email = String(ctx.body.email || '').trim().toLowerCase();
  if (!allow('resend:' + ctx.ip, 5, 3600e3) || !allow('resend-e:' + email, 3, 3600e3)) throw new HttpError(429, 'Too many requests. Please try again later.');
  for (const t of cAll("SELECT t.* FROM tenants t JOIN accounts a ON a.id=t.account_id WHERE a.email=? AND t.status='pending_verification'", email)) sendVerify(t, cGet('SELECT * FROM accounts WHERE id=?', t.account_id));
  return generic;
});
// "Find my workspace": by address (public information, subdomains are public DNS) or by email (answer goes to the inbox only, never to the page)
POST('/api/platform/find', P, (ctx) => {
  if (!allow('find:' + ctx.ip, 30, 3600e3)) throw new HttpError(429, 'Too many requests');
  let s; try { s = validateSubdomain(String(ctx.body.subdomain || '').toLowerCase().replace(new RegExp('\\.' + config.appDomain.replace(/\./g, '\\.') + '$'), '')); } catch { return { found: false }; }
  const t = tenantBySub(s); return t && t.status !== 'deleted' && !t.purged_at ? { found: true, url: config.tenantUrl(s) } : { found: false };
});
POST('/api/platform/discover', P, (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  if (!allow('discover:' + ctx.ip, 5, 3600e3) || !allow('discover-e:' + email, 3, 3600e3)) throw new HttpError(429, 'Too many requests. Please try again later.');
  const rows = cAll("SELECT t.subdomain, t.business_name, a.language FROM tenants t JOIN accounts a ON a.id=t.account_id WHERE a.email=? AND t.status NOT IN ('deleted','pending_verification') AND t.purged_at IS NULL", email);
  if (rows.length) sendPlatformEmail('discover', email, { list: rows.map((r) => ({ business: r.business_name, url: config.tenantUrl(r.subdomain) })) }, rows[0].language || 'en');
  return { ok: true, message: 'If we found workspaces for that email, we sent the addresses to it.' };
});
