import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GET, POST, PUT, DELETE, raw } from '../http.js';
import { all, get, run, tx, audit, allSettings, nextCounter, fxRate, uploadsDir } from '../db.js';
import { bad, notFound, str, money, oneOf, date, nowIso, todayStr, pad, escLike, addDays, addMonths } from '../util.js';
import { config } from '../config.js';
import { notify, avgAmountBase } from './notifications.js';

const BASE = 'CAST(ROUND(e.amount*1.0/e.fx_rate) AS INTEGER)';
const FREQ = ['weekly', 'monthly', 'yearly'];
const ALLOWED_EXT = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function nextDue(from, freq) {
  if (freq === 'weekly') return addDays(from, 7);
  if (freq === 'monthly') { const d = new Date(from + 'T00:00:00Z'); const day = d.getUTCDate(); const n = new Date(addMonths(from, 1) + 'T00:00:00Z'); const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate(); n.setUTCDate(Math.min(day, last)); return n.toISOString().slice(0, 10); }
  return addMonths(from, 12);
}

function parse(b, cur) {
  const st = allSettings();
  const recurring = b.recurring !== undefined ? (b.recurring ? oneOf(b.recurring, 'Recurrence', FREQ) : null) : (cur?.recurring ?? null);
  const paid_at = date(b.paid_at ?? cur?.paid_at ?? todayStr(st.timezone), 'Date', { required: true });
  return {
    category: oneOf(b.category ?? cur?.category, 'Category', st.expense_categories),
    description: str(b.description ?? cur?.description, 'Description', { required: true, max: 300 }),
    amount: money(b.amount ?? cur?.amount, 'Amount', { required: true, min: 1 }),
    currency: oneOf(b.currency ?? cur?.currency ?? st.base_currency, 'Currency', st.currencies),
    method: oneOf(b.method ?? cur?.method, 'Payment method', st.payment_methods),
    paid_at, recurring,
  };
}
function saveAttachment(id, att) {
  if (!att || !att.data_base64) return null;
  const ext = path.extname(String(att.name || '')).toLowerCase();
  if (!ALLOWED_EXT[ext]) throw bad('Attachment must be a PDF, PNG, JPG or WEBP file');
  const buf = Buffer.from(att.data_base64, 'base64');
  if (!buf.length || buf.length > 5 * 1024 * 1024) throw bad('Attachment must be smaller than 5 MB');
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const file = `expense-${id}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadsDir(), file), buf);
  return { path: file, name: String(att.name).slice(0, 120) };
}

export function createExpense(b, user, { parent = null } = {}) {
  const v = parse(b);
  return tx(() => {
    const fx = fxRate(v.currency, v.paid_at);
    const code = 'EXP-' + pad(nextCounter('expense'));
    const next = v.recurring && !parent ? nextDue(v.paid_at, v.recurring) : null;
    const id = run(`INSERT INTO expenses(code,category,description,amount,currency,fx_rate,paid_at,method,recurring,recurring_next,recurring_active,parent_id,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, v.category, v.description, v.amount, v.currency, fx, v.paid_at, v.method, parent ? null : v.recurring, next, next ? 1 : 0, parent, user?.id ?? null, nowIso(), nowIso()).lastInsertRowid;
    const att = saveAttachment(id, b.attachment);
    if (att) run('UPDATE expenses SET attachment_path=?, attachment_name=? WHERE id=?', att.path, att.name, id);
    audit(user, 'create', 'expense', id, null, { code, ...v });
    const e = getExpense(id);
    const st = allSettings();
    const avg = avgAmountBase(`SELECT AVG(${BASE}) avg, COUNT(*) n FROM expenses e WHERE category=? AND id<>? AND paid_at>=?`, v.category, id, addDays(todayStr(st.timezone), -180));
    if (avg && e.amount_base > avg * Number(st.unusual_amount_multiplier)) {
      notify({ type: 'unusual_transaction', title: `Unusually large expense ${code} (${v.category})`, body: `${(e.amount_base / 100).toFixed(2)} ${st.base_currency} vs ${(avg / 100).toFixed(2)} average for this category.`, link: '#/expenses', entity_type: 'expense', entity_id: id, dedupe_key: `unusual_exp:${id}` });
    }
    return e;
  });
}
export function getExpense(id) {
  const e = get(`SELECT e.*, ${BASE} AS amount_base FROM expenses e WHERE e.id=?`, id);
  return e ? { ...e, has_attachment: !!e.attachment_path, attachment_path: undefined } : null;
}

export function processRecurringExpenses() {
  const today = todayStr(allSettings().timezone); let n = 0;
  for (const p of all('SELECT * FROM expenses WHERE recurring_active=1 AND recurring_next<=?', today)) {
    let next = p.recurring_next; let guard = 0;
    while (next <= today && guard++ < 24) {
      createExpense({ category: p.category, description: p.description, amount: p.amount, currency: p.currency, method: p.method, paid_at: next }, { id: null, name: 'recurring' }, { parent: p.id });
      next = nextDue(next, p.recurring); n++;
    }
    run('UPDATE expenses SET recurring_next=? WHERE id=?', next, p.id);
  }
  return n;
}

