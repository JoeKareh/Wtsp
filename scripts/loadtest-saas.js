// Multi-tenant load test. Creates N workspaces, starts the real server as a child process, then hammers it with a realistic mix
// (dashboard, customer list, create customer, create order) spread across ALL workspaces. Prints honest numbers for THIS machine.
// Usage: npm run loadtest -- [--tenants 200] [--seconds 20] [--concurrency 40] [--pool 100]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('tenants', 200); const SECS = arg('seconds', 20); const CONC = arg('concurrency', 40); const POOL = arg('pool', 100);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-load-')); const DOMAIN = 'load.test'; const PORT = 3900 + Math.floor(Math.random() * 90);
Object.assign(process.env, { APP_DOMAIN: DOMAIN, DB_PATH: path.join(dir, 'x.sqlite'), CONTROL_DB_PATH: path.join(dir, 'control.sqlite'), TENANTS_DIR: path.join(dir, 'tenants'), APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), LOG_REQUESTS: 'false', TENANT_POOL_MAX: String(POOL), PORT: String(PORT), HOST: '127.0.0.1', LOG_FORMAT: 'json' });
const { control } = await import('../server/control.js'); const { provisionTenant } = await import('../server/platform.js'); const { tenantRow } = await import('../server/control.js'); const { setTenantStatus } = await import('../server/lifecycle.js'); const { closeAllTenants } = await import('../server/db.js'); const { COUNTRIES } = await import('../server/countries.js');
(await import('../server/app.js')).buildServer({ jobs: false });   // registers the workspace hooks (roles etc.); we never listen in this process
control(); const tenants = []; let t0 = Date.now();
for (let i = 0; i < N; i++) { const sub = 'shop' + i; const id = provisionTenant({ business_name: 'Shop ' + i, owner_name: 'Owner', email: `o${i}@load.test`, password: 'correct-horse-9', country: 'LB', currency: 'USD', language: 'en', subdomain: sub }); setTenantStatus(id, 'active', { verified_at: new Date().toISOString(), paid_through: '2099-12-31' }); tenants.push({ id, host: `${sub}.${DOMAIN}`, email: `o${i}@load.test`, cookie: '', customers: [] }); }
closeAllTenants(); void tenantRow; void COUNTRIES; console.log(`created ${N} workspaces in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(fs.readdirSync(path.join(dir, 'tenants')).filter((f) => f.endsWith('.sqlite')).reduce((a, f) => a + fs.statSync(path.join(dir, 'tenants', f)).size, 0) / N / 1024).toFixed(0)} KB each when empty)`);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, JOBS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
const agent = new http.Agent({ keepAlive: true, maxSockets: CONC * 2 });
const req = (t, method, url, body) => new Promise((res) => { const s = performance.now(); const p = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, agent, headers: { Host: t.host, 'X-Requested-With': 'XMLHttpRequest', ...(t.cookie ? { Cookie: t.cookie } : {}), ...(p ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) } : {}) } }, (rs) => { const ch = []; rs.on('data', (c) => ch.push(c)); rs.on('end', () => { const sc = (rs.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => /sid=/.test(c)); if (sc) t.cookie = sc; let d = null; try { d = JSON.parse(Buffer.concat(ch).toString()); } catch { /* not json */ } res({ status: rs.statusCode, ms: performance.now() - s, data: d }); }); });
  r.on('error', () => res({ status: 0, ms: performance.now() - s })); r.setTimeout(30000, () => r.destroy()); if (p) r.write(p); r.end(); });
for (let i = 0; i < 100; i++) { const r = await req(tenants[0], 'GET', '/healthz').catch(() => null); if (r?.status === 200) break; await new Promise((r2) => setTimeout(r2, 100)); }
t0 = Date.now(); let ok = 0; for (let i = 0; i < tenants.length; i += 20) await Promise.all(tenants.slice(i, i + 20).map(async (t) => { const r = await req(t, 'POST', '/api/auth/login', { email: t.email, password: 'correct-horse-9' }); if (r.status === 200) ok++; }));
console.log(`logged in to ${ok}/${N} workspaces in ${((Date.now() - t0) / 1000).toFixed(1)}s (first request to each opens its database)`);
const lat = { read: [], write: [] }; const codes = {}; let stop = false; let seq = 0;
const worker = async () => { while (!stop) { const t = tenants[Math.floor(Math.random() * tenants.length)]; const x = Math.random(); let r; let kind = 'read';
  if (x < 0.30) r = await req(t, 'GET', '/api/customers?limit=20'); else if (x < 0.55) r = await req(t, 'GET', '/api/orders?limit=20'); else if (x < 0.70) r = await req(t, 'GET', '/api/analytics?range=this_month');
  else if (x < 0.85) { kind = 'write'; r = await req(t, 'POST', '/api/customers', { name: 'C' + ++seq, phone: '7' + String(1000000 + seq).slice(-7) }); if (r.status === 200 && r.data?.id) t.customers.push(r.data.id); }
  else { kind = 'write'; const cu = t.customers[0]; if (!cu) continue; r = await req(t, 'POST', '/api/orders', { customer_id: cu, status: 'Pending', items: [{ description: 'Item', qty: 1, unit_price: 1000 }] }); }
  lat[kind].push(r.ms); codes[r.status] = (codes[r.status] || 0) + 1; } };
const rss = () => { try { return Number(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024; } catch { return NaN; } };
t0 = Date.now(); const ws = Array.from({ length: CONC }, worker); await new Promise((r) => setTimeout(r, SECS * 1000)); stop = true; await Promise.all(ws); const el = (Date.now() - t0) / 1000;
const pc = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(0) : '-'); const all = lat.read.length + lat.write.length;
console.log(`\n== ${N} workspaces, pool ${POOL}, ${CONC} concurrent users, ${SECS}s, ${os.cpus().length} CPU (${os.cpus()[0].model.trim()}) ==`);
console.log(`requests: ${all}  (${(all / el).toFixed(0)}/s)   status codes: ${JSON.stringify(codes)}`);
console.log(`read  latency ms  p50 ${pc(lat.read, 0.5)}  p95 ${pc(lat.read, 0.95)}  p99 ${pc(lat.read, 0.99)}   (${lat.read.length})`);
console.log(`write latency ms  p50 ${pc(lat.write, 0.5)}  p95 ${pc(lat.write, 0.95)}  p99 ${pc(lat.write, 0.99)}   (${lat.write.length})`);
console.log(`server memory: ${rss().toFixed(0)} MB RSS`);
const m = await new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: '/readyz', headers: { Host: tenants[0].host } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(JSON.parse(Buffer.concat(c)))); }).on('error', () => res({})); }); console.log(`pool: ${JSON.stringify(m.pool)}`);
child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); agent.destroy(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
