import crypto from 'node:crypto';
import { GET, POST, PUT, DELETE, setSessionResolver, parseCookies, isHttps, reply } from './http.js';
import { all, get, run, tx, audit, allSettings, setSettings, tenantKey, currentTenantContext } from './db.js';
import { workspaceInfo } from './lifecycle.js';
import { enforce } from './limits.js';
import { HttpError, bad, notFound, str, email as vEmail, nowIso, sha256, safeJson } from './util.js';
import { DEFAULT_ROLES, ALL_PERMS, PERMISSIONS, hasPerm } from './perms.js';
import { queueEmail, flushOutbox } from './mail.js';
import { config } from './config.js';
import { log } from './log.js';

const SESSION_DAYS = 7;

// ---------- password hashing (scrypt) ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(hashHex, 'hex');
  return exp.length === h.length && crypto.timingSafeEqual(exp, h);
}
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
  if (pw.length > 200) throw bad('Password too long');
  if (/^(password|12345678|qwerty123)/i.test(pw)) throw bad('That password is too easy to guess');
}

// ---------- roles bootstrap ----------
export function ensureRoles() {
  for (const [name, r] of Object.entries(DEFAULT_ROLES)) {
    if (!get('SELECT id FROM roles WHERE name=?', name)) run('INSERT INTO roles(name,description,permissions) VALUES (?,?,?)', name, r.description, JSON.stringify(r.permissions));
  }
}

function loadUser(id) {
  const u = get('SELECT u.*, r.name AS role, r.permissions AS role_perms FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?', id);
  if (!u) return null;
  const perms = u.role === 'OWNER' ? ['*'] : (safeJson(u.permissions, null) ?? safeJson(u.role_perms, []));
  return { id: u.id, name: u.name, email: u.email, role: u.role, role_id: u.role_id, active: !!u.active, language: u.language, permissions: perms };
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, language: u.language || null, permissions: u.permissions.includes('*') ? ALL_PERMS : u.permissions });

// ---------- sessions ----------
/** Hosted mode: an account is for one person at a time. Signing in on another device/browser signs the previous one out. The operator can raise the limit per workspace. */
function enforceSessionLimit(userId) {
  const t = currentTenantContext()?.tenant; if (!t) return;
  const flags = safeJson(t.flags, {}); const max = Math.max(1, Number(flags.max_sessions ?? process.env.SESSION_LIMIT ?? 1));
  const rows = all('SELECT s.id FROM sessions s LEFT JOIN session_flags f ON f.session_id=s.id WHERE s.user_id=? AND f.session_id IS NULL ORDER BY s.created_at DESC', userId);
  for (const r of rows.slice(max - 1)) run('DELETE FROM sessions WHERE id=?', r.id);
}
export function createSession(ctx, userId, opts = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  if (!opts.impersonator && !opts.readonly) enforceSessionLimit(userId);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)', sha256(token), userId, nowIso(), opts.expires || exp, nowIso(), ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200));
  if (opts.impersonator || opts.readonly) run('INSERT INTO session_flags(session_id,impersonator,readonly) VALUES (?,?,?)', sha256(token), opts.impersonator || null, opts.readonly ? 1 : 0);
  setCookie(ctx, token, SESSION_DAYS * 86400);
}
// Over HTTPS the cookie uses the __Host- prefix: browsers then guarantee it is host-only (no Domain), Secure and Path=/,
// so a sibling subdomain can never set or overwrite another workspace's session cookie ("cookie tossing").
const cookieName = (req) => (isHttps(req) ? '__Host-sid' : 'sid');
const readSid = (req) => { const c = parseCookies(req.headers.cookie); return c['__Host-sid'] || c.sid; };
function setCookie(ctx, token, maxAge) {
  ctx.setCookies.push(`${cookieName(ctx.req)}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(ctx.req) ? '; Secure' : ''}`);
}
setSessionResolver((req) => {
  const token = readSid(req);
  if (!token) return null;
  const id = sha256(token);
  const s = get('SELECT s.*, f.impersonator, COALESCE(f.readonly,0) AS readonly FROM sessions s LEFT JOIN session_flags f ON f.session_id=s.id WHERE s.id=?', id);
  if (!s) return null;
  if (s.expires_at < nowIso()) { run('DELETE FROM sessions WHERE id=?', id); return null; }
  const user = loadUser(s.user_id);
  if (!user || !user.active) return null;
  if (Date.now() - Date.parse(s.last_seen) > 300000 && !s.impersonator) {
    run('UPDATE sessions SET last_seen=?, expires_at=? WHERE id=?', nowIso(), new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), id);
  }
  return { user, session: { id, sid_hash: id, readonly: !!s.readonly, impersonator: s.impersonator || null } };
});

