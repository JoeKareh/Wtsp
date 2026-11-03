import { html, raw, mount, $, $$, state, get, qs, baseMoney, num, pct, fail, modal, esc, setQuery, rangeControl, bindRange, can, money, fdate } from './core.js';
import { drawLine, drawBars, drawDonut, hbars, color } from './charts.js';

export function analyticsQuery(q) {
  const o = { range: q.range || 'this_month', compare: q.compare || 'prev' };
  if (o.range === 'custom') { o.from = q.from; o.to = q.to; }
  return o;
}

function delta(cur, prev, { inverse = false } = {}) {
  if (prev == null) return '';
  if (!prev) return cur ? html`<span class="muted">new</span>` : '';
  const p = ((cur - prev) / Math.abs(prev)) * 100; if (Math.abs(p) < 0.05) return html`<span class="muted">no change</span>`;
  const good = inverse ? p < 0 : p > 0;
  return html`<span class="${good ? 'good' : 'bad'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%</span> <span class="muted">vs prev</span>`;
}

/** KPI definitions list. Each card links to the underlying records. */
export function kpiCards(d) {
  const k = d.kpis; const p = d.compare?.kpis; const r = d.range; const rg = `from=${r.from}&to=${r.to}`;
  const fin = k.gross_profit !== undefined;
  const cards = [
    ['total_orders', 'Total orders', num(k.total_orders), `#/orders?${rg}`, p && delta(k.total_orders, p.total_orders)],
    ['pending_orders', 'Pending orders', num(k.pending_orders), `#/orders?status=Pending,Confirmed,Processing,Ready,Out for delivery&${rg}`],
    ['completed_orders', 'Completed orders', num(k.completed_orders), `#/orders?status=Delivered,Completed&${rg}`],
    ['cancelled_orders', 'Cancelled orders', num(k.cancelled_orders), `#/orders?status=Cancelled&${rg}`, p && delta(k.cancelled_orders, p.cancelled_orders, { inverse: true })],
    ['revenue', 'Sales revenue', baseMoney(k.revenue), `#/orders?recognized=1&${rg}`, p && delta(k.revenue, p.revenue)],
    ['collected', 'Collected payments', baseMoney(k.collected), `#/payments?${rg}`, p && delta(k.collected, p.collected)],
    ['outstanding', 'Outstanding balances', baseMoney(k.outstanding), `#/orders?unpaid=1`],
    fin && ['product_costs', 'Product costs', baseMoney(k.product_costs), `#/orders?recognized=1&${rg}`, p && delta(k.product_costs, p.product_costs, { inverse: true })],
    fin && ['opex', 'Operating expenses', baseMoney(k.opex), `#/expenses?${rg}`, p && delta(k.opex, p.opex, { inverse: true })],
    fin && ['gross_profit', 'Gross profit', baseMoney(k.gross_profit), `#/orders?recognized=1&${rg}`, p && delta(k.gross_profit, p.gross_profit)],
    fin && ['net_profit', 'Net profit', baseMoney(k.net_profit), `#/payments?tab=summary&${rg}`, p && delta(k.net_profit, p.net_profit)],
    fin && ['cash_flow', 'Cash flow', baseMoney(k.cash_flow), `#/payments?tab=ledger&${rg}`],
    ['avg_order_value', 'Avg order value', baseMoney(k.avg_order_value), `#/orders?recognized=1&${rg}`, p && delta(k.avg_order_value, p.avg_order_value)],
    ['active_customers', 'Active customers', num(k.active_customers), '#/customers?lifecycle=Active'],
    ['inactive_customers', 'Inactive customers', num(k.inactive_customers), '#/customers?lifecycle=Inactive'],
    ['retention', 'Customer retention', k.retention.rate == null ? 'n/a' : pct(k.retention.rate), '#/customers', null, k.retention.rate == null ? 'No customers in previous period' : `${k.retention.retained} of ${k.retention.base} returned`],
  ].filter(Boolean);
  return html`<div class="kpis">${cards.map(([key, label, val, href, dl, sub]) => html`<a class="kpi" href="${href}" title="Click to see the underlying records"><div class="l"><span>${label}</span><button class="info-btn" data-kpi="${key}" aria-label="How is ${label} calculated?">i</button></div><div class="v">${val}</div><div class="d">${dl || ''}${sub ? html`<span class="muted">${sub}</span>` : ''}</div></a>`)}</div>`;
}
export function bindKpiInfo(root) {
  $$('[data-kpi]', root).forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const defs = await get('/api/kpi-definitions').catch(fail); if (!defs) return;
    const d = defs.find((x) => x.key === b.dataset.kpi); if (!d) return;
    modal({ title: d.name, body: html`<p><b>Formula</b><br>${d.formula}</p>${d.note ? html`<p class="muted">${d.note}</p>` : ''}`, footer: false });
  }));
}

