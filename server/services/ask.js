// "Ask your business": a natural-language question answered by an AI model that can ONLY call a small set of read-only, parameter-checked
// tools over this workspace's data. The model never writes SQL, never sees phone numbers/emails, and every tool re-checks the asking user's permissions.
// Metered per workspace (usage_counters 'ai_credits', 1 credit per question). Needs ANTHROPIC_API_KEY on the platform.
import { POST, GET } from '../http.js';
import { all, allSettings } from '../db.js';
import { config } from '../config.js';
import { hasPerm } from '../perms.js';
import { enforce, bump, requireFeature, remaining, hasFeature } from '../limits.js';
import { allow } from '../ratelimit.js';
import { tenantKey } from '../db.js';
import { periodFinancials, receivablesNow } from './finance.js';
import { inventoryInsights } from './inventory.js';
import { productWindow } from './recommendations.js';
import { customerSelect } from './customers.js';
import { HttpError, bad, todayStr, addDays } from '../util.js';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s));
const range = (i) => { const today = todayStr(allSettings().timezone); const to = isDate(i.to) ? i.to : today; const from = isDate(i.from) ? i.from : addDays(to, -29); if (from > to) throw bad('from is after to'); if ((Date.parse(to) - Date.parse(from)) / 864e5 > 800) throw bad('range too long'); return { from, to }; };
const need = (u, p) => { if (!hasPerm(u, p)) throw new HttpError(403, `You do not have permission to see this (${p}).`); };
const lim = (i, d = 10) => Math.max(1, Math.min(25, Number(i.limit) || d));
const mn = (c) => Math.round(c) / 100;   // tools return MAJOR units so the model never has to divide

const TOOLS = {
  sales_summary: { perm: 'finance:read', description: 'Revenue, direct costs, gross profit, expenses, net profit, cash collected and order count for a date range (YYYY-MM-DD). Defaults to the last 30 days.', schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    run: (i, u) => { need(u, 'finance:read'); const r = range(i); const f = periodFinancials(r.from, r.to); return { currency: allSettings().base_currency, ...r, orders: f.recognized_orders, revenue: mn(f.revenue), direct_costs: mn(f.direct_costs), gross_profit: mn(f.gross_profit), expenses: mn(f.opex), net_profit: mn(f.net_profit), cash_collected: mn(f.collected) }; } },
  top_products: { perm: 'orders:read', description: 'Best-selling products by revenue in a date range.', schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer' } } },
    run: (i, u) => { need(u, 'orders:read'); const r = range(i); return productWindow(r.from, r.to).sort((a, b) => b.revenue - a.revenue).slice(0, lim(i)).map((p) => ({ name: p.name, units: p.units, revenue: mn(p.revenue) })); } },
  top_customers: { perm: 'customers:read', description: 'Customers who spent the most (names and totals only), and how long since they last bought.', schema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: (i, u) => { need(u, 'customers:read'); return all(`SELECT name, total_orders, total_spent, outstanding, days_since_purchase, lifecycle FROM (${customerSelect()}) WHERE status<>'Archived' ORDER BY total_spent DESC LIMIT ?`, lim(i)).map((c) => ({ name: c.name, orders: c.total_orders, spent: mn(c.total_spent), still_owes: mn(c.outstanding), days_since_last_order: c.days_since_purchase, lifecycle: c.lifecycle })); } },
  who_owes_me: { perm: 'payments:read', description: 'Total receivables and the customers with the largest unpaid balances.', schema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: (i, u) => { need(u, 'payments:read'); const r = receivablesNow(); return { total_receivables: mn(r.receivables), open_orders: r.open_orders, customers: all(`SELECT name, outstanding FROM (${customerSelect()}) WHERE outstanding>0 ORDER BY outstanding DESC LIMIT ?`, lim(i)).map((c) => ({ name: c.name, owes: mn(c.outstanding) })) }; } },
  low_stock: { perm: 'products:read', description: 'Products that are out of stock, low, or at risk of running out, with days of cover.', schema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: (i, u) => { need(u, 'products:read'); return inventoryInsights().filter((p) => p.stock_state !== 'ok' || p.shortage_risk).slice(0, lim(i, 15)).map((p) => ({ name: p.name, quantity: p.quantity, state: p.stock_state, days_cover: p.days_cover, sold_last_30_days: p.sold_30d })); } },
  orders_by_status: { perm: 'orders:read', description: 'How many orders are in each status right now.', schema: { type: 'object', properties: {} },
    run: (i, u) => { need(u, 'orders:read'); return all('SELECT status, COUNT(*) n FROM orders GROUP BY status ORDER BY n DESC'); } },
};
const SYSTEM = (st) => `You are the business assistant inside BizControl for "${st.business_name}". Answer the owner's question about THEIR business using only the tools. Never invent numbers; if a tool does not cover the question, say what you cannot see. Amounts are in ${st.base_currency}. Be brief, concrete and practical (a few sentences or a short list). Answer in the same language as the question. Today is ${todayStr(st.timezone)}. If the user asks you to change data, explain that you can only read.`;

