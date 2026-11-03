import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootSaas, HostClient, makeTenant, DOMAIN } from './saas-helpers.js';

let S; let adm; let secret; let recovery; let T;
const stepCode = (offset = 0) => S.totp.code(secret, S.totp.currentStep() + offset);
const login = async (c, over = {}) => c.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: stepCode(), ...over });
before(async () => {
  S = await bootSaas(); const a = S.admin.createAdmin('root@platform.test', 'Root', 'Sup3r-secret-pass'); secret = a.secret; recovery = a.recovery;
  adm = new HostClient(S.port, `admin.${DOMAIN}`); T = await makeTenant(S, { business_name: 'Target Biz' });
});
after(async () => { await S?.close(); });

describe('TOTP (RFC 6238)', () => {
  test('matches the RFC test vector and base32 round-trips', () => {
    const sec = S.totp.base32(Buffer.from('12345678901234567890')); assert.equal(sec, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(S.totp.code(sec, Math.floor(59 / 30)), '287082'); assert.equal(S.totp.code(sec, Math.floor(1111111109 / 30)), '081804'); assert.equal(S.totp.unbase32(sec).toString(), '12345678901234567890');
  });
  test('otpauth URI is well formed', () => assert.match(S.totp.otpauth('a@b.c', 'ABC'), /^otpauth:\/\/totp\/.+secret=ABC.*period=30/));
});

describe('super-admin authentication', () => {
  test('password alone is never enough; wrong password and wrong code fail with the same message', async () => {
    const c = new HostClient(S.port, `admin.${DOMAIN}`);
    const a = await c.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass' }); const b = await c.post('/api/admin/login', { email: 'root@platform.test', password: 'nope', code: stepCode() });
    const d = await c.post('/api/admin/login', { email: 'nobody@platform.test', password: 'x', code: '123456' }); assert.deepEqual([a.status, b.status, d.status], [401, 401, 401]); assert.equal(a.data.error, b.data.error); assert.equal(b.data.error, d.data.error);
    assert.equal((await c.get('/api/admin/tenants')).status, 401);
  });
  test('a TOTP code cannot be replayed; the next time step works', async () => {
    const c1 = new HostClient(S.port, `admin.${DOMAIN}`); const code = stepCode(); assert.equal((await c1.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code })).status, 200);
    const c2 = new HostClient(S.port, `admin.${DOMAIN}`); assert.equal((await c2.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code })).status, 401, 'replay refused');
    assert.equal((await c2.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: stepCode(1) })).status, 200);
  });
  test('recovery codes work exactly once', async () => {
    const c = new HostClient(S.port, `admin.${DOMAIN}`); assert.equal((await c.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: recovery[0] })).status, 200);
    assert.equal((await new HostClient(S.port, `admin.${DOMAIN}`).post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: recovery[0] })).status, 401);
  });
  test('the TOTP secret is stored encrypted and recovery codes hashed', () => {
    const row = S.control.cGet('SELECT * FROM admin_users LIMIT 1'); assert.ok(!row.totp_secret_enc.includes(secret)); assert.match(row.totp_secret_enc, /^v1\./); assert.ok(!row.recovery.includes(recovery[1]));
  });
  test('five wrong attempts lock the account out for 15 minutes, even with the right credentials', async () => {
    const c = new HostClient(S.port, `admin.${DOMAIN}`); for (let i = 0; i < 5; i++) await c.post('/api/admin/login', { email: 'root@platform.test', password: 'wrong' });
    assert.equal((await c.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: stepCode(-1) })).status, 429); S.admin.resetAdminThrottle();
  });
  test('state-changing admin calls need the CSRF header; the session cookie is HttpOnly + SameSite=Strict', async () => {
    const ok = new HostClient(S.port, `admin.${DOMAIN}`); const r = await ok.post('/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: recovery[2] }); assert.equal(r.status, 200);
    assert.match(r.headers['set-cookie'][0], /HttpOnly/); assert.match(r.headers['set-cookie'][0], /SameSite=Strict/);
    const bad = await ok.req('POST', `/api/admin/tenants/${T.id}/suspend`, {}, { 'X-Requested-With': '' }); assert.equal(bad.status, 403); adm = ok;
  });
});