GET('/api/expenses', { perm: 'expenses:read' }, (ctx) => {
  const q = ctx.query; const w = []; const p = [];
  if (q.q) { w.push("(e.description LIKE ? ESCAPE '\\' OR e.code LIKE ? ESCAPE '\\')"); p.push(`%${escLike(q.q)}%`, `%${escLike(q.q)}%`); }
  if (q.category) { w.push('e.category=?'); p.push(q.category); }
  if (q.method) { w.push('e.method=?'); p.push(q.method); }
  if (q.currency) { w.push('e.currency=?'); p.push(q.currency); }
  if (q.recurring === '1') w.push('e.recurring_active=1');
  if (q.from) { w.push('e.paid_at>=?'); p.push(q.from); }
  if (q.to) { w.push('e.paid_at<=?'); p.push(q.to); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Number(q.limit) || 50, 1000); const offset = Number(q.offset) || 0;
  return {
    summary: get(`SELECT COUNT(*) count, COALESCE(SUM(${BASE}),0) total_base FROM expenses e ${where}`, ...p),
    by_category: all(`SELECT category, SUM(${BASE}) total_base, COUNT(*) count FROM expenses e ${where} GROUP BY category ORDER BY total_base DESC`, ...p),
    rows: all(`SELECT e.id,e.code,e.category,e.description,e.amount,e.currency,e.fx_rate,e.paid_at,e.method,e.recurring,e.recurring_next,e.recurring_active,e.parent_id,e.attachment_name,
       (e.attachment_path IS NOT NULL) AS has_attachment, ${BASE} AS amount_base FROM expenses e ${where} ORDER BY e.paid_at DESC, e.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset),
  };
});
GET('/api/expenses/meta', { perm: ['expenses:read', 'expenses:write'] }, () => { const s = allSettings(); return { categories: s.expense_categories, methods: s.payment_methods, currencies: s.currencies, base: s.base_currency }; });
GET('/api/expenses/:id', { perm: 'expenses:read' }, (ctx) => { const e = getExpense(Number(ctx.params.id)); if (!e) throw notFound('Expense'); return e; });
POST('/api/expenses', { perm: 'expenses:write', idem: true }, (ctx) => createExpense(ctx.body, ctx.user));
PUT('/api/expenses/:id', { perm: 'expenses:write' }, (ctx) => {
  const cur = get('SELECT * FROM expenses WHERE id=?', ctx.params.id); if (!cur) throw notFound('Expense');
  const v = parse(ctx.body, cur);
  return tx(() => {
    let fx = cur.fx_rate; if (v.currency !== cur.currency || v.paid_at !== cur.paid_at) fx = fxRate(v.currency, v.paid_at);
    const active = v.recurring && !cur.parent_id ? 1 : 0;
    const next = active ? (cur.recurring_next || nextDue(v.paid_at, v.recurring)) : null;
    run('UPDATE expenses SET category=?,description=?,amount=?,currency=?,fx_rate=?,paid_at=?,method=?,recurring=?,recurring_active=?,recurring_next=?,updated_at=? WHERE id=?',
      v.category, v.description, v.amount, v.currency, fx, v.paid_at, v.method, cur.parent_id ? null : v.recurring, active, next, nowIso(), cur.id);
    const att = saveAttachment(cur.id, ctx.body.attachment);
    if (att) run('UPDATE expenses SET attachment_path=?, attachment_name=? WHERE id=?', att.path, att.name, cur.id);
    audit(ctx.user, 'update', 'expense', cur.id, { amount: cur.amount, currency: cur.currency, category: cur.category, paid_at: cur.paid_at }, v, str(ctx.body.reason, 'Reason', { max: 300 }));
    return getExpense(cur.id);
  });
});
DELETE('/api/expenses/:id', { perm: 'expenses:write' }, (ctx) => {
  const cur = get('SELECT * FROM expenses WHERE id=?', ctx.params.id); if (!cur) throw notFound('Expense');
  tx(() => { run('DELETE FROM expenses WHERE id=?', cur.id); audit(ctx.user, 'delete', 'expense', cur.id, cur, null, str(ctx.query.reason, 'Reason', { max: 300 })); });
  return { deleted: true };
});
GET('/api/expenses/:id/attachment', { perm: 'expenses:read' }, (ctx) => {
  const e = get('SELECT attachment_path, attachment_name FROM expenses WHERE id=?', ctx.params.id);
  if (!e?.attachment_path) throw notFound('Attachment');
  const file = path.join(uploadsDir(), path.basename(e.attachment_path));
  if (!fs.existsSync(file)) throw notFound('Attachment file');
  return raw(fs.readFileSync(file), ALLOWED_EXT[path.extname(file)] || 'application/octet-stream', e.attachment_name);
});
