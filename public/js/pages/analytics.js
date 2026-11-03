import { html, raw, mount, $, $$, state, get, post, put, qs, baseMoney, num, pct, fail, toast, setQuery, rangeControl, bindRange, can, money, fdate, badge, confirmDialog } from '../core.js';
import { chartLabels, analyticsQuery, kpiCards, bindKpiInfo, revenueChart, profitChart, ordersChart, collectedChart, outstandingChart, fxNote, hbars, drawDonut, drawBars, drawLine } from '../analytics-view.js';

export default async function (view, q) {
  q.range ||= 'this_month'; q.compare ||= 'prev'; q.tab ||= 'charts';
  mount(view, html`<div class="page-head"><div class="grow"><h1>Sales Analytics</h1><p>Trends, product and customer performance, plus recommendations drawn from your own data.</p></div><div class="toolbar" id="rc">${rangeControl(q, { compare: true })}</div></div>
    <div class="tabs" id="tabs"><button data-t="charts">Charts</button><button data-t="reco">Recommendations</button><button data-t="defs">How KPIs are calculated</button></div><div id="body"></div>`);
  const tabs = () => $$('#tabs button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === q.tab));
  const load = async () => { setQuery(q); tabs(); $('#rc', view).hidden = q.tab !== 'charts'; ({ charts, reco, defs }[q.tab] || charts)($('#body', view)); };
  $('#tabs', view).onclick = (e) => { const t = e.target.dataset.t; if (t) { q.tab = t; load(); } };
  bindRange($('#rc', view), q, load); await load();

  async function charts(body) {
    mount(body, html`<div class="loading">Loading…</div>`);
    try {
      const d = await get('/api/analytics' + qs(analyticsQuery(q))); const cur = (v) => money(v);
      mount(body, html`${kpiCards(d)}${d.compare ? html`<div class="card" style="margin-bottom:14px"><h2>Period comparison</h2>${comparison(d)}</div>` : ''}
        <div class="grid g2">
          <div class="card"><h2>Revenue over time</h2><div id="c1"></div></div><div class="card"><h2>Profit over time</h2><div id="c2"></div></div>
          <div class="card"><h2>Orders over time</h2><div id="c3"></div></div><div class="card"><h2>Payments collected over time</h2><div id="c4"></div></div>
          <div class="card"><h2>Outstanding balances over time</h2><div id="c5"></div></div><div class="card"><h2>Sales by product</h2>${hbars(d.products.slice(0, 10).map((p) => ({ name: p.name, value: p.revenue, href: p.id ? `#/orders?product_id=${p.id}&recognized=1&from=${d.range.from}&to=${d.range.to}` : undefined })), cur)}</div>
          <div class="card"><h2>Sales by category</h2><div id="c7"></div></div><div class="card"><h2>Sales by customer</h2>${hbars(d.customers.slice(0, 10).map((c) => ({ name: c.name, value: c.revenue, sub: c.orders + ' orders', href: `#/customers?open=${c.id}` })), cur, { color: 'var(--s3)' })}</div>
          <div class="card"><h2>New vs returning customers</h2><div id="c9"></div></div><div class="card"><h2>Monthly customer retention</h2><div id="c10"></div></div>
          <div class="card"><h2>Best-selling products (units)</h2>${hbars(d.best_sellers.map((p) => ({ name: p.name, value: p.units })), (v) => num(v, 1) + ' units', { color: 'var(--s7)' })}</div>
          <div class="card"><h2>Expense breakdown</h2><div id="c12"></div></div>
          <div class="card"><h2>Revenue by weekday</h2><div id="c13"></div></div><div class="card"><h2>Revenue by customer group</h2>${hbars(d.customer_groups.map((g) => ({ name: g.name, value: g.revenue, sub: g.customers + ' customers' })), cur, { color: 'var(--s5)' })}</div>
        </div>${fxNote(d)}`);
      revenueChart($('#c1'), d); profitChart($('#c2'), d); ordersChart($('#c3'), d); collectedChart($('#c4'), d); outstandingChart($('#c5'), d);
      drawDonut($('#c7'), { items: d.categories.map((c) => ({ name: c.name, value: c.revenue })), fmt: cur, title: 'Sales by category' });
      drawBars($('#c9'), { labels: chartLabels(d), series: [{ name: 'New customers', data: d.series.new_customers }, { name: 'Returning customers', data: d.series.returning_customers }], fmt: (v) => num(v) });
      drawLine($('#c10'), { labels: d.monthly_retention.map((m) => m.month), series: [{ name: 'Retention %', data: d.monthly_retention.map((m) => (m.rate == null ? null : m.rate * 100)) }], fmt: (v) => pct(v / 100) });
      if (d.expenses.length || state.user.permissions.includes('finance:read')) drawDonut($('#c12'), { items: d.expenses.map((e) => ({ name: e.name, value: e.total })), fmt: cur, title: 'Expense breakdown' }); else $('#c12').innerHTML = '<div class="empty">Restricted</div>';
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; drawBars($('#c13'), { labels: names, series: [{ name: 'Revenue', data: names.map((_, i) => d.weekday.find((w) => w.wd === i)?.revenue || 0) }], fmt: cur });
      bindKpiInfo(body);
    } catch (e) { mount(body, html`<div class="alert bad">${e.message}</div>`); }
  }

  const comparison = (d) => {
    const rows = [['Revenue', 'revenue'], ['Collected', 'collected'], ['Product costs', 'product_costs', 1], ['Operating expenses', 'opex', 1], ['Gross profit', 'gross_profit'], ['Net profit', 'net_profit'], ['Orders', 'total_orders', 0, 1], ['Avg order value', 'avg_order_value']].filter(([, k]) => d.kpis[k] !== undefined);
    return html`<div class="table-wrap"><table><thead><tr><th></th><th class="right">${d.range.label}</th><th class="right">${d.compare.range.label}</th><th class="right">Change</th></tr></thead><tbody>${rows.map(([l, k, inv, cnt]) => { const c = d.kpis[k], p = d.compare.kpis[k]; const ch = p ? ((c - p) / Math.abs(p)) * 100 : null; const good = ch == null ? '' : (inv ? ch < 0 : ch > 0) ? 'good' : 'bad'; return html`<tr><td>${l}</td><td class="right mono">${cnt ? num(c) : baseMoney(c)}</td><td class="right mono">${cnt ? num(p) : baseMoney(p)}</td><td class="right mono ${good}">${ch == null ? 'n/a' : (ch > 0 ? '+' : '') + ch.toFixed(1) + '%'}</td></tr>`; })}</tbody></table></div>`;
  };

  async function defs(body) {
    const d = await get('/api/kpi-definitions').catch(fail); if (!d) return;
    mount(body, html`<div class="card"><p class="muted">Every figure in the dashboard follows these rules. Rules that depend on settings reflect your current configuration.</p>${d.map((x) => html`<div style="padding:10px 0;border-top:1px solid var(--border)"><b>${x.name}</b><div>${x.formula}</div>${x.note ? html`<div class="muted small">${x.note}</div>` : ''}</div>`)}</div>`);
  }

  async function reco(body) {
    mount(body, html`<div class="loading">Analysing your data…</div>`);
    const r = await get('/api/recommendations').catch(fail); if (!r) return;
    const show = q.rstatus || 'new';
    const rows = r.rows.filter((x) => x.status === show);
    mount(body, html`<div class="toolbar"><div class="seg" id="rs">${['new', 'scheduled', 'completed', 'ignored'].map((s) => html`<button data-s="${s}" class="${show === s ? 'on' : ''}">${s.charAt(0).toUpperCase() + s.slice(1)} (${r.counts[s] || 0})</button>`)}</div><span class="grow"></span>
      <button class="btn" id="refresh">↻ Re-analyse</button><button class="btn" id="ai" ${raw(r.ai_available ? '' : 'disabled title="Set ANTHROPIC_API_KEY on the server to enable AI analysis"')}>✨ AI analysis</button></div>
      <p class="small muted">Rule-based recommendations calculated from your orders, payments, stock and customers. Expected benefits are <b>estimates</b> with the assumption shown.</p>
      ${rows.length ? rows.map((x) => html`<div class="card rec p${x.priority}" style="margin-bottom:12px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="badge info">${x.category}</span>${x.priority === 1 ? html`<span class="badge bad">High priority</span>` : ''}<h2 style="margin:0">${x.title}</h2></div>
        <dl><dt>Detected</dt><dd style="white-space:pre-wrap">${x.detected}</dd><dt>Why it matters</dt><dd>${x.why}</dd><dt>Suggested action</dt><dd>${x.action}</dd>${x.benefit ? html`<dt>Expected benefit</dt><dd><b>${x.benefit}</b><div class="muted small">${x.benefit_basis}</div></dd>` : ''}</dl>
        ${x.data ? html`<details class="small"><summary class="muted" style="cursor:pointer">Supporting data</summary><pre style="white-space:pre-wrap;overflow:auto;max-height:200px">${JSON.stringify(x.data, null, 2)}</pre></details>` : ''}
        <div class="toolbar" style="margin:8px 0 0">${x.link ? html`<a class="btn sm primary" href="${x.link}">Take action</a>` : ''}
          ${x.status !== 'completed' ? html`<button class="btn sm" data-a="completed" data-id="${x.id}">✓ Mark completed</button>` : ''}${x.status !== 'scheduled' ? html`<button class="btn sm" data-a="scheduled" data-id="${x.id}">🗓 Schedule</button>` : ''}${x.status !== 'ignored' ? html`<button class="btn sm ghost" data-a="ignored" data-id="${x.id}">Ignore</button>` : html`<button class="btn sm" data-a="new" data-id="${x.id}">Restore</button>`}
          ${x.scheduled_for ? html`<span class="muted small">Scheduled for ${x.scheduled_for}</span>` : ''}</div></div>`) : html`<div class="card empty"><b>Nothing here</b>${show === 'new' ? 'No open recommendations. As you record more orders, payments and stock movements, insights will appear.' : 'No recommendations with this status.'}</div>`}`);
    $('#rs', body).onclick = (e) => { if (e.target.dataset.s) { q.rstatus = e.target.dataset.s; load(); } };
    $('#refresh', body).onclick = async () => { await post('/api/recommendations/refresh').catch(fail); load(); };
    $('#ai', body).onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Analysing…'; try { await post('/api/recommendations/ai'); toast('AI analysis added', 'success'); load(); } catch (er) { fail(er); load(); } };
    body.onclick = async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return; const status = b.dataset.a; let scheduled_for;
      if (status === 'scheduled') { const { formModal } = await import('../core.js'); return formModal({ title: 'Schedule this action', fields: [{ name: 'scheduled_for', label: 'Remind me on', type: 'date', required: true, value: state.boot.today }], onSubmit: async (v) => { await put(`/api/recommendations/${b.dataset.id}`, { status, scheduled_for: v.scheduled_for }); load(); } }); }
      await put(`/api/recommendations/${b.dataset.id}`, { status, scheduled_for }).catch(fail); load();
    };
  }
}
