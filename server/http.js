import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, safeJson } from './util.js';
import { hasAny, stripFinance, hasPerm } from './perms.js';
import crypto from 'node:crypto';
import { get, run, tx, als, tenantKey } from './db.js';
import { log } from './log.js';

const routes = [];
/** Per-tenant write counter: lets read-heavy endpoints cache safely. Never shared between tenants. */
const versions = new Map();
export const getDataVersion = () => versions.get(tenantKey()) || 0;
const bump = (k) => versions.set(k, (versions.get(k) || 0) + 1);

// Pluggable platform behaviour (installed by server/platform.js in SaaS mode; defaults give single-business behaviour)
const hooks = { host: () => ({ scope: 'tenant' }), gate: () => null, admin: () => null, ready: () => ({ ok: true }) };
export const setReadyCheck = (fn) => { hooks.ready = fn; };
export const setHostResolver = (fn) => { hooks.host = fn; };
export const setLifecycleGate = (fn) => { hooks.gate = fn; };
export const setAdminResolver = (fn) => { hooks.admin = fn; };

// Observability
export const metrics = { requests: 0, inflight: 0, byClass: {}, buckets: { 50: 0, 100: 0, 250: 0, 500: 0, 1000: 0, 2500: 0, inf: 0 }, sumMs: 0 };
const errorRing = new Map();
export const recentErrors = (key) => errorRing.get(key) || [];
const noteError = (key, msg) => { const a = errorRing.get(key) || []; a.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 300) }); if (a.length > 20) a.shift(); errorRing.set(key, a); };
let resolveSession = () => null;
export const setSessionResolver = (fn) => { resolveSession = fn; };

/**
 * opts.perm: 'public' | permission | [any-of permissions] | undefined (any logged-in user)
 * opts.idem: honour the Idempotency-Key header (prevents duplicate financial submissions)
 * opts.raw: keep raw body buffer on ctx.rawBody (webhooks)
 */
export function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler, pattern, scope: opts.scope || 'tenant' });
}
export const GET = (p, o, h) => route('GET', p, o, h);
export const POST = (p, o, h) => route('POST', p, o, h);
export const PUT = (p, o, h) => route('PUT', p, o, h);
export const DELETE = (p, o, h) => route('DELETE', p, o, h);

/** Return from a handler to send a file/raw body. */
export const raw = (body, type, filename, status = 200) => ({ __raw: true, body, type, filename, status });
export const redirect = (url, status = 302) => ({ __raw: true, body: '', type: 'text/plain', status, redirect: url });
/** Return from a handler to set a status or headers on a JSON body. */
export const reply = (status, json, headers = {}) => ({ __reply: true, status, json, headers });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseCookies(h = '') {
  const o = {};
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return o;
}
export function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress;
}
export const isHttps = (req) => config.cookieSecure || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function serveStatic(req, res, pathname, scope = 'tenant') {
  const root = scope === 'platform' ? config.siteDir : scope === 'admin' ? config.adminDir : config.publicDir;
  let rel; try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (rel === '/' && scope === 'platform') rel = '/index.html';
  if (scope === 'platform' && !path.extname(rel)) rel = rel.replace(/\/$/, '') + '.html';   // /pricing -> /pricing.html
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file);
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache' });
  });
}

async function handle(req, res) {
  const rid = crypto.randomUUID().slice(0, 12); res.setHeader('X-Request-Id', rid);
  const pn = req.url.split('?')[0];
  if (pn === '/healthz') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  if (pn === '/readyz') { let r; try { r = await hooks.ready(); } catch (e) { r = { ok: false, error: e.message }; } return sendJson(res, r.ok ? 200 : 503, r); }
  let h;
  try { h = hooks.host(req); } catch (e) { log.error('host resolution failed', e); return send(res, 500, 'error'); }
  if (h.scope === 'none') return send(res, h.status || 404, h.status === 410 ? 'This workspace has been deleted.' : 'Not found', { 'Content-Type': 'text/plain' });
  metrics.inflight++; res.on('close', () => { metrics.inflight--; });
  if (h.tenantId) return als.run({ tenantId: h.tenantId, tenant: h.tenant, rid }, () => process_(req, res, h, rid));
  return process_(req, res, h, rid);
}