describe('tenant operations', () => {
  const ops = (m, p, b) => adm.req(m, `/api/admin/tenants/${T.id}${p}`, b);
  test('list, search and detail never expose password hashes or secrets', async () => {
    const l = await adm.ok('GET', '/api/admin/tenants?q=Target'); assert.ok(l.rows.some((r) => r.id === T.id)); const d = await adm.ok('GET', `/api/admin/tenants/${T.id}`);
    for (const x of [l, d]) { const j = JSON.stringify(x); assert.ok(!/scrypt\$|password_hash|integrations_enc|totp/.test(j)); }
    assert.ok(l.rows.find((r) => r.id === T.id).owner_email === T.email);
  });
  test('suspend makes the workspace read-only immediately; unsuspend restores it; extend-trial and plan change are audited', async () => {
    assert.equal((await ops('POST', '/suspend', { reason: 'chargeback' })).status, 200); assert.equal((await T.c.post('/api/customers', { name: 'x', phone: '70 100 100' })).status, 402);
    assert.equal((await ops('POST', '/unsuspend')).status, 200); assert.equal((await T.c.post('/api/customers', { name: 'x', phone: '70 100 100' })).status, 200);
    const e = await ops('POST', '/extend-trial', { days: 10 }); assert.equal(e.status, 200); assert.ok(Date.parse(e.data.trial_ends_at) > Date.now() + 20 * 864e5);
    assert.equal((await ops('POST', '/plan', { plan: 'business', interval: 'year' })).data.plan, 'business'); assert.equal((await ops('POST', '/plan', { plan: 'nope' })).status, 400);
    const audit = (await adm.ok('GET', `/api/admin/audit?tenant=${T.id}`)).rows.map((r) => r.action); for (const a of ['status:suspended', 'status:trialing', 'plan_changed']) assert.ok(audit.includes(a), a);
  });
  test('support session: one-time, 60-second, bound to ONE tenant, read-only by default, audited on both sides', async () => {
    const o = await ops('POST', '/impersonate', { reason: 'help with import' }); assert.equal(o.status, 200); assert.equal(o.data.readonly, true);
    const path = o.data.url.replace(/^https?:\/\/[^/]+/, ''); const other = await makeTenant(S);
    assert.equal((await other.c.get(path)).status, 403, 'token for tenant T used on another tenant');
    const sup = new HostClient(S.port, T.c.host); const enter = await sup.get(path); assert.equal(enter.status, 302); assert.equal(enter.headers.location, '/');
    assert.equal((await new HostClient(S.port, T.c.host).get(path)).status, 403, 'single use');
    const st = await sup.ok('GET', '/api/auth/status'); assert.deepEqual(st.support_session, { by: 'root@platform.test', readonly: true });
    assert.equal((await sup.get('/api/customers')).status, 200); const w = await sup.post('/api/customers', { name: 'nope', phone: '70 900 900' }); assert.equal(w.status, 403); assert.equal(w.data.details.code, 'support_readonly');
    assert.ok((await T.c.ok('GET', '/api/audit?limit=50')).rows.some((r) => r.action === 'support_session_start' && /Support: root@platform.test/.test(r.user_name)), 'visible in the tenant\'s own audit log');
    assert.ok((await adm.ok('GET', `/api/admin/audit?tenant=${T.id}`)).rows.some((r) => r.action === 'impersonation_started'));
  });
  test('a write-enabled support session must be requested explicitly, and expires after 30 minutes', async () => {
    const o = await ops('POST', '/impersonate', { write: true }); const path = o.data.url.replace(/^https?:\/\/[^/]+/, ''); const sup = new HostClient(S.port, T.c.host); await sup.get(path);
    assert.equal((await sup.post('/api/customers', { name: 'by support', phone: '70 800 800' })).status, 200);
    S.db.withTenant(T.id, () => S.db.run("UPDATE sessions SET expires_at=? WHERE id IN (SELECT session_id FROM session_flags)", new Date(Date.now() - 1000).toISOString())); assert.equal((await sup.get('/api/customers')).status, 401);
  });
  test('an expired token is refused', async () => {
    const o = await ops('POST', '/impersonate'); const path = o.data.url.replace(/^https?:\/\/[^/]+/, ''); S.control.cRun("UPDATE tokens SET expires_at=? WHERE kind='impersonate'", new Date(Date.now() - 1000).toISOString());
    assert.equal((await new HostClient(S.port, T.c.host).get(path)).status, 403);
  });
  test('soft delete -> 410 -> restore (read-only) -> purge needs the exact address and removes the files', async () => {
    const X = await makeTenant(S); const xo = (m, p, b) => adm.req(m, `/api/admin/tenants/${X.id}${p}`, b);
    assert.equal((await xo('DELETE', '')).status, 200); assert.equal((await X.c.get('/api/auth/status')).status, 410); assert.ok(fs.existsSync(S.db.tenantFile(X.id)));
    assert.equal((await xo('POST', '/restore')).status, 200); assert.equal((await X.c.ok('GET', '/api/auth/status')).workspace.state, 'suspended');
    assert.equal((await xo('POST', '/purge', { confirm: X.sub })).status, 400, 'must be soft-deleted first'); await xo('DELETE', '');
    assert.equal((await xo('POST', '/purge', { confirm: 'wrong' })).status, 400); assert.equal((await xo('POST', '/purge', { confirm: X.sub })).status, 200);
    assert.ok(!fs.existsSync(S.db.tenantFile(X.id))); assert.equal((await X.c.get('/api/auth/status')).status, 404);
  });
});