// ---------- login throttling ----------
const attempts = new Map();
function throttle(key) {
  const now = Date.now(); const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(key, a);
  if (a.length >= 8) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
}
const failed = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

const userCount = () => get('SELECT COUNT(*) c FROM users').c;

// ---------- routes ----------
GET('/api/auth/status', { perm: 'public', lifecycle: 'status' }, (ctx) => {
  const s = (() => { try { const tok = readSid(ctx.req); if (!tok) return null; const row = get('SELECT user_id, expires_at FROM sessions WHERE id=?', sha256(tok)); return row && row.expires_at > nowIso() ? loadUser(row.user_id) : null; } catch { return null; } })();
  const st = allSettings();
  const ws = workspaceInfo(currentTenantContext()?.tenant); const sess = (() => { try { const tok = readSid(ctx.req); return tok ? get('SELECT impersonator, readonly FROM session_flags WHERE session_id=?', sha256(tok)) : null; } catch { return null; } })();
  return { needs_setup: config.saas ? false : userCount() === 0, user: s && s.active ? publicUser(s) : null, business_name: st.business_name, is_demo: st.is_demo, language: st.language, workspace: ws, support_session: sess ? { by: sess.impersonator, readonly: !!sess.readonly } : null, saas: config.saas };
});

POST('/api/auth/setup', { perm: 'public' }, (ctx) => {
  if (config.saas) throw new HttpError(403, 'Workspaces are created by signing up');
  if (userCount() > 0) throw new HttpError(403, 'Setup already completed');
  const { name, email, password, business_name } = ctx.body;
  const e = vEmail(email, 'Email', { required: true }); const n = str(name, 'Name', { required: true, max: 100 });
  checkPassword(password);
  const id = tx(() => {
    const role = get("SELECT id FROM roles WHERE name='OWNER'");
    const uid = run('INSERT INTO users(email,name,password_hash,role_id,created_at) VALUES (?,?,?,?,?)', e, n, hashPassword(password), role.id, nowIso()).lastInsertRowid;
    setSettings({ business_name: str(business_name, 'Business name', { max: 120 }) || 'My Business', owner_email: e });
    audit({ id: uid, name: n }, 'setup', 'user', uid, null, { email: e, role: 'OWNER' });
    return uid;
  });
  createSession(ctx, id);
  return publicUser(loadUser(id));
});

POST('/api/auth/login', { perm: 'public', lifecycle: 'always' }, (ctx) => {
  const e = String(ctx.body.email || '').trim().toLowerCase(); const pw = String(ctx.body.password || '');
  const key = tenantKey() + '|' + ctx.ip + '|' + e; throttle(key);
  const u = get('SELECT * FROM users WHERE email=?', e);
  // run a hash either way to keep timing similar
  const ok = u ? verifyPassword(pw, u.password_hash) : (verifyPassword(pw, 'scrypt$00$00'), false);
  if (!u || !ok || !u.active) { failed(key); audit(null, 'login_failed', 'user', u?.id ?? null, null, { email: e }); throw new HttpError(401, 'Incorrect email or password'); }
  attempts.delete(key);
  createSession(ctx, u.id);
  run('UPDATE users SET last_login_at=? WHERE id=?', nowIso(), u.id);
  audit({ id: u.id, name: u.name, ip: ctx.ip }, 'login', 'user', u.id);
  return publicUser(loadUser(u.id));
});

POST('/api/auth/logout', { lifecycle: 'always' }, (ctx) => {
  run('DELETE FROM sessions WHERE id=?', ctx.session.id);
  setCookie(ctx, '', 0);
  audit(ctx.user, 'logout', 'user', ctx.user.id);
  return { ok: true };
});
GET('/api/auth/me', { lifecycle: 'always' }, (ctx) => publicUser(ctx.user));

