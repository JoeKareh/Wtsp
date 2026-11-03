import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootSaas, HostClient, makeTenant, lastEmail, tokenFrom, DOMAIN, uniq } from './saas-helpers.js';

let S; let platform;
before(async () => { S = await bootSaas({ TENANT_POOL_MAX: '4' }); platform = new HostClient(S.port, DOMAIN); });
after(async () => { await S?.close(); });
const signupBody = (o = {}) => { const s = ('x' + uniq()).toLowerCase().slice(0, 20); return { business_name: 'Acme', owner_name: 'Ann', email: `${s}@example.com`, password: 'correct-horse-9', country: 'LB', currency: 'USD', language: 'en', subdomain: s, ...o }; };

describe('signup, verification, abuse protection', () => {
  test('subdomain rules: format, length, reserved words and duplicates are enforced', async () => {
    S.rate.resetLimits();
    for (const sub of ['ab', 'a'.repeat(31), 'Has Space', 'under_score', '-lead', 'trail-', 'dou--ble', 'www', 'admin', 'api', 'billing', 'mail', 'status', 'support', 'app', 'xn--abc', '../etc']) assert.equal((await platform.post('/api/platform/signup', signupBody({ subdomain: sub }))).status, 400, sub);
    const ok = signupBody(); assert.equal((await platform.post('/api/platform/signup', ok)).status, 200);
    S.rate.resetLimits(); assert.equal((await platform.post('/api/platform/signup', signupBody({ subdomain: ok.subdomain }))).status, 409, 'taken');
    assert.equal((await platform.get(`/api/platform/subdomain-check?name=${ok.subdomain}`)).data.available, false);
    assert.equal((await platform.get('/api/platform/subdomain-check?name=freshname1')).data.available, true);
  });
  test('weak passwords, disposable emails, bad country/currency and junk input are rejected', async () => {
    S.rate.resetLimits();
    for (const o of [{ password: 'short' }, { password: 'password1234' }, { email: 'x@mailinator.com' }, { email: 'notanemail' }, { country: 'ZZ' }, { currency: 'XXX' }, { business_name: '' }, { owner_name: 'A' }]) assert.equal((await platform.post('/api/platform/signup', signupBody(o))).status, 400, JSON.stringify(o));
    assert.equal((await platform.req('POST', '/api/platform/signup', '[]')).status, 400);
  });
  test('sign-ups are rate limited: typos are forgiven, mass creation is not', async () => {
    S.rate.resetLimits();
    for (let i = 0; i < 10; i++) assert.equal((await platform.post('/api/platform/signup', signupBody({ email: 'bad' }))).status, 400, 'invalid attempts are not blocked early');
    S.rate.resetLimits(); const r = []; for (let i = 0; i < 7; i++) r.push((await platform.post('/api/platform/signup', signupBody())).status);
    assert.deepEqual(r.slice(0, 5), [200, 200, 200, 200, 200]); assert.equal(r[5], 429); S.rate.resetLimits();
  });
  test('a workspace is unusable until the email is verified; verification starts a 14-day trial', async () => {
    const t = await makeTenant(S, { verify: false });
    const login = await t.c.post('/api/auth/login', { email: t.email, password: t.password }); assert.equal(login.status, 403); assert.equal(login.data.details.code, 'verify_email');
    assert.equal((await t.c.get('/api/orders')).status, 403, 'every API call is blocked, not just login');
    assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.state, 'pending_verification', 'but the status check works so the app can explain');
    assert.equal((await t.platform.post('/api/platform/verify', { token: 'f'.repeat(64) })).status, 400);
    const tok = tokenFrom(lastEmail(S, t.email, 'verify'));
    const v = await t.platform.ok('POST', '/api/platform/verify', { token: tok }); assert.match(v.tenant_url, new RegExp(t.sub));
    assert.equal((await t.platform.post('/api/platform/verify', { token: tok })).status, 400, 'single use');
    await t.c.ok('POST', '/api/auth/login', { email: t.email, password: t.password });
    const st = await t.c.ok('GET', '/api/auth/status'); assert.equal(st.workspace.state, 'trialing'); assert.ok(st.workspace.trial_days_left >= 13); assert.equal(st.workspace.plan.code, 'growth'); assert.ok(lastEmail(S, t.email, 'welcome'));
  });
  test('signup flow never exposes whether an email exists; discovery answers by email only', async () => {
    const t = await makeTenant(S); S.rate.resetLimits();
    const a = await platform.post('/api/platform/discover', { email: t.email }); const b = await platform.post('/api/platform/discover', { email: 'nobody@example.com' }); assert.deepEqual(a.data, b.data);
    const mail = lastEmail(S, t.email, 'discover'); assert.match(mail.text, new RegExp(t.sub)); assert.equal(lastEmail(S, 'nobody@example.com'), undefined);
    assert.equal((await platform.post('/api/platform/find', { subdomain: t.sub })).data.found, true); assert.equal((await platform.post('/api/platform/find', { subdomain: 'does-not-exist' })).data.found, false);
  });
  test('one free trial per email: a second workspace needs a plan (read-only until then)', async () => {
    const t1 = await makeTenant(S); S.rate.resetLimits(); const s2 = ('y' + uniq()).toLowerCase().slice(0, 20);
    await platform.ok('POST', '/api/platform/signup', signupBody({ email: t1.email, subdomain: s2 })); await platform.ok('POST', '/api/platform/verify', { token: tokenFrom(lastEmail(S, t1.email, 'verify')) });
    const c2 = new HostClient(S.port, `${s2}.${DOMAIN}`); await c2.ok('POST', '/api/auth/login', { email: t1.email, password: 'correct-horse-9' });
    assert.equal((await c2.ok('GET', '/api/auth/status')).workspace.state, 'suspended'); assert.equal((await c2.post('/api/customers', { name: 'X', phone: '70 123 123' })).status, 402);
  });
  test('Turnstile hook: when configured a missing or invalid token is refused', async () => {
    process.env.TURNSTILE_SECRET = 's'; S.rate.resetLimits();
    const fake = (await import('node:http')).createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => r.end(JSON.stringify({ success: new URLSearchParams(b).get('response') === 'good' }))); });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r)); process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${fake.address().port}`;
    try { assert.equal((await platform.post('/api/platform/signup', signupBody())).status, 400); assert.equal((await platform.post('/api/platform/signup', signupBody({ turnstile_token: 'bad' }))).status, 400); assert.equal((await platform.post('/api/platform/signup', signupBody({ turnstile_token: 'good' }))).status, 200); }
    finally { delete process.env.TURNSTILE_SECRET; delete process.env.TURNSTILE_VERIFY_URL; fake.close(); }
  });
});

describe('tenant provisioning & storage', () => {
  test('each tenant gets its own SQLite file; settings come from the signup country', async () => {
    const t = await makeTenant(S, { country: 'LB', currency: 'USD', language: 'ar' });
    assert.ok(fs.existsSync(S.db.tenantFile(t.id))); assert.match(S.db.tenantFile(t.id), /t_[a-f0-9]{16}\.sqlite$/);
    const b = await t.c.ok('GET', '/api/bootstrap'); assert.equal(b.settings.base_currency, 'USD'); assert.equal(b.settings.default_country_code, '961'); assert.equal(b.settings.timezone, 'Asia/Beirut');
    const tpl = await t.c.ok('GET', '/api/whatsapp/templates'); assert.ok(tpl.length >= 11 && tpl.every((x) => x.language === 'ar'), 'Arabic templates seeded for an Arabic workspace');
    const u = await t.c.ok('GET', '/api/users'); assert.equal(u.length, 1); assert.equal(u[0].role, 'OWNER');
  });
  test('tenant file names cannot be influenced by user input', () => {
    for (const bad of ['../x', 't_../../a', 'default', 'T_0000000000000000', 't_xyz', '']) assert.throws(() => S.db.tenantFile(bad), /Invalid tenant id/, bad);
  });
  test('code running outside a tenant context fails closed instead of touching any database', () => {
    assert.throws(() => S.db.all('SELECT 1'), /No tenant context/); assert.throws(() => S.db.get('SELECT 1'), /No tenant context/);
  });
  test('the connection pool is an LRU: more tenants than slots all keep working and the pool stays bounded', async () => {
    const ts = []; for (let i = 0; i < 7; i++) ts.push(await makeTenant(S));
    for (let round = 0; round < 3; round++) for (const t of ts) assert.equal((await t.c.get('/api/customers')).status, 200);
    assert.ok(S.db.poolStats().open <= 4, JSON.stringify(S.db.poolStats()));
    const a = await ts[0].c.ok('POST', '/api/customers', { name: 'Persisted', phone: '70 000 111' }); for (const t of ts.slice(1)) await t.c.get('/api/customers');   // ts[0] evicted
    assert.equal((await ts[0].c.ok('GET', `/api/customers/${a.id}`)).customer.name, 'Persisted', 'data survives eviction and reopen');
  });
  test('a failed migration disables ONLY that tenant, raises an alert, and never crashes the process', async () => {
    const good = await makeTenant(S); const bad = await makeTenant(S);
    S.db.closeTenant(bad.id);
    const { DatabaseSync } = await import('node:sqlite'); const raw = new DatabaseSync(S.db.tenantFile(bad.id));
    raw.exec('DELETE FROM schema_migrations WHERE version=3; DROP TABLE customer_events; DROP TABLE usage_counters; DROP TABLE session_flags; CREATE TABLE customer_events (x)'); raw.close();   // migration 3 will now collide with an existing table
    const r = await bad.c.get('/api/auth/status'); assert.equal(r.status, 503); assert.match(r.data.error, /temporarily unavailable/);
    assert.equal((await good.c.get('/api/customers')).status, 200, 'other tenants unaffected'); assert.equal((await platform.get('/api/platform/plans')).status, 200, 'platform unaffected');
    assert.match(S.control.cGet('SELECT disabled_reason FROM tenants WHERE id=?', bad.id).disabled_reason, /migration failed/);
    assert.deepEqual(S.db.poolStats().failed, [bad.id]); S.db.clearTenantFailure(bad.id);
  });
});

describe('lifecycle states', () => {
  const setT = (id, fields) => { const k = Object.keys(fields); S.control.cRun(`UPDATE tenants SET ${k.map((x) => x + '=?').join(',')} WHERE id=?`, ...k.map((x) => fields[x]), id); };
  const iso = (d) => new Date(Date.now() + d * 864e5).toISOString();
  test('trialing and active workspaces are fully writable', async () => {
    const t = await makeTenant(S); assert.equal((await t.c.post('/api/customers', { name: 'A', phone: '70 100 100' })).status, 200);
    setT(t.id, { status: 'active', paid_through: iso(10).slice(0, 10) }); assert.equal((await t.c.post('/api/customers', { name: 'B', phone: '70 100 101' })).status, 200);
  });
  test('trial end is enforced lazily, even if the nightly job never ran', async () => {
    const t = await makeTenant(S); setT(t.id, { trial_ends_at: iso(-1) });
    assert.equal((await t.c.post('/api/customers', { name: 'A', phone: '70 100 100' })).status, 402); assert.equal((await t.c.get('/api/customers')).status, 200);
    assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.state, 'suspended');
  });
  test('past_due keeps working during the 7-day grace, then becomes read-only', async () => {
    const t = await makeTenant(S); setT(t.id, { status: 'past_due', grace_ends_at: iso(3) });
    assert.equal((await t.c.post('/api/customers', { name: 'A', phone: '70 100 100' })).status, 200); assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.banner.type, 'past_due');
    setT(t.id, { grace_ends_at: iso(-1) }); assert.equal((await t.c.post('/api/customers', { name: 'B', phone: '70 100 101' })).status, 402);
  });
  test('a manually-paid workspace lapses automatically when the paid-through date passes', async () => {
    const t = await makeTenant(S); setT(t.id, { status: 'active', paid_through: iso(-2).slice(0, 10) });
    assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.state, 'past_due'); assert.equal((await t.c.post('/api/customers', { name: 'A', phone: '70 100 100' })).status, 200);
    setT(t.id, { paid_through: iso(-9).slice(0, 10) }); assert.equal((await t.c.ok('GET', '/api/auth/status')).workspace.state, 'suspended');
  });
  test('suspended and canceled are read-only: login, reading, exporting and billing keep working; data is never lost', async () => {
    const t = await makeTenant(S); const cu = await t.c.ok('POST', '/api/customers', { name: 'Keep', phone: '70 100 100' });
    for (const st of ['suspended', 'canceled']) {
      setT(t.id, { status: st, trial_ends_at: iso(-3), delete_after: iso(30) }); const c2 = new HostClient(S.port, t.c.host); await c2.ok('POST', '/api/auth/login', { email: t.email, password: t.password });
      assert.equal((await c2.get(`/api/customers/${cu.id}`)).status, 200, st); assert.equal((await c2.get('/api/reports/orders?format=csv&range=this_year')).status, 200, 'export allowed');
      for (const [m, u] of [['post', '/api/customers'], ['post', '/api/orders'], ['post', '/api/payments'], ['post', '/api/products'], ['put', '/api/settings']]) { const r = await c2[m](u, {}); assert.equal(r.status, 402, `${st} ${u}`); assert.equal(r.data.details.code, 'read_only'); }
    }
  });
  test('deleted workspaces answer 410 and cannot be reached; the unknown ones 404', async () => {
    const t = await makeTenant(S); setT(t.id, { status: 'deleted' });
    assert.equal((await t.c.get('/api/auth/status')).status, 410); assert.equal((await new HostClient(S.port, `nosuch.${DOMAIN}`).get('/api/auth/status')).status, 404);
  });
  test('runLifecycle: trial reminders, expiry, grace, suspension, deletion warnings, soft delete, purge: all idempotent', async () => {
    const mk = async () => makeTenant(S); const trial = await mk();
    setT(trial.id, { trial_ends_at: iso(7) });   // day 7 of 14
    S.lifecycle.runLifecycle(); S.lifecycle.runLifecycle();
    const cnt = (to, kind) => S.control.cGet('SELECT COUNT(*) c FROM platform_outbox WHERE to_addr=? AND kind=?', to, kind).c;
    assert.equal(cnt(trial.email, 'trial_reminder'), 1, 'day-7 reminder sent exactly once');
    setT(trial.id, { trial_ends_at: iso(-1) }); const r = S.lifecycle.runLifecycle(); assert.ok(r.suspended >= 1);
    assert.equal(S.control.cGet('SELECT status FROM tenants WHERE id=?', trial.id).status, 'suspended'); assert.ok(cnt(trial.email, 'suspended') >= 1);
    const paid = await mk(); setT(paid.id, { status: 'active', paid_through: iso(6).slice(0, 10) }); S.lifecycle.runLifecycle(); S.lifecycle.runLifecycle();
    assert.equal(cnt(paid.email, 'renewal_reminder'), 1, 'renewal reminder once'); setT(paid.id, { paid_through: iso(-1).slice(0, 10) }); S.lifecycle.runLifecycle();
    assert.equal(S.control.cGet('SELECT status FROM tenants WHERE id=?', paid.id).status, 'past_due'); assert.ok(cnt(paid.email, 'payment_failed') >= 1);
    setT(paid.id, { grace_ends_at: iso(-1) }); S.lifecycle.runLifecycle(); assert.equal(S.control.cGet('SELECT status FROM tenants WHERE id=?', paid.id).status, 'suspended');
    const canc = await mk(); setT(canc.id, { status: 'canceled', canceled_at: iso(-47), delete_after: iso(13) }); S.lifecycle.runLifecycle(); S.lifecycle.runLifecycle(); assert.equal(cnt(canc.email, 'deletion_warning'), 1);
    setT(canc.id, { delete_after: iso(2) }); S.lifecycle.runLifecycle(); assert.equal(cnt(canc.email, 'deletion_warning'), 2, 'second warning');
    setT(canc.id, { delete_after: iso(-1) }); S.lifecycle.runLifecycle(); const row = S.control.cGet('SELECT * FROM tenants WHERE id=?', canc.id); assert.equal(row.status, 'deleted'); assert.ok(row.purge_after);
    assert.ok(fs.existsSync(S.db.tenantFile(canc.id)), 'soft delete keeps the data');
    setT(canc.id, { purge_after: iso(-1) }); const p = S.lifecycle.runLifecycle(); assert.ok(p.purged >= 1); assert.ok(!fs.existsSync(S.db.tenantFile(canc.id)), 'purge removes the file'); assert.ok(S.control.cGet('SELECT purged_at FROM tenants WHERE id=?', canc.id).purged_at);
  });
});