describe('platform metrics, plans and operations', () => {
  test('metrics: MRR counts only paying tenants, signups and trials are tracked', async () => {
    const P = await makeTenant(S); S.control.cRun("UPDATE tenants SET status='active', plan_id=(SELECT id FROM plans WHERE code='growth'), paid_through=? WHERE id=?", new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10), P.id);
    const m = await adm.ok('GET', '/api/admin/metrics'); assert.ok(m.paying >= 1); assert.ok(m.mrr_cents >= 4900); assert.ok(m.signups_7d >= 3); assert.equal(typeof m.churn_30d_pct, 'number'); assert.ok(m.by_status.trialing >= 1);
  });
  test('prices and limits are data, editable without code, and the public pricing endpoint follows', async () => {
    const plans = await adm.ok('GET', '/api/admin/plans'); const g = plans.find((p) => p.code === 'growth'); assert.equal(g.price_monthly, 4900);
    const u = await adm.ok('PUT', `/api/admin/plans/${g.id}`, { price_monthly: 5900, limits: { users: 8 } }); assert.equal(u.price_monthly, 5900); assert.equal(u.limits.users, 8); assert.equal(u.limits.orders_month, 2000);
    assert.equal((await new HostClient(S.port, DOMAIN).ok('GET', '/api/platform/plans')).find((p) => p.code === 'growth').price_monthly, 5900);
    assert.equal((await adm.put(`/api/admin/plans/${g.id}`, { limits: { users: -1 } })).status, 400); await adm.ok('PUT', `/api/admin/plans/${g.id}`, { price_monthly: 4900, limits: { users: 5 } });
  });
  test('/metrics requires the admin session or the bearer token and exposes platform gauges', async () => {
    const anon = new HostClient(S.port, `admin.${DOMAIN}`); assert.equal((await anon.get('/metrics')).status, 401); process.env.METRICS_TOKEN = 'm-token';
    assert.equal((await anon.get('/metrics', { Authorization: 'Bearer wrong' })).status, 401); const ok = await anon.get('/metrics', { Authorization: 'Bearer m-token' }); assert.equal(ok.status, 200); assert.match(ok.data, /bizcontrol_tenants\{status="trialing"\}/); assert.match(ok.data, /bizcontrol_mrr_cents/);
    assert.equal((await new HostClient(S.port, T.c.host).get('/metrics')).status, 404); delete process.env.METRICS_TOKEN;
  });
  test('tenant stats are collected by a job, not computed on demand', async () => {
    await T.c.ok('POST', '/api/customers', { name: 'stat', phone: '70 321 321' }); const n = S.admin.refreshTenantStats(); assert.ok(n >= 1);
    const row = (await adm.ok('GET', `/api/admin/tenants/${T.id}`)).tenant; assert.ok(row.db_bytes > 10000); assert.ok(row.last_activity_at); assert.equal(typeof row.order_count, 'number');
  });
  test('health endpoints work on any host; readiness checks the control plane', async () => {
    for (const host of [DOMAIN, '127.0.0.1', 'whatever.example']) { assert.equal((await new HostClient(S.port, host).get('/healthz')).status, 200); const r = await new HostClient(S.port, host).get('/readyz'); assert.equal(r.status, 200); assert.equal(r.data.control, true); }
  });
});
