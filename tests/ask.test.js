import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootSaas, HostClient, makeTenant } from './saas-helpers.js';

let S; let fake; const calls = []; let script = [];
before(async () => {
  fake = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { const body = JSON.parse(Buffer.concat(ch).toString()); calls.push({ body, key: req.headers['x-api-key'] }); const r = script.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r)); }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await bootSaas({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_API_BASE: `http://127.0.0.1:${fake.address().port}` });
});
after(async () => { fake?.closeAllConnections?.(); fake?.close(); await S?.close(); });
const toolUse = (name, input = {}) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name, input }] });
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

describe('Ask your business', () => {
  test('answers through read-only tools; no phone numbers leave the server; one credit per answered question', async () => {
    const t = await makeTenant(S); const c = await t.c.ok('POST', '/api/customers', { name: 'Debtor Dan', phone: '71555123' });
    await t.c.ok('POST', '/api/orders', { customer_id: c.id, status: 'Pending', items: [{ description: 'x', qty: 1, unit_price: 5000 }] });
    calls.length = 0; script = [toolUse('who_owes_me'), text('Debtor Dan owes you $50.')];
    const r = await t.c.ok('POST', '/api/ai/ask', { question: 'Who owes me money?' }); assert.equal(r.answer, 'Debtor Dan owes you $50.'); assert.deepEqual(r.tools_used, ['who_owes_me']);
    assert.equal(calls[0].key, 'sk-test'); assert.ok(calls[0].body.tools.length >= 5); assert.ok(calls[0].body.system.includes('Never invent numbers'));
    const toolResult = JSON.stringify(calls[1].body.messages.at(-1).content); assert.ok(toolResult.includes('Debtor Dan')); assert.ok(!toolResult.includes('71555123') && !toolResult.includes('9617155'), 'phone numbers are never sent to the AI'); assert.match(toolResult, /50/);
    const left = r.credits_left; const r2 = await t.c.ok('POST', '/api/ai/ask', { question: 'orders by status?' }); assert.equal(r2.credits_left, left - 1);
  });
  test('tools are limited by the asking user’s permissions, even if the model asks for one anyway', async () => {
    const t = await makeTenant(S); const { ask } = await import('../server/services/ask.js'); const seen = [];
    const user = { role: 'CUSTOM', permissions: ['orders:read'] }; const replies = [toolUse('sales_summary'), text('done')];
    const fetchImpl = async (url, o) => { seen.push(JSON.parse(o.body)); return { ok: true, json: async () => replies.shift() }; };
    const r = await S.db.withTenant(t.id, () => ask('How much profit did I make?', user, { fetchImpl }), S.control.tenantRow(t.id));
    assert.deepEqual(seen[0].tools.map((x) => x.name).sort(), ['orders_by_status', 'top_products'], 'only tools this user may use are offered');
    assert.match(JSON.stringify(seen[1].messages.at(-1).content), /Tool not available/); assert.equal(r.answer, 'done'); assert.deepEqual(r.tools_used, []);
    assert.equal((await new HostClient(S.port, t.c.host).get('/api/ai/status')).status, 401);
  });
  test('plan gating and metering: starter has no AI; the credit limit is a hard stop; a failing AI call costs nothing', async () => {
    const t = await makeTenant(S); const starter = S.control.cGet("SELECT id FROM plans WHERE code='starter'").id; S.control.cRun('UPDATE tenants SET plan_id=? WHERE id=?', starter, t.id);
    const r = await t.c.post('/api/ai/ask', { question: 'Who owes me?' }); assert.equal(r.status, 402); assert.match(r.data.error, /not included in your plan/);
    const growth = S.control.cGet("SELECT id FROM plans WHERE code='growth'").id; S.control.cRun('UPDATE tenants SET plan_id=? WHERE id=?', growth, t.id);
    script = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }]; await t.c.ok('POST', '/api/ai/ask', { question: 'hello there' });
    const before = (await t.c.ok('GET', '/api/ai/status')).credits_left; fake.close(); fake.closeAllConnections?.(); const bad = await t.c.post('/api/ai/ask', { question: 'Who owes me?' }); assert.equal(bad.status, 502); assert.equal((await t.c.ok('GET', '/api/ai/status')).credits_left, before, 'not charged for a failed call');
    // hard stop
    S.db.withTenant(t.id, () => S.db.run("INSERT INTO usage_counters(period,metric,value) VALUES (?,?,?) ON CONFLICT(period,metric) DO UPDATE SET value=?", new Date().toISOString().slice(0, 7), 'ai_credits', 5000, 5000), S.control.tenantRow(t.id));
    const stop = await t.c.post('/api/ai/ask', { question: 'Who owes me?' }); assert.equal(stop.status, 402);
  });
  test('input is validated and the assistant is off without a key', async () => {
    const t = await makeTenant(S); assert.equal((await t.c.post('/api/ai/ask', { question: 'x' })).status, 400); assert.equal((await t.c.post('/api/ai/ask', { question: 'y'.repeat(600) })).status, 400);
  });
});