async function process_(req, res, h, rid) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const started = Date.now();
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/webhooks/') && pathname !== '/metrics') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname, h.scope);
  }
  let matched = null; let params = {}; let pathMatched = false;
  for (const r of routes) {
    if (r.scope !== h.scope) continue;                       // a route only exists on the host scope it was registered for
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    matched = r;
    try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return sendJson(res, 400, { error: 'Malformed URL' }); }
    break;
  }
  if (!matched) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });

  const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body: {}, rawBody: null, user: null, ip: clientIp(req), setCookies: [], scope: h.scope, tenant: h.tenant || null, rid };
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  try {
    const { perm } = matched.opts;
    if (h.tenant) { const g = hooks.gate(h.tenant, req.method, matched.opts); if (g) throw new HttpError(g.status, g.message, { code: g.code }); }
    const csrf = () => {
      if (isRead) return;
      // CSRF defence: custom header (cannot be set cross-site without CORS) + same-origin check
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') throw new HttpError(403, 'Missing CSRF header');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
    };
    if (perm === 'admin') {
      const a = hooks.admin(req); if (!a) throw new HttpError(401, 'Please sign in');
      ctx.admin = a.admin; ctx.adminSession = a.session; csrf();
    } else if (perm !== 'public') {
      const s = resolveSession(req, ctx);
      if (!s) throw new HttpError(401, 'Please sign in');
      ctx.user = { ...s.user, ip: ctx.ip }; ctx.session = s.session;
      if (perm) {
        const list = Array.isArray(perm) ? perm : [perm];
        if (!hasAny(ctx.user, list)) throw new HttpError(403, 'You do not have permission to do this');
      }
      csrf();
      if (!isRead && s.session.readonly && matched.pattern !== '/api/auth/logout') throw new HttpError(403, 'This is a read-only support session: changes are disabled.', { code: 'support_readonly' });
    }
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const buf = await readBody(req);
      if (matched.opts.raw) ctx.rawBody = buf;
      if (buf.length) {
        if (!matched.opts.raw || (req.headers['content-type'] || '').includes('json')) {
          let parsed;
          try { parsed = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'The request body must be a JSON object');
          ctx.body = parsed;
        }
      }
    }
    const idemKey = matched.opts.idem && req.headers['idempotency-key'];
    if (idemKey && ctx.user) {
      const prior = get('SELECT status, response FROM idempotency_keys WHERE key=? AND user_id=? AND route=?', idemKey, ctx.user.id, matched.pattern);
      if (prior) return sendJson(res, prior.status, JSON.parse(prior.response), { 'Idempotent-Replay': 'true' });
    }
    let result = await matched.handler(ctx);
    if (ctx.user && result && !result.__raw && !hasPerm(ctx.user, 'finance:read')) {
      result = result.__reply ? { ...result, json: stripFinance(result.json) } : stripFinance(result);
    }
    if (!isRead && h.tenantId) bump(h.tenantId); else if (!isRead && !config.saas) bump('default');
    const headers = {};
    if (ctx.setCookies.length) headers['Set-Cookie'] = ctx.setCookies;
    if (result && result.__raw) {
      const hh = { 'Content-Type': result.type, 'Cache-Control': 'no-store', ...headers };
      if (result.filename) hh['Content-Disposition'] = `attachment; filename="${result.filename.replace(/[^\w.\-]/g, '_')}"`;
      if (result.redirect) { hh.Location = result.redirect; }
      return send(res, result.status, result.body, hh);
    }
    const status = result?.__reply ? result.status : 200;
    const json = result?.__reply ? result.json : (result ?? { ok: true });
    if (idemKey && ctx.user && status < 500) {
      try { run('INSERT OR IGNORE INTO idempotency_keys VALUES (?,?,?,?,?,?)', idemKey, ctx.user.id, matched.pattern, status, JSON.stringify(json), new Date().toISOString()); } catch { /* ignore */ }
    }
    sendJson(res, status, json, { ...headers, ...(result?.__reply ? result.headers : {}) });
  } catch (e) {
    const status = e.status || (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(e.message) ? 409 : 500);
    if (status >= 500) { log.error(req.method, pathname, e.stack || e); try { noteError(h.tenantId || 'platform', e.message); } catch { /* ignore */ } }
    let msg = e.message;
    if (status === 409 && !e.status) msg = 'A record with the same unique value already exists';
    if (status >= 500 && !e.tenantUnavailable) msg = 'Internal server error';
    sendJson(res, status, { error: msg, details: e.details }, ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : {});
  } finally {
    const ms = Date.now() - started; metrics.requests++; metrics.sumMs += ms;
    const cls = Math.floor((res.statusCode || 500) / 100) + 'xx'; metrics.byClass[cls] = (metrics.byClass[cls] || 0) + 1;
    for (const b of [50, 100, 250, 500, 1000, 2500]) if (ms <= b) { metrics.buckets[b]++; break; } else if (b === 2500) metrics.buckets.inf++;
    if (process.env.LOG_REQUESTS === 'true') log.info('request', { method: req.method, path: pathname, status: res.statusCode, ms, tenant: h.tenantId || null, rid });
  }
}

export function createServer() {
  const srv = http.createServer((req, res) => { handle(req, res).catch((e) => { log.error('fatal', e); try { send(res, 500, 'error'); } catch { /* */ } }); });
  srv.requestTimeout = 60_000; srv.headersTimeout = 20_000;   // slow-client protection (a reverse proxy sits in front in production)
  return srv;
}
export { tx };
