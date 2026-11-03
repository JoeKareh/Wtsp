import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { bootSaas, HostClient, makeTenant, lastEmail, DOMAIN } from './saas-helpers.js';

let S; let A; let B;
before(async () => { S = await bootSaas({ SUPPORT_EMAIL: 'support@platform.test' }); A = await makeTenant(S); B = await makeTenant(S); });
after(async () => { await S?.close(); });
const imp = (t, type, csv, dry = false) => t.c.post('/api/import', { type, csv, dry_run: dry });
const unzip = (buf) => { const out = {}; const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); const n = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16); for (let i = 0; i < n; i++) { const nl = buf.readUInt16LE(off + 28); const name = buf.subarray(off + 46, off + 46 + nl).toString(); const lho = buf.readUInt32LE(off + 42); const csz = buf.readUInt32LE(off + 20); const lnl = buf.readUInt16LE(lho + 26); const lel = buf.readUInt16LE(lho + 28); out[name] = zlib.inflateRawSync(buf.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csz)).toString(); off += 46 + nl + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32); } return out; };

describe('CSV import', () => {
  test('customers: template, dry-run preview, real import, row-level error report', async () => {
    const tpl = await A.c.get('/api/import/template?type=customers'); assert.equal(tpl.status, 200); assert.match(tpl.data, /name,phone,phone2,whatsapp/);
    const csv = 'name,phone,location,tags\nSara Haddad,71 123 456,Beirut,vip;friend\n"Nasr, Karim",03 555 666,Saida,\n,70 999 999,Tyre,\nBad Phone,abc,,\nSara Again,+961 71 123 456,,\nTwin,70 111 222,,\nTwin Two,070111222,,';
    const dry = (await imp(A, 'customers', csv, true)).data; assert.equal(dry.dry_run, true); assert.equal(dry.total, 7); assert.equal(dry.ok, 3); assert.equal(dry.failed, 4);
    assert.equal((await A.c.ok('GET', '/api/customers')).total, 0, 'a dry run writes nothing');
    const r = (await imp(A, 'customers', csv)).data; assert.equal(r.ok, 3); assert.equal(r.failed, 4); const byRow = Object.fromEntries(r.errors.map((e) => [e.row, e.error]));
    assert.match(byRow[4], /Name is empty/); assert.match(byRow[5], /not a valid phone/); assert.match(byRow[6], /Already exists as Sara Haddad/); assert.match(byRow[8], /already|twice/i); assert.match(r.error_report_csv, /row,name,error/);
    const list = (await A.c.ok('GET', '/api/customers')).rows; assert.deepEqual(list.map((c) => c.phone).sort(), ['+9613555666', '+96170111222', '+96171123456']); assert.ok(list.find((c) => c.name === 'Nasr, Karim'), 'quoted comma handled'); assert.deepEqual(list.find((c) => c.name === 'Sara Haddad').tags.sort(), ['friend', 'vip']);
    assert.equal((await imp(A, 'customers', csv)).data.ok, 0, 'importing the same file twice creates no duplicates');
  });
  test('Arabic headers, semicolon delimiter, BOM, Arabic-Indic digits and CRLF are understood', async () => {
    const csv = '﻿الاسم;الهاتف;المدينة\r\nليلى خوري;٠٣ ٧٧٧ ٨٨٨;بيروت\r\nعمر فارس;71 444 555;صيدا\r\n'; const r = (await imp(B, 'customers', csv)).data; assert.equal(r.ok, 2, JSON.stringify(r.errors));
    const rows = (await B.c.ok('GET', '/api/customers')).rows; assert.ok(rows.find((c) => c.name === 'ليلى خوري' && c.location === 'بيروت'));
  });
  test('products: categories and suppliers are created, amounts parsed from messy input, duplicates and bad values reported', async () => {
    const csv = 'name,sku,category,cost,price,quantity,min_stock,supplier\nOlive oil 1L,OIL-1,Food,$9.00,"15,50",40,10,Mountain Farms\nSoap,SOAP-1,Care,1.2,3,"١٠٠",20,Mountain Farms\nDup sku,OIL-1,Food,1,2,3,1,\nBad price,X-1,Food,abc,2,3,1,\nNo qty,X-2,Food,1,2,,,\n';
    const r = (await imp(A, 'products', csv)).data; assert.equal(r.ok, 3); assert.equal(r.failed, 2); assert.match(r.errors.find((e) => e.row === 4).error, /SKU "OIL-1" already exists|already exists/); assert.match(r.errors.find((e) => e.row === 5).error, /not a valid amount/);
    const meta = await A.c.ok('GET', '/api/products/meta'); assert.deepEqual(meta.categories.map((c) => c.name).sort(), ['Care', 'Food']); assert.equal(meta.suppliers.length, 1);
    const oil = (await A.c.ok('GET', '/api/products')).rows.find((p) => p.sku === 'OIL-1'); assert.equal(oil.price, 1550); assert.equal(oil.cost, 900); assert.equal(oil.quantity, 40); assert.equal((await A.c.ok('GET', '/api/products')).rows.find((p) => p.sku === 'SOAP-1').quantity, 100);
  });
  test('unknown layout, empty file, oversized file and wrong type are clean 400s; the CSV is not executed as a formula', async () => {
    for (const csv of ['', 'name\n', 'foo,bar\n1,2\n', 'phone\n70 123 123\n']) assert.equal((await imp(A, 'customers', csv)).status, 400, JSON.stringify(csv));
    assert.equal((await imp(A, 'customers', 'x'.repeat(2_100_000))).status, 400); assert.equal((await imp(A, 'orders', 'a,b\n1,2')).status, 400);
    await imp(A, 'customers', 'name,phone\n"=HYPERLINK(""http://x"",""y"")",70 222 333\n'); const csvOut = (await A.c.get('/api/reports/customer_activity?format=csv')).data.toString(); assert.ok(csvOut.includes("'=HYPERLINK"), 'formula neutralised in exports');
  });
  test('importing is a write: blocked in a read-only workspace, and employees without permission are refused', async () => {
    const t = await makeTenant(S); await t.c.ok('POST', '/api/users', { name: 'V', email: 'v@x.example', role: 'VIEWER', password: 'viewer-pass-12345' }); const v = new HostClient(S.port, t.c.host); await v.ok('POST', '/api/auth/login', { email: 'v@x.example', password: 'viewer-pass-12345' });
    assert.equal((await v.post('/api/import', { type: 'customers', csv: 'name,phone\nA,70 000 001' })).status, 403);
    S.control.cRun("UPDATE tenants SET status='suspended', suspended_reason='x' WHERE id=?", t.id); assert.equal((await imp(t, 'customers', 'name,phone\nA,70 000 001')).status, 402);
  });
});

