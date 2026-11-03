import { GET } from '../http.js';
import { all, get, allSettings, recognizedSql, recDateSql, recognizedStatuses } from '../db.js';
import { resolveRange, compareRange, todayStr, diffDays, escLike, date, oneOf } from '../util.js';

const PBASE = 'CAST(ROUND(p.amount*1.0/p.fx_rate) AS INTEGER)';
const EBASE = 'CAST(ROUND(e.amount*1.0/e.fx_rate) AS INTEGER)';

/**
 * Accrual P&L and cash flow for a period, all in the reporting (base) currency, each transaction converted at its own snapshot rate.
 *  - revenue/costs: recognised orders only (see settings.revenue_recognition), by recognition date
 *  - gross profit  = revenue - direct costs      (never revenue alone)
 *  - net profit    = gross profit - operating expenses
 *  - cash flow     = payments collected - refunds - expenses paid   (unpaid orders are NOT cash)
 */
export function periodFinancials(from, to) {
  const rec = recognizedSql('o'); const rd = recDateSql('o');
  const o = get(`SELECT COUNT(*) orders, COALESCE(SUM(revenue_base),0) revenue, COALESCE(SUM(cost_base),0) direct_costs,
      COALESCE(SUM(CAST(ROUND(tax*1.0/fx_rate) AS INTEGER)),0) tax FROM v_orders_fin o WHERE ${rec} AND ${rd} BETWEEN ? AND ?`, from, to);
  const opex = get(`SELECT COALESCE(SUM(${EBASE}),0) v, COUNT(*) n FROM expenses e WHERE paid_at BETWEEN ? AND ?`, from, to);
  const pay = get(`SELECT COALESCE(SUM(CASE WHEN type='payment' THEN ${PBASE} END),0) collected, COALESCE(SUM(CASE WHEN type='refund' THEN ${PBASE} END),0) refunds, COUNT(*) n
      FROM payments p WHERE voided=0 AND paid_at BETWEEN ? AND ?`, from, to);
  const gross = o.revenue - o.direct_costs; const net = gross - opex.v;
  const cashIn = pay.collected; const cashOut = pay.refunds + opex.v;
  const byCur = all(`SELECT currency, SUM(inflow) inflow, SUM(outflow) outflow FROM (
      SELECT currency, CASE WHEN type='payment' THEN amount ELSE 0 END inflow, CASE WHEN type='refund' THEN amount ELSE 0 END outflow FROM payments WHERE voided=0 AND paid_at BETWEEN ? AND ?
      UNION ALL SELECT currency, 0, amount FROM expenses WHERE paid_at BETWEEN ? AND ?) GROUP BY currency`, from, to, from, to);
  return {
    from, to, recognized_orders: o.orders, revenue: o.revenue, direct_costs: o.direct_costs, gross_profit: gross, gross_margin_pct: o.revenue ? (gross / o.revenue) * 100 : null,
    opex: opex.v, net_profit: net, net_margin_pct: o.revenue ? (net / o.revenue) * 100 : null, tax_collected_on_sales: o.tax,
    collected: pay.collected, refunds: pay.refunds, net_collected: pay.collected - pay.refunds,
    cash_in: cashIn, cash_out: cashOut, cash_flow: cashIn - cashOut,
    cash_by_currency: byCur,
  };
}

export function receivablesNow() {
  const r = get(`SELECT COALESCE(SUM(MAX(balance_base,0)),0) receivables, COALESCE(SUM(CASE WHEN balance<0 THEN -balance_base ELSE 0 END),0) customer_credit,
      COUNT(CASE WHEN balance>0 THEN 1 END) open_orders FROM v_orders_fin WHERE status NOT IN ('Draft')`);
  const pipeline = get(`SELECT COALESCE(SUM(due_base),0) v, COUNT(*) n FROM v_orders_fin o WHERE o.status NOT IN ('Draft','Cancelled','Returned') AND NOT (${recognizedSql('o')})`);
  return { ...r, pipeline_value: pipeline.v, pipeline_orders: pipeline.n };
}

export function fxSnapshot() {
  const st = allSettings();
  return {
    reporting_currency: st.base_currency,
    rates: st.currencies.filter((c) => c !== st.base_currency).map((c) => {
      const r = get('SELECT rate_per_base, effective_date FROM exchange_rates WHERE currency=? ORDER BY effective_date DESC, id DESC LIMIT 1', c);
      return { currency: c, rate_per_base: r?.rate_per_base ?? null, effective_date: r?.effective_date ?? null, text: r ? `1 ${st.base_currency} = ${r.rate_per_base.toLocaleString('en-US')} ${c}` : 'No rate configured' };
    }),
    note: 'Each transaction is converted to the reporting currency using the rate stored on that transaction when it was recorded.',
  };
}