export async function ask(question, user, { fetchImpl = fetch } = {}) {
  const ai = config.ai(); const st = allSettings(); const used = []; const messages = [{ role: 'user', content: question }];
  const tools = Object.entries(TOOLS).filter(([, t]) => hasPerm(user, t.perm)).map(([name, t]) => ({ name, description: t.description, input_schema: t.schema }));
  for (let round = 0; round < 5; round++) {
    let res; try { res = await fetchImpl(`${ai.base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ model: ai.model, max_tokens: 900, system: SYSTEM(st), tools, messages }) }); }
    catch (e) { throw new HttpError(502, 'Could not reach the AI service. Please try again.'); }
    const j = await res.json().catch(() => ({})); if (!res.ok) throw new HttpError(502, 'The AI service returned an error. Please try again later.');
    if (j.stop_reason !== 'tool_use') return { answer: (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || 'I could not produce an answer.', tools_used: used };
    messages.push({ role: 'assistant', content: j.content });
    const results = (j.content || []).filter((c) => c.type === 'tool_use').map((c) => { let out; let err = false; try { const t = TOOLS[c.name]; if (!t || !hasPerm(user, t.perm)) throw new Error('Tool not available'); out = t.run(c.input && typeof c.input === 'object' ? c.input : {}, user); used.push(c.name); } catch (e) { out = { error: e.message }; err = true; } return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 12_000), ...(err ? { is_error: true } : {}) }; });
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That question needs too many steps. Try asking something narrower.', tools_used: used };
}

GET('/api/ai/status', { perm: 'analytics:read' }, () => ({ enabled: Boolean(config.ai().key), included: hasFeature('ai'), credits_left: Number.isFinite(remaining('ai_credits')) ? remaining('ai_credits') : null, examples: ['Who owes me money?', 'What were my best products this month?', 'How much profit did I make last month?', 'What should I reorder?'] }));
POST('/api/ai/ask', { perm: 'analytics:read' }, async (ctx) => {
  if (!config.ai().key) throw bad('The AI assistant is not enabled on this server.');
  requireFeature('ai', 'The AI assistant');
  const q = String(ctx.body.question || '').trim(); if (q.length < 3) throw bad('Type your question'); if (q.length > 500) throw bad('Please keep the question under 500 characters');
  if (!allow('ask:' + tenantKey() + ':' + ctx.user.id, 20, 3600e3)) throw new HttpError(429, 'You asked many questions in a short time. Please wait a little.');
  enforce('ai_credits', 1);
  const r = await ask(q, ctx.user); bump('ai_credits', 1);   // charged only when we got an answer
  return { ...r, credits_left: Number.isFinite(remaining('ai_credits')) ? remaining('ai_credits') : null };
});
