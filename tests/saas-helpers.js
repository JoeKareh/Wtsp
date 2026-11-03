// SaaS test harness: boots the multi-tenant server and talks to it with raw http.request, because fetch() ignores a forged Host header.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export const DOMAIN = 'app.test';
export async function bootSaas(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizcontrol-saas-'));
  Object.assign(process.env, { APP_DOMAIN: DOMAIN, DB_PATH: path.join(dir, 'unused.sqlite'), CONTROL_DB_PATH: path.join(dir, 'control.sqlite'), TENANTS_DIR: path.join(dir, 'tenants'), APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), LOG_REQUESTS: 'false', PUBLIC_SCHEME: 'http' }, extraEnv);
  for (const k of ['PLATFORM_SMTP_HOST', 'SMTP_HOST', 'TURNSTILE_SECRET']) if (!(k in extraEnv)) delete process.env[k];
  const app = await import('../server/app.js'); const server = app.buildServer({ jobs: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; process.env.PUBLIC_PORT = String(port);
  const mods = { db: await import('../server/db.js'), control: await import('../server/control.js'), platform: await import('../server/platform.js'), lifecycle: await import('../server/lifecycle.js'), admin: await import('../server/admin.js'), rate: await import('../server/ratelimit.js'), totp: await import('../server/totp.js'), crypto: await import('../server/crypto.js') };
  return { server, port, dir, ...mods, close: () => new Promise((r) => { mods.db.closeAllTenants(); server.close(r); }) };
}

/** One browser-like client bound to a hostname (own cookie jar). */
export class HostClient {
  constructor(port, host) { this.port = port; this.host = host; this.cookies = {}; }
  req(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      const r = http.request({ host: '127.0.0.1', port: this.port, method, path: url, headers: { Host: this.host, 'X-Requested-With': 'XMLHttpRequest', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
          for (const c of res.headers['set-cookie'] || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (/Max-Age=0/i.test(c) || v === '') delete this.cookies[k]; else this.cookies[k] = v; }
          const buf = Buffer.concat(chunks); const ct = res.headers['content-type'] || '';
          let data = buf; if (ct.includes('json')) { try { data = JSON.parse(buf.toString('utf8')); } catch { data = buf.toString(); } } else if (ct.startsWith('text/')) data = buf.toString('utf8');
          resolve({ status: res.statusCode, data, headers: res.headers });
        });
      }); r.on('error', reject); if (payload) r.write(payload); r.end();
    });
  }
  get = (u, h) => this.req('GET', u, undefined, h); post = (u, b = {}, h) => this.req('POST', u, b, h); put = (u, b = {}) => this.req('PUT', u, b); del = (u) => this.req('DELETE', u);
  async ok(method, url, body, headers) { const r = await this.req(method, url, body, headers); if (r.status >= 300) throw new Error(`${method} ${this.host}${url} -> ${r.status}: ${JSON.stringify(r.data)}`); return r.data; }
}

let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
export function lastEmail(S, to, kind) { return S.control.cGet(`SELECT * FROM platform_outbox WHERE to_addr=? ${kind ? 'AND kind=?' : ''} ORDER BY id DESC LIMIT 1`, ...(kind ? [to, kind] : [to])); }
export const tokenFrom = (email) => /token=([0-9a-f]{64})/.exec(email.text)[1];

/** Sign up + verify + log in. Returns { c: tenant client, sub, id, email, password }. */
export async function makeTenant(S, over = {}) {
  S.rate.resetLimits();
  const sub = over.subdomain || ('t' + uniq()).toLowerCase().slice(0, 28); const email = over.email || `${sub}@example.com`; const password = over.password || 'correct-horse-9';
  const platform = new HostClient(S.port, DOMAIN);
  await platform.ok('POST', '/api/platform/signup', { business_name: over.business_name || `Biz ${sub}`, owner_name: 'Owner ' + sub, email, password, country: over.country || 'LB', currency: over.currency || 'USD', language: over.language || 'en', subdomain: sub });
  if (over.verify !== false) await platform.ok('POST', '/api/platform/verify', { token: tokenFrom(lastEmail(S, email, 'verify')) });
  const t = S.control.cGet('SELECT * FROM tenants WHERE subdomain=?', sub);
  const c = new HostClient(S.port, `${sub}.${DOMAIN}`);
  if (over.login !== false && over.verify !== false) await c.ok('POST', '/api/auth/login', { email, password });
  return { c, sub, id: t.id, email, password, platform };
}
