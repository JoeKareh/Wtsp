import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootSaas, HostClient, makeTenant, DOMAIN } from './saas-helpers.js';

let S; let adm; let secret;
const code = () => S.totp.code(secret, S.totp.currentStep() + 1 + (S._n = (S._n || 0) + 1));
before(async () => {
  S = await bootSaas(); const a = S.admin.createAdmin('root@platform.test', 'Root', 'Sup3r-secret-pass'); secret = a.secret;
  adm = new HostClient(S.port, `admin.${DOMAIN}`); S.admin.resetAdminThrottle();
  await adm.ok('POST', '/api/admin/login', { email: 'root@platform.test', password: 'Sup3r-secret-pass', code: S.totp.code(secret, S.totp.currentStep()) });
});
after(async () => { await S?.close(); });
void code;

describe('one device per account', () => {
  test('a second login signs the first one out; the operator can allow more devices', async () => {
    const t = await makeTenant(S); const second = new HostClient(S.port, t.c.host);
    assert.equal((await t.c.get('/api/customers')).status, 200);
    await second.ok('POST', '/api/auth/login', { email: t.email, password: t.password });
    assert.equal((await t.c.get('/api/customers')).status, 401, 'first device is out');
    assert.equal((await second.get('/api/customers')).status, 200);
    await adm.ok('POST', `/api/admin/tenants/${t.id}/sessions`, { max_sessions: 2 }); S.db.closeAllTenants();
    const third = new HostClient(S.port, t.c.host); await third.ok('POST', '/api/auth/login', { email: t.email, password: t.password });
    assert.equal((await second.get('/api/customers')).status, 200); assert.equal((await third.get('/api/customers')).status, 200);
    const fourth = new HostClient(S.port, t.c.host); await fourth.ok('POST', '/api/auth/login', { email: t.email, password: t.password });
    assert.equal((await second.get('/api/customers')).status, 401, 'oldest is dropped'); assert.equal((await fourth.get('/api/customers')).status, 200);
  });
  test('"sign out everywhere" from the admin site', async () => {
    const t = await makeTenant(S); await adm.ok('POST', `/api/admin/tenants/${t.id}/logout-all`, {}); assert.equal((await t.c.get('/api/customers')).status, 401);
    await t.c.ok('POST', '/api/auth/login', { email: t.email, password: t.password });
  });
  test('support sessions do not kick the owner out', async () => {
    const t = await makeTenant(S); const imp = (await adm.ok('POST', `/api/admin/tenants/${t.id}/impersonate`, {})).url; const sup = new HostClient(S.port, t.c.host); await sup.get(imp.replace(/^https?:\/\/[^/]+/, ''));
    assert.equal((await t.c.get('/api/customers')).status, 200);
  });
});

describe('free passes', () => {
  test('grant free days, then unlimited; it works without any payment and shows in the tenant list', async () => {
    const t = await makeTenant(S); S.control.cRun("UPDATE tenants SET status='suspended', trial_ends_at=NULL WHERE id=?", t.id);
    assert.equal((await t.c.post('/api/customers', { name: 'X', phone: '70000001' })).status, 402);
    const g = await adm.ok('POST', `/api/admin/tenants/${t.id}/grant`, { days: 30, plan: 'business', note: 'friend' }); assert.ok(g.free_until > new Date().toISOString().slice(0, 10));
    assert.equal((await t.c.post('/api/customers', { name: 'X', phone: '70000001' })).status, 200);
    const row = (await adm.ok('GET', `/api/admin/tenants/${t.id}`)).tenant; assert.equal(row.plan, 'business'); assert.equal(row.effective_status, 'active');
    const u = await adm.ok('POST', `/api/admin/tenants/${t.id}/grant`, { unlimited: true }); assert.equal(u.free_until, '2099-12-31');
    await adm.ok('POST', `/api/admin/tenants/${t.id}/revoke-pass`, {}); assert.equal((await t.c.post('/api/customers', { name: 'Y', phone: '70000002' })).status, 402);
    assert.equal((await adm.post(`/api/admin/tenants/${t.id}/revoke-pass`, {})).status, 400);
  });
  test('pass codes: created by the operator, redeemed at signup, limited uses, can be disabled', async () => {
    const c = await adm.ok('POST', '/api/admin/passes', { code: 'FRIENDS-30', plan: 'growth', days: 30, max_uses: 2, note: 'beta' }); assert.equal(c.code, 'FRIENDS-30');
    assert.equal((await adm.post('/api/admin/passes', { code: 'friends-30', days: 5 })).status, 409);
    const t = await makeTenant(S, { verify: false, login: false }); void t;
    const platform = new HostClient(S.port, DOMAIN); S.rate.resetLimits();
    const bad = await platform.post('/api/platform/signup', { business_name: 'Pass Co', owner_name: 'Pat', email: 'pat@example.com', password: 'correct-horse-9', country: 'LB', currency: 'USD', language: 'en', subdomain: 'passco', pass: 'NOPE-1' }); assert.equal(bad.status, 400);
    await platform.ok('POST', '/api/platform/signup', { business_name: 'Pass Co', owner_name: 'Pat', email: 'pat@example.com', password: 'correct-horse-9', country: 'LB', currency: 'USD', language: 'en', subdomain: 'passco', pass: 'friends-30' });
    const { lastEmail, tokenFrom } = await import('./saas-helpers.js'); await platform.ok('POST', '/api/platform/verify', { token: tokenFrom(lastEmail(S, 'pat@example.com', 'verify')) });
    const row = S.control.cGet("SELECT * FROM tenants WHERE subdomain='passco'"); assert.equal(row.status, 'active'); assert.equal(row.trial_ends_at, null); assert.equal(JSON.parse(row.flags).comp.by, 'pass-code');
    assert.equal(S.control.cGet("SELECT used FROM passes WHERE code='FRIENDS-30'").used, 1);
    await adm.ok('DELETE', '/api/admin/passes/FRIENDS-30'); S.rate.resetLimits();
    assert.equal((await platform.post('/api/platform/signup', { business_name: 'Late', owner_name: 'Lee', email: 'lee@example.com', password: 'correct-horse-9', country: 'LB', currency: 'USD', language: 'en', subdomain: 'lateco', pass: 'FRIENDS-30' })).status, 400);
    assert.ok((await adm.ok('GET', '/api/admin/passes')).rows.length >= 1); assert.ok((await adm.ok('GET', '/api/admin/customers')).rows.length >= 3);
  });
});