POST('/api/auth/change-password', { lifecycle: 'always' }, (ctx) => {
  const u = get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!verifyPassword(String(ctx.body.current_password || ''), u.password_hash)) throw bad('Current password is incorrect');
  checkPassword(ctx.body.new_password);
  tx(() => {
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(ctx.body.new_password), u.id);
    run('DELETE FROM sessions WHERE user_id=? AND id<>?', u.id, ctx.session.id); // sign out other devices
    audit(ctx.user, 'change_password', 'user', u.id);
  });
  return { ok: true };
});

GET('/api/auth/sessions', {}, (ctx) =>
  all('SELECT id, created_at, last_seen, ip, user_agent FROM sessions WHERE user_id=? ORDER BY last_seen DESC', ctx.user.id)
    .map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === ctx.session.id })));
DELETE('/api/auth/sessions/:id', {}, (ctx) => {
  const s = all('SELECT id FROM sessions WHERE user_id=?', ctx.user.id).find((x) => x.id.startsWith(ctx.params.id));
  if (!s) throw notFound('Session');
  run('DELETE FROM sessions WHERE id=?', s.id);
  return { ok: true };
});

function issueReset(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO password_resets VALUES (?,?,?,NULL)', sha256(token), userId, new Date(Date.now() + 3600e3).toISOString());
  const base = config.saas ? config.tenantUrl(currentTenantContext().tenant.subdomain) : config.baseUrl;
  return `${base}/#/reset?token=${token}`;
}
POST('/api/auth/forgot', { perm: 'public', lifecycle: 'always' }, (ctx) => {
  const e = String(ctx.body.email || '').trim().toLowerCase(); throttle('forgot|' + ctx.ip); failed('forgot|' + ctx.ip);
  const u = get('SELECT * FROM users WHERE email=? AND active=1', e);
  if (u) {
    const link = issueReset(u.id);
    queueEmail({ to: u.email, subject: 'Reset your password', body: `Hello ${u.name},\n\nUse this link within 1 hour to reset your password:\n${link}\n\nIf you did not ask for this, ignore this email.` });
    flushOutbox().catch(() => {});
    log.info(`Password reset requested for ${u.email}. (If SMTP is not configured the owner can generate a link in Settings → Users.)`);
  }
  return { ok: true, message: 'If that email exists, a reset link has been sent.' };
});
POST('/api/auth/reset', { perm: 'public', lifecycle: 'always' }, (ctx) => {
  const t = get('SELECT * FROM password_resets WHERE token_hash=?', sha256(String(ctx.body.token || '')));
  if (!t || t.used_at || t.expires_at < nowIso()) throw bad('This reset link is invalid or has expired');
  checkPassword(ctx.body.password);
  tx(() => {
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(ctx.body.password), t.user_id);
    run('UPDATE password_resets SET used_at=? WHERE token_hash=?', nowIso(), t.token_hash);
    run('DELETE FROM sessions WHERE user_id=?', t.user_id);
    audit({ id: t.user_id, name: 'self' }, 'password_reset', 'user', t.user_id);
  });
  return { ok: true };
});

// ---------- user & role administration (owner) ----------
const UM = { perm: 'users:manage' };
const listUsers = () => all(`SELECT u.id,u.email,u.name,u.active,u.created_at,u.last_login_at,u.permissions,r.name role FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.id`)
  .map((u) => ({ ...u, permissions: safeJson(u.permissions, null), active: !!u.active }));
