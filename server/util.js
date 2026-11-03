// Shared helpers: errors, validation, money, dates, phones.
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);

// ---------- validation ----------
export function str(v, name, { required = false, max = 500, min = 0 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw bad(`${name} is required`);
    return '';
  }
  const s = String(v).trim();
  if (s.length > max) throw bad(`${name} is too long (max ${max})`);
  if (s.length < min) throw bad(`${name} is too short`);
  return s;
}
export function int(v, name, { required = false, min = -Infinity, max = Infinity, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return def; }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}
export function num(v, name, { required = false, min = -Infinity, max = Infinity, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return def; }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}
/** Money is integer minor units (1/100 of the currency unit) everywhere in the API and DB. */
export const money = (v, name, o = {}) => int(v, name, { min: 0, max: 9e13, ...o });
export function oneOf(v, name, list, { def } = {}) {
  if (v === undefined || v === null || v === '') { if (def !== undefined) return def; throw bad(`${name} is required`); }
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}
export function date(v, name, { required = false } = {}) {
  if (!v) { if (required) throw bad(`${name} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad(`${name} must be a valid date (YYYY-MM-DD)`);
  return v;
}
export const email = (v, name, { required = false } = {}) => {
  const s = str(v, name, { required, max: 200 }).toLowerCase();
  if (s && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw bad(`${name} is not a valid email`);
  return s;
};

// ---------- money / currency ----------
export const round = (n) => Math.round(n);
/** Convert minor units between currencies using units-per-base rates. */
export const convert = (amount, fromRate, toRate) => Math.round((amount / fromRate) * toRate);
export const toBase = (amount, fx) => Math.round(amount / fx);

// ---------- dates (business-local) ----------
export function todayStr(tz = 'UTC', d = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}
export const nowIso = () => new Date().toISOString();
export function addDays(ds, n) { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function diffDays(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
export function hourIn(tz) { try { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date())) % 24; } catch { return new Date().getUTCHours(); } }
export const startOfMonth = (ds) => ds.slice(0, 8) + '01';
export function endOfMonth(ds) { const d = new Date(ds.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); }
export function addMonths(ds, n) { const d = new Date(ds.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
export function mondayOf(ds) { const d = new Date(ds + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); }

/** Resolve a named range preset in the business time zone. */
export function resolveRange({ range = 'this_month', from, to }, tz) {
  const today = todayStr(tz);
  let f, t, label;
  switch (range) {
    case 'today': f = t = today; label = 'Today'; break;
    case 'yesterday': f = t = addDays(today, -1); label = 'Yesterday'; break;
    case 'this_week': f = mondayOf(today); t = addDays(f, 6); label = 'This week'; break;
    case 'last_month': { const s = addMonths(today, -1); f = s; t = endOfMonth(s); label = 'Last month'; break; }
    case 'this_year': f = today.slice(0, 4) + '-01-01'; t = today.slice(0, 4) + '-12-31'; label = 'This year'; break;
    case 'last_30': f = addDays(today, -29); t = today; label = 'Last 30 days'; break;
    case 'custom': f = date(from, 'from', { required: true }); t = date(to, 'to', { required: true }); label = 'Custom range'; break;
    default: f = startOfMonth(today); t = endOfMonth(today); label = 'This month';
  }
  if (t < f) throw bad('End date is before start date');
  const days = diffDays(f, t) + 1;
  return { from: f, to: t, days, label, today };
}
/** Previous comparison period (same length immediately before, or same dates last year). */
export function compareRange(r, mode = 'prev') {
  if (mode === 'year') {
    const sh = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
    return { from: sh(r.from), to: sh(r.to), days: r.days, label: 'Same period last year' };
  }
  const to = addDays(r.from, -1); const from = addDays(to, -(r.days - 1));
  return { from, to, days: r.days, label: 'Previous period' };
}

// ---------- phones ----------
export function normPhone(raw, cc = '') {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    s = s.replace(/\D/g, '');
    if (cc && s.startsWith(cc) && s.length >= cc.length + 7) s = '+' + s;
    else if (cc) s = '+' + cc + s.replace(/^0+/, '');
    else s = '+' + s.replace(/^0+/, '');
  }
  s = '+' + s.slice(1).replace(/\D/g, '');
  if (!/^\+\d{8,15}$/.test(s)) throw bad(`"${raw}" is not a valid phone number. Use international format, e.g. +96171123456`);
  return s;
}
export const phoneDigits = (p) => String(p || '').replace(/\D/g, '');

// ---------- misc ----------
export const uuid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const pad = (n, w = 6) => String(n).padStart(w, '0');
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const pct = (a, b) => (b ? (a / b) * 100 : null);
export const safeJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const placeholders = (n) => Array(n).fill('?').join(',');
export const escLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