GET('/api/finance/summary', { perm: 'finance:read' }, (ctx) => {
  const st = allSettings();
  const r = resolveRange(ctx.query, st.timezone);
  const cmp = ctx.query.compare && ctx.query.compare !== 'none' ? compareRange(r, ctx.query.compare) : null;
  return {
    range: r, current: periodFinancials(r.from, r.to), previous: cmp ? { range: cmp, ...periodFinancials(cmp.from, cmp.to) } : null,
    position: receivablesNow(), recognition_rule: st.revenue_recognition, fx: fxSnapshot(),
  };
});

GET('/api/finance/ledger', { perm: 'finance:read' }, (ctx) => {
  const q = ctx.query; const st = allSettings();
  const from = date(q.from, 'from') || '0000-01-01'; const to = date(q.to, 'to') || '9999-12-31';
  if (q.kind) oneOf(q.kind, 'kind', ['payment', 'refund', 'expense']);
  const parts = [];
  if (!q.kind || ['payment', 'refund'].includes(q.kind)) parts.push(`SELECT 'payment' src, p.id, p.code, p.type kind, p.paid_at date, c.name party, p.method, p.reference ref,
      CASE p.type WHEN 'payment' THEN 'in' ELSE 'out' END direction, p.amount, p.currency, p.fx_rate, ${PBASE} amount_base, p.voided, p.void_reason, p.notes
      FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.paid_at BETWEEN '${from}' AND '${to}' ${q.kind ? `AND p.type='${q.kind}'` : ''}`);
  if (!q.kind || q.kind === 'expense') parts.push(`SELECT 'expense', e.id, e.code, 'expense', e.paid_at, e.category, e.method, '', 'out', e.amount, e.currency, e.fx_rate, ${EBASE}, 0, NULL, e.description
      FROM expenses e WHERE e.paid_at BETWEEN '${from}' AND '${to}'`);
  const sql = `SELECT * FROM (${parts.join(' UNION ALL ')})`;
  const w = []; const p = [];
  if (q.q) { w.push("(code LIKE ? ESCAPE '\\' OR party LIKE ? ESCAPE '\\' OR ref LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')"); const l = `%${escLike(q.q)}%`; p.push(l, l, l, l); }
  if (q.direction) { w.push('direction=?'); p.push(q.direction); }
  if (q.currency) { w.push('currency=?'); p.push(q.currency); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Number(q.limit) || 100, 1000); const offset = Number(q.offset) || 0;
  return {
    reporting_currency: st.base_currency,
    totals: get(`SELECT COALESCE(SUM(CASE WHEN direction='in' AND voided=0 THEN amount_base END),0) inflow, COALESCE(SUM(CASE WHEN direction='out' AND voided=0 THEN amount_base END),0) outflow FROM (${sql}) ${where}`, ...p),
    rows: all(`SELECT * FROM (${sql}) ${where} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map((r) => ({ ...r, voided: !!r.voided })),
  };
});

GET('/api/finance/receivables', { perm: ['payments:read', 'finance:read'] }, () => {
  const st = allSettings(); const today = todayStr(st.timezone);
  const rows = all(`SELECT c.id customer_id, c.name, c.phone, f.id order_id, f.number, f.order_date, f.expected_date, f.currency, f.balance, f.balance_base
      FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id WHERE f.balance>0 AND f.status NOT IN ('Draft','Cancelled','Returned') ORDER BY f.order_date`);
  const cust = new Map(); const totals = { current: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0 };
  for (const r of rows) {
    const age = diffDays(r.order_date, today);
    const b = age <= 30 ? 'current' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90';
    const c = cust.get(r.customer_id) || { customer_id: r.customer_id, name: r.name, phone: r.phone, orders: 0, current: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0, oldest: r.order_date };
    c[b] += r.balance_base; c.total += r.balance_base; c.orders++; cust.set(r.customer_id, c);
    totals[b] += r.balance_base; totals.total += r.balance_base;
  }
  return { reporting_currency: st.base_currency, totals, customers: [...cust.values()].sort((a, b) => b.total - a.total), orders: rows.map((r) => ({ ...r, age_days: diffDays(r.order_date, today) })) };
});