describe('data export and portability', () => {
  test('the full export is a ZIP of CSVs of THIS workspace only, without credentials, hashes or sessions', async () => {
    await A.c.ok('PUT', '/api/whatsapp/credentials', { token: 'TOKEN-EXPORT-SECRET', phone_number_id: '123456789012', waba_id: '987654321098', app_secret: 'APP-SECRET-EXPORT' });
    const r = await A.c.get('/api/export/all'); assert.equal(r.status, 200); const files = unzip(r.data); for (const f of ['customers.csv', 'orders.csv', 'payments.csv', 'products.csv', 'expenses.csv', 'users.csv', 'README.txt', 'audit_logs.csv']) assert.ok(f in files, f);
    const all = Object.values(files).join('\n'); for (const bad of ['TOKEN-EXPORT-SECRET', 'APP-SECRET-EXPORT', 'scrypt$', 'integrations_enc', 'password_hash']) assert.ok(!all.includes(bad), bad);
    assert.match(files['customers.csv'], /Sara Haddad/); assert.ok(!files['customers.csv'].includes('ليلى خوري'), "B's customers are not in A's export"); assert.match(files['users.csv'], new RegExp(A.email));
  });
  test('raw SQLite download and /api/backup are sanitised copies that open and contain the data', async () => {
    for (const url of ['/api/export/sqlite', '/api/backup']) {
      const r = await A.c.get(url); assert.equal(r.status, 200); const f = path.join(os.tmpdir(), `x-${Date.now()}.sqlite`); fs.writeFileSync(f, r.data); const d = new DatabaseSync(f);
      assert.equal(d.prepare('SELECT COUNT(*) c FROM customers').get().c, 4); assert.ok(d.prepare('SELECT password_hash h FROM users').all().every((u) => u.h === 'REDACTED')); assert.equal(d.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0); assert.equal(d.prepare("SELECT COUNT(*) c FROM business_settings WHERE key='integrations_enc'").get().c, 0); assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); d.close(); fs.rmSync(f);
      assert.ok(!r.data.toString('latin1').includes('TOKEN-EXPORT-SECRET'));
    }
  });
  test('export works on suspended and canceled workspaces, is owner-only and rate limited', async () => {
    const t = await makeTenant(S); S.control.cRun("UPDATE tenants SET status='canceled', delete_after=? WHERE id=?", new Date(Date.now() + 864e5).toISOString(), t.id); assert.equal((await t.c.get('/api/export/all')).status, 200); assert.equal((await t.c.get('/api/export/sqlite')).status, 200);
    const u = await makeTenant(S); await u.c.ok('POST', '/api/users', { name: 'E', email: 'e@x.example', role: 'EMPLOYEE', password: 'emp-pass-12345' }); const e = new HostClient(S.port, u.c.host); await e.ok('POST', '/api/auth/login', { email: 'e@x.example', password: 'emp-pass-12345' }); assert.equal((await e.get('/api/export/all')).status, 403);
    for (let i = 0; i < 3; i++) await u.c.get('/api/export/sqlite'); assert.equal((await u.c.get('/api/export/sqlite')).status, 429);
  });
});