GET('/api/users', UM, () => listUsers());
GET('/api/roles', { perm: 'users:manage' }, () => ({
  roles: all('SELECT * FROM roles ORDER BY id').map((r) => ({ ...r, permissions: safeJson(r.permissions, []) })),
  catalog: PERMISSIONS,
}));
PUT('/api/roles/:id', UM, (ctx) => {
  const r = get('SELECT * FROM roles WHERE id=?', ctx.params.id); if (!r) throw notFound('Role');
  if (r.name === 'OWNER') throw bad('The OWNER role always has full access');
  const perms = (ctx.body.permissions || []).filter((p) => ALL_PERMS.includes(p));
  run('UPDATE roles SET permissions=? WHERE id=?', JSON.stringify(perms), r.id);
  audit(ctx.user, 'update', 'role', r.id, { permissions: safeJson(r.permissions) }, { permissions: perms });
  return { ok: true };
});
function userInput(b, { creating }) {
  const role = get('SELECT * FROM roles WHERE name=?', String(b.role || '')); if (!role) throw bad('Choose a valid role');
  let perms = null;
  if (Array.isArray(b.permissions)) perms = b.permissions.filter((p) => ALL_PERMS.includes(p));
  if (role.name === 'OWNER') perms = null;
  return { email: vEmail(b.email, 'Email', { required: creating }), name: str(b.name, 'Name', { required: creating, max: 100 }), role, perms };
}
POST('/api/users', UM, (ctx) => {
  enforce('users');
  const { email, name, role, perms } = userInput(ctx.body, { creating: true });
  checkPassword(ctx.body.password);
  if (get('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'A user with this email already exists');
  const id = tx(() => {
    const uid = run('INSERT INTO users(email,name,password_hash,role_id,permissions,created_at) VALUES (?,?,?,?,?,?)', email, name, hashPassword(ctx.body.password), role.id, perms ? JSON.stringify(perms) : null, nowIso()).lastInsertRowid;
    audit(ctx.user, 'create', 'user', uid, null, { email, name, role: role.name, permissions: perms });
    return uid;
  });
  return listUsers().find((u) => u.id === Number(id));
});
PUT('/api/users/:id', UM, (ctx) => {
  const u = get('SELECT u.*, r.name role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?', ctx.params.id); if (!u) throw notFound('User');
  const { name, role, perms } = userInput({ ...ctx.body, email: u.email }, { creating: false });
  const active = ctx.body.active === false ? 0 : 1;
  if (u.id === ctx.user.id && (!active || role.name !== 'OWNER')) throw bad('You cannot deactivate or demote your own account');
  if (u.role === 'OWNER' && (role.name !== 'OWNER' || !active) && get("SELECT COUNT(*) c FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='OWNER' AND u.active=1").c <= 1) throw bad('At least one active owner is required');
  tx(() => {
    run('UPDATE users SET name=?, role_id=?, permissions=?, active=? WHERE id=?', name || u.name, role.id, perms ? JSON.stringify(perms) : null, active, u.id);
    if (!active) run('DELETE FROM sessions WHERE user_id=?', u.id);
    if (ctx.body.password) { checkPassword(ctx.body.password); run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(ctx.body.password), u.id); run('DELETE FROM sessions WHERE user_id=?', u.id); }
    audit(ctx.user, 'update', 'user', u.id, { role: u.role, active: !!u.active, permissions: safeJson(u.permissions) }, { role: role.name, active: !!active, permissions: perms });
  });
  return listUsers().find((x) => x.id === u.id);
});
POST('/api/users/:id/reset-link', UM, (ctx) => {
  const u = get('SELECT * FROM users WHERE id=?', ctx.params.id); if (!u) throw notFound('User');
  audit(ctx.user, 'issue_reset_link', 'user', u.id);
  return { link: issueReset(u.id), expires_in_minutes: 60 };
});

GET('/api/audit', { perm: 'audit:read' }, (ctx) => {
  const { entity, user, from, to, q } = ctx.query; const limit = Math.min(Number(ctx.query.limit) || 100, 500); const offset = Number(ctx.query.offset) || 0;
  const w = []; const p = [];
  if (entity) { w.push('entity=?'); p.push(entity); }
  if (user) { w.push('user_name LIKE ?'); p.push(`%${user}%`); }
  if (from) { w.push('at>=?'); p.push(from); }
  if (to) { w.push('at<=?'); p.push(to + 'T23:59:59.999Z'); }
  if (q) { w.push('(entity_id=? OR action LIKE ? OR note LIKE ?)'); p.push(q, `%${q}%`, `%${q}%`); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return {
    total: get(`SELECT COUNT(*) c FROM audit_logs ${where}`, ...p).c,
    rows: all(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map((r) => ({ ...r, before: safeJson(r.before), after: safeJson(r.after) })),
  };
});
