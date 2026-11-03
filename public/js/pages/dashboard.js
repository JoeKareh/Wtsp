import { html, raw, mount, $, $$, state, get, qs, baseMoney, num, fail, setQuery, rangeControl, bindRange, can, money, fdate, badge, post } from '../core.js';
import { analyticsQuery, kpiCards, bindKpiInfo, revenueChart, profitChart, ordersChart, collectedChart, outstandingChart, targetsCard, fxNote, hbars } from '../analytics-view.js';

export default async function (view, q) {
  q.range ||= 'this_month'; q.compare ||= 'prev';
  mount(view, html`<div class="page-head"><div class="grow"><h1>Dashboard</h1><p>How the business is doing, at a glance. Click any number to see the records behind it.</p></div>
    <div class="toolbar" id="rc">${rangeControl(q, { compare: true })}</div></div><div id="onb"></div><div id="body"><div class="loading">Loading…</div></div>`);
  import('./onboarding.js').then((m) => m.dashboardCard($('#onb', view)));
  const load = async () => {
    setQuery(q); const body = $('#body', view);
    try {
      const [d, attention] = await Promise.all([get('/api/analytics' + qs(analyticsQuery(q))), loadAttention()]);
      mount(body, html`<p class="muted small">${d.range.label}: ${d.range.from} → ${d.range.to}${d.compare ? html` · compared with ${d.compare.range.from} → ${d.compare.range.to}` : ''}</p>
        ${attention.length ? html`<div class="card" style="margin-bottom:14px"><h2>Needs attention</h2><div class="pill-list">${attention.map((a) => html`<a class="badge ${a.cls}" href="${a.href}">${a.text}</a>`)}</div></div>` : ''}
        ${kpiCards(d)}
        <div class="grid g2" style="margin-bottom:14px"><div class="card"><h2>Revenue over time</h2><div id="c1"></div></div><div class="card"><h2>Profit over time</h2><div id="c2"></div></div>
          <div class="card"><h2>Orders over time</h2><div id="c3"></div></div><div class="card"><h2>Payments collected</h2><div id="c4"></div></div></div>
        <div class="grid g2"><div class="card"><h2>Outstanding balances over time</h2><div id="c5"></div></div>
          <div class="card"><h2>Sales targets</h2>${targetsCard(d)}<h2 style="margin-top:18px">Best-selling products</h2>${hbars(d.best_sellers.slice(0, 5).map((p) => ({ name: p.name, value: p.units, href: p.id ? `#/orders?product_id=${p.id}&recognized=1&from=${d.range.from}&to=${d.range.to}` : undefined })), (v) => num(v, 1) + ' units')}</div></div>
        ${fxNote(d)}`);
      revenueChart($('#c1'), d); profitChart($('#c2'), d); ordersChart($('#c3'), d); collectedChart($('#c4'), d); outstandingChart($('#c5'), d);
      bindKpiInfo(body);
    } catch (e) { mount(body, html`<div class="alert bad">${e.message}</div>`); }
  };
  bindRange($('#rc', view), q, load); await load();
}

async function loadAttention() {
  const out = [];
  const jobs = [];
  if (state.user.permissions.includes('orders:read')) jobs.push(get('/api/orders/pending').then((p) => {
    if (p.counts.overdue) out.push({ cls: 'bad', text: `${p.counts.overdue} overdue order${p.counts.overdue > 1 ? 's' : ''}`, href: '#/orders?overdue=1' });
    if (p.counts.awaiting_confirmation) out.push({ cls: 'warn', text: `${p.counts.awaiting_confirmation} awaiting confirmation`, href: '#/orders?status=Pending' });
    if (p.counts.unpaid) out.push({ cls: 'warn', text: `${p.counts.unpaid} orders with unpaid balance`, href: '#/orders?unpaid=1' });
  }).catch(() => {}));
  if (state.user.permissions.includes('products:read')) jobs.push(get('/api/inventory/summary').then((s) => {
    if (s.totals.out) out.push({ cls: 'bad', text: `${s.totals.out} out of stock`, href: '#/products?stock=out' });
    if (s.totals.low) out.push({ cls: 'warn', text: `${s.totals.low} low on stock`, href: '#/products?stock=low' });
    if (s.totals.high) out.push({ cls: 'info', text: `${s.totals.high} above max stock`, href: '#/products?stock=high' });
  }).catch(() => {}));
  await Promise.all(jobs); return out;
}