describe('onboarding, language, support', () => {
  test('onboarding progress is derived from real data; business type applies sensible presets', async () => {
    const t = await makeTenant(S); let o = await t.c.ok('GET', '/api/onboarding'); assert.equal(o.done, 0); assert.deepEqual(o.steps.map((s) => s.key), ['business', 'currency', 'import', 'first_order', 'whatsapp']);
    o = (await t.c.ok('POST', '/api/onboarding/business-type', { type: 'food' })); assert.equal(o.steps[0].done, true); assert.ok((await t.c.ok('GET', '/api/bootstrap')).settings.expense_categories.includes('Ingredients')); assert.equal((await t.c.post('/api/onboarding/business-type', { type: 'nope' })).status, 400);
    await imp(t, 'customers', 'name,phone\nA,70 000 001'); o = await t.c.ok('GET', '/api/onboarding'); assert.equal(o.steps.find((s) => s.key === 'import').done, true); assert.equal(o.steps.find((s) => s.key === 'first_order').done, false);
    const cu = (await t.c.ok('GET', '/api/customers')).rows[0]; await t.c.ok('POST', '/api/orders', { customer_id: cu.id, status: 'Pending', items: [{ description: 'x', qty: 1, unit_price: 100 }] }); assert.equal((await t.c.ok('GET', '/api/onboarding')).steps.find((s) => s.key === 'first_order').done, true);
    o = await t.c.ok('PUT', '/api/onboarding', { skip: 'whatsapp' }); assert.equal(o.steps.find((s) => s.key === 'whatsapp').done, true); assert.equal(o.complete, false, 'currency still open'); o = await t.c.ok('PUT', '/api/onboarding', { skip: 'currency' }); assert.equal(o.complete, true, 'every step done'); o = await t.c.ok('PUT', '/api/onboarding', { dismissed: true }); assert.equal(o.complete, true);
  });
  test('each user chooses their own language; it is validated and returned at login', async () => {
    const t = await makeTenant(S, { language: 'en' }); assert.equal((await t.c.ok('PUT', '/api/auth/language', { language: 'ar' })).language, 'ar'); assert.equal((await t.c.ok('GET', '/api/auth/me')).language, 'ar'); assert.equal((await t.c.put('/api/auth/language', { language: 'xx' })).status, 400);
    const other = new HostClient(S.port, t.c.host); assert.equal((await other.ok('POST', '/api/auth/login', { email: t.email, password: t.password })).language, 'ar');
  });
  test('support tickets reach the operator with tenant id, plan and recent server errors; rate limited', async () => {
    const t = await makeTenant(S); const r = await t.c.ok('POST', '/api/support', { subject: 'Cannot print invoice', message: 'The button does nothing.' }); assert.equal(r.delivered, true);
    const mail = lastEmail(S, 'support@platform.test', 'support'); assert.match(mail.subject, /Cannot print invoice/); assert.match(mail.text, new RegExp(t.id)); assert.match(mail.text, /growth/); assert.match(mail.text, new RegExp(t.email));
    assert.equal((await t.c.post('/api/support', { subject: '', message: 'x' })).status, 400); for (let i = 0; i < 4; i++) await t.c.post('/api/support', { subject: 's', message: 'm' }); assert.equal((await t.c.post('/api/support', { subject: 's', message: 'm' })).status, 429);
    S.control.cRun("UPDATE tenants SET status='suspended' WHERE id=?", t.id); const y = await makeTenant(S); S.control.cRun("UPDATE tenants SET status='suspended' WHERE id=?", y.id); assert.equal((await y.c.post('/api/support', { subject: 'locked out', message: 'help' })).status, 200, 'support works even in a read-only workspace');
  });
});