const f = (v) => money(v);
/** month buckets are labelled YYYY-MM; day/week buckets keep the full date (axis shows MM-DD, tooltip the full date) */
export const chartLabels = (d) => (d.bucket === 'month' ? d.labels.map((l) => l.slice(0, 7)) : d.labels);
export function revenueChart(el, d) {
  const series = [{ name: 'Revenue', data: d.series.revenue.map((v) => v / 1), area: true }];
  if (d.compare) series.push({ name: d.compare.range.label, data: d.compare.series.revenue, dashed: true, color: 'var(--muted)' });
  drawLine(el, { labels: chartLabels(d), series, fmt: f, title: 'Revenue over time' });
}
export function profitChart(el, d) {
  if (d.series.gross_profit === undefined) { el.innerHTML = '<div class="empty">Profit data is restricted for your role</div>'; return; }
  drawLine(el, { labels: chartLabels(d), series: [{ name: 'Gross profit', data: d.series.gross_profit }, { name: 'Net profit', data: d.series.net_profit }], fmt: f, title: 'Profit over time' });
}
export const ordersChart = (el, d) => drawBars(el, { labels: chartLabels(d), series: [{ name: 'Orders', data: d.series.orders, ...(d.compare ? {} : {}) }, ...(d.compare ? [{ name: d.compare.range.label, data: d.compare.series.orders, color: 'var(--muted)' }] : [])], fmt: (v) => num(v), title: 'Orders over time' });
export const collectedChart = (el, d) => drawLine(el, { labels: chartLabels(d), series: [{ name: 'Collected', data: d.series.collected, area: true, color: 'var(--s3)' }, ...(d.compare ? [{ name: d.compare.range.label, data: d.compare.series.collected, dashed: true, color: 'var(--muted)' }] : [])], fmt: f, title: 'Payments collected' });
export const outstandingChart = (el, d) => drawLine(el, { labels: chartLabels(d), series: [{ name: 'Outstanding balances', data: d.series.outstanding, color: 'var(--s2)', area: true }], fmt: f, title: 'Outstanding balances over time' });

export function targetsCard(d) {
  const t = d.targets; const rows = [['Today', t.daily], ['This month', t.monthly]].filter(([, x]) => x.target > 0);
  if (!rows.length) return html`<p class="muted">No sales targets set. Add daily/monthly targets in Settings → Targets to track progress and get alerts.</p>`;
  return html`${rows.map(([l, x]) => html`<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between"><b>${l}</b><span class="mono">${baseMoney(x.actual)} / ${baseMoney(x.target)}</span></div><div class="progress" role="progressbar" aria-valuenow="${Math.round((x.actual / x.target) * 100)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${Math.min(100, (x.actual / x.target) * 100)}%;background:${x.actual >= x.target ? 'var(--good)' : 'var(--brand)'}"></div></div><div class="small muted">${pct((x.actual / x.target) * 100, 0)} of target${x.actual >= x.target ? ' · reached 🎉' : ''}</div></div>`)}`;
}
export function fxNote(d) {
  return html`<p class="small muted">All amounts are in <b>${d.fx.reporting_currency}</b> (reporting currency). ${d.fx.rates.map((r) => r.text).join(' · ')}. Each transaction uses the rate recorded when it was made. Revenue recognised when orders are <b>${{ confirmed: 'confirmed', delivered: 'delivered', completed: 'completed' }[d.recognition_rule]}</b>.</p>`;
}
export { hbars, drawDonut, drawBars, drawLine, color };
