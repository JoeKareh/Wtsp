import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, safeJson } from './util.js';
import { hasAny, stripFinance, hasPerm } from './perms.js';
import { get, run, tx } from './db.js';
import { log } from './log.js';

const routes = [];
/** Bumped after every successful write request; lets read-heavy endpoints cache safely. */
let dataVersion = 0;
export const getDataVersion = () => dataVersion;
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
  routes.push({ method, re, keys, opts, handler, pattern });
}
export const GET = (p, o, h) => route('GET', p, o, h);
export const POST = (p, o, h) => route('POST', p, o, h);
export const PUT = (p, o, h) => route('PUT', p, o, h);
export const DELETE = (p, o, h) => route('DELETE', p, o, h);

/** Return from a handler to send a file/raw body. */
export const raw = (body, type, filename, status = 200) => ({ __raw: true, body, type, filename, status });
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

function serveStatic(req, res, pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file);
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache' });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const started = Date.now();
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/webhooks/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  }
  let matched = null; let params = {}; let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    matched = r;
    try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return sendJson(res, 400, { error: 'Malformed URL' }); }
    break;
  }
  if (!matched) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });

  const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body: {}, rawBody: null, user: null, ip: clientIp(req), setCookies: [] };
  try {
    const { perm } = matched.opts;
    if (perm !== 'public') {
      const s = resolveSession(req, ctx);
      if (!s) throw new HttpError(401, 'Please sign in');
      ctx.user = { ...s.user, ip: ctx.ip }; ctx.session = s.session;
      if (perm) {
        const list = Array.isArray(perm) ? perm : [perm];
        if (!hasAny(ctx.user, list)) throw new HttpError(403, 'You do not have permission to do this');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // CSRF defence: custom header (cannot be set cross-site without CORS) + same-origin check
        if (req.headers['x-requested-with'] !== 'XMLHttpRequest') throw new HttpError(403, 'Missing CSRF header');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
      }
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
    let result;
    const exec = async () => matched.handler(ctx);
    result = await exec();
    if (ctx.user && result && !result.__raw && !hasPerm(ctx.user, 'finance:read')) {
      result = result.__reply ? { ...result, json: stripFinance(result.json) } : stripFinance(result);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') dataVersion++;
    const headers = {};
    if (ctx.setCookies.length) headers['Set-Cookie'] = ctx.setCookies;
    if (result && result.__raw) {
      const h = { 'Content-Type': result.type, 'Cache-Control': 'no-store', ...headers };
      if (result.filename) h['Content-Disposition'] = `attachment; filename="${result.filename.replace(/[^\w.\-]/g, '_')}"`;
      return send(res, result.status, result.body, h);
    }
    const status = result?.__reply ? result.status : 200;
    const json = result?.__reply ? result.json : (result ?? { ok: true });
    if (idemKey && ctx.user && status < 500) {
      try { run('INSERT OR IGNORE INTO idempotency_keys VALUES (?,?,?,?,?,?)', idemKey, ctx.user.id, matched.pattern, status, JSON.stringify(json), new Date().toISOString()); } catch { /* ignore */ }
    }
    sendJson(res, status, json, { ...headers, ...(result?.__reply ? result.headers : {}) });
  } catch (e) {
    const status = e.status || (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(e.message) ? 409 : 500);
    if (status >= 500) log.error(req.method, pathname, e.stack || e);
    let msg = e.message;
    if (status === 409 && !e.status) msg = 'A record with the same unique value already exists';
    if (status >= 500) msg = 'Internal server error';
    sendJson(res, status, { error: msg, details: e.details }, ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : {});
  } finally {
    if (process.env.LOG_REQUESTS === 'true') log.info(req.method, pathname, res.statusCode, `${Date.now() - started}ms`);
  }
}

export function createServer() {
  return http.createServer((req, res) => { handle(req, res).catch((e) => { log.error('fatal', e); try { send(res, 500, 'error'); } catch { /* */ } }); });
}
export { tx };