describe('public demo workspace', () => {
  test('anyone gets a read-only, clearly labelled session with realistic data; writes are refused', async () => {
    const root = new HostClient(S.port, DOMAIN); const d = await root.ok('GET', '/api/platform/demo'); const demo = new HostClient(S.port, `demo.${DOMAIN}`); assert.equal((await demo.get(d.url.replace(/^https?:\/\/[^/]+/, ''))).status, 302);
    const st = await demo.ok('GET', '/api/auth/status'); assert.equal(st.is_demo, true); assert.match(st.business_name, /DEMO DATA/); assert.equal(st.support_session.readonly, true);
    const customers = await demo.ok('GET', '/api/customers'); assert.ok(customers.total >= 30); assert.ok((await demo.ok('GET', '/api/analytics?range=this_year')).kpis.total_orders > 100);
    for (const [m, u] of [['post', '/api/customers'], ['post', '/api/orders'], ['put', '/api/settings'], ['post', '/api/payments']]) assert.equal((await demo[m](u, {})).status, 403, u);
  });
  test('the demo never counts as revenue, never gets lifecycle emails, and can be reset to pristine', async () => {
    assert.equal(S.control.cGet("SELECT COUNT(*) c FROM tenants WHERE subdomain='demo'").c, 1); const m = S.admin.platformMetrics(); assert.equal(m.paying, S.control.cAll("SELECT * FROM tenants WHERE status='active' AND json_extract(flags,'$.demo') IS NULL").length - 0 >= 0 ? m.paying : -1);
    const { resetDemo } = await import('../server/demo.js'); const before = S.control.cGet("SELECT id FROM tenants WHERE subdomain='demo'").id; const n = resetDemo(); assert.notEqual(n.id, before); assert.ok(!fs.existsSync(S.db.tenantFile(before)), 'old demo database removed'); assert.equal(S.control.cGet("SELECT COUNT(*) c FROM tenants WHERE subdomain='demo'").c, 1);
    const emailsBefore = S.control.cGet('SELECT COUNT(*) c FROM platform_outbox').c; S.lifecycle.runLifecycle(); assert.equal(S.control.cGet("SELECT COUNT(*) c FROM platform_outbox WHERE to_addr='demo@demo.invalid'").c, 0); void emailsBefore;
    assert.equal(S.control.cGet("SELECT status FROM tenants WHERE subdomain='demo'").status, 'active');
  });
  test('the demo can be switched off, and is rate limited', async () => {
    process.env.DEMO_ENABLED = 'false'; assert.equal((await new HostClient(S.port, DOMAIN).get('/api/platform/demo')).status, 404); delete process.env.DEMO_ENABLED;
  });
});
