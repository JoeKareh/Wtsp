// Test harness: boots the real server against a throw-away SQLite file and gives an HTTP client with a cookie jar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function boot(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizcontrol-test-'));
  Object.assign(process.env, { DB_PATH: path.join(dir, 'test.sqlite'), LOG_REQUESTS: 'false' }, extraEnv);
  const app = await import('../server/app.js');
  const server = app.buildServer({ jobs: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const db = await import('../server/db.js');
  return { server, base, port, dir, db, close: () => new Promise((r) => server.close(r)) };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const res = await fetch(this.base + url, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.startsWith('sid=')) this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get = (u) => this.req('GET', u);
  post = (u, b = {}, h) => this.req('POST', u, b, h);
  put = (u, b = {}) => this.req('PUT', u, b);
  del = (u) => this.req('DELETE', u);
  /** assert success and return data */
  async ok(method, url, body, headers) {
    const r = await this.req(method, url, body, headers);
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  }
}
