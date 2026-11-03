// Public demo workspace: a labelled, read-only copy with fictional data that resets daily.
import fs from 'node:fs';
import { GET } from './http.js';
import { cGet, cRun, cTx, paudit, tenantBySub, planByCode } from './control.js';
import { withTenant, run, get, setSettings, closeTenant, tenantFile, conn } from './db.js';
import { provisionTenant } from './platform.js';
import { randomToken, hashToken } from './crypto.js';
import { config } from './config.js';
import { allow } from './ratelimit.js';
import { HttpError } from './util.js';
import { seedDemoData } from './seed.js';

export const demoEnabled = () => config.saas && process.env.DEMO_ENABLED !== 'false';
export function ensureDemoTenant() {
  let t = tenantBySub('demo'); if (t && !t.purged_at) return t;
  const id = provisionTenant({ business_name: 'Demo Olive & Soap Co.', owner_name: 'Demo Owner', email: 'demo@demo.invalid', password: randomToken(16) + 'Aa1', country: 'LB', currency: 'USD', language: 'en', subdomain: 'demo', flags: { demo: true, trial_granted: 0 }, status: 'active' });
  const plan = planByCode('business'); cRun("UPDATE tenants SET plan_id=?, paid_through='2099-12-31', verified_at=? WHERE id=?", plan.id, new Date().toISOString(), id);
  withTenant(id, () => { const owner = get("SELECT id, name FROM users ORDER BY id LIMIT 1"); setSettings({ is_demo: true, business_name: 'Demo Olive & Soap Co. (DEMO DATA)', currencies: ['USD', 'LBP'] }); run("INSERT INTO exchange_rates(currency,rate_per_base,effective_date,note,created_at) VALUES ('LBP',89500,'2020-01-01','Demo rate',?)", new Date().toISOString()); seedDemoData({ ...owner, role: 'OWNER', permissions: ['*'] }); });
  return tenantBySub('demo');
}
/** Throw the demo away and rebuild it from scratch. */
export function resetDemo() {
  const t = tenantBySub('demo');
  if (t) { closeTenant(t.id); const f = tenantFile(t.id); for (const x of [f, f + '-wal', f + '-shm']) fs.rmSync(x, { force: true }); fs.rmSync(f.replace(/\.sqlite$/, '-files'), { recursive: true, force: true }); cTx(() => { cRun('DELETE FROM tokens WHERE tenant_id=?', t.id); cRun('DELETE FROM tenants WHERE id=?', t.id); cRun('DELETE FROM accounts WHERE id=? AND NOT EXISTS (SELECT 1 FROM tenants WHERE account_id=accounts.id)', t.account_id); }); }
  const n = ensureDemoTenant(); paudit('system', 'demo_reset', n.id); return n;
}
/** Anyone can open the demo: a one-minute token creates a READ-ONLY session (the same mechanism as support sessions). */
GET('/api/platform/demo', { perm: 'public', scope: 'platform' }, (ctx) => {
  if (!demoEnabled()) throw new HttpError(404, 'The demo is not available');
  if (!allow('demo:' + ctx.ip, 30, 3600e3)) throw new HttpError(429, 'Please try again later');
  const t = ensureDemoTenant(); const tok = randomToken(24);
  cRun('INSERT INTO tokens(token_hash,kind,tenant_id,data,expires_at) VALUES (?,?,?,?,?)', hashToken(tok), 'impersonate', t.id, JSON.stringify({ admin: 'demo visitor', readonly: true }), new Date(Date.now() + 60_000).toISOString());
  return { url: config.tenantUrl('demo', '/api/support/enter?token=' + tok) };
});
