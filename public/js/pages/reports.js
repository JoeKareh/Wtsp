import { html, raw, mount, $, $$, state, can, get, qs, money, num, pct, fdate, toast, fail, table, rangeControl, bindRange, download, setQuery, today } from '../core.js';

export default async function (view, q) {
  q.range ||= 'this_month'; const list = await get('/api/reports'); q.key ||= list[0]?.key;
  mount(view, html`<div class="page-head"><div class="grow"><h1>Reports</h1><p>Preview on screen, then download as Excel, CSV or PDF.</p></div></div>
    <div class="toolbar"><select id="rk" aria-label="Report">${list.map((r) => html`<option value="${r.key}" ${raw(q.key === r.key ? 'selected' : '')}>${r.name}</option>`)}</select><div id="rc" style="display:contents">${rangeControl(q)}</div>
      <span id="flt" style="display:contents"></span><span class="grow"></span><button class="btn" data-f="xlsx">⬇ Excel</button><button class="btn" data-f="csv">⬇ CSV</button><button class="btn" data-f="pdf">⬇ PDF</button></div><div class="card flush" id="out"></div>`);
  const cur = () => list.find((r) => r.key === q.key);
  const params = () => ({ range: q.range, from: q.from, to: q.to, status: q.status, payment_status: q.payment_status });
  const load = async () => {
    setQuery(q); const r0 = cur(); if (!r0) return; $('#rc', view).hidden = r0.no_range; $('#rc', view).style.display = r0.no_range ? 'none' : 'contents';
    mount($('#flt', view), r0.filters.length ? html`${r0.filters.includes('status') ? html`<select id="fs"><option value="">Any status</option>${state.boot.statuses.map((s) => html`<option ${raw(q.status === s ? 'selected' : '')}>${s}</option>`)}</select>` : ''}${r0.filters.includes('payment_status') ? html`<select id="fp"><option value="">Any payment</option>${['Unpaid', 'Partially paid', 'Paid', 'Refunded'].map((s) => html`<option ${raw(q.payment_status === s ? 'selected' : '')}>${s}</option>`)}</select>` : ''}` : '');
    $('#fs', view)?.addEventListener('change', (e) => { q.status = e.target.value; load(); }); $('#fp', view)?.addEventListener('change', (e) => { q.payment_status = e.target.value; load(); });
    const out = $('#out', view); out.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const r = await get(`/api/reports/${q.key}` + qs(params())); const fmt = (c, v) => (v == null || v === '' ? '' : c.type === 'money' ? num(v / 100, 2) : c.type === 'pct' ? pct(v) : c.type === 'number' ? num(v, 2) : v);
      mount(out, html`<div style="padding:14px 16px"><h2 style="margin:0">${r.title}</h2><div class="muted small">${r.subtitle}</div></div>${table(r.columns.map((c) => ({ label: c.label, class: ['money', 'int', 'pct', 'number'].includes(c.type) ? 'right mono' : '', render: (row) => fmt(c, row[c.key]) })), r.rows, { empty: 'No data for this selection' })}
        ${r.truncated ? html`<div class="alert warn" style="margin:12px">Showing the first 2,000 of ${r.total_rows} rows. Download the file for everything.</div>` : ''}
        ${r.summary.length ? html`<div style="padding:12px 16px;border-top:1px solid var(--border)">${r.summary.map((s) => html`<div style="display:flex;gap:12px"><b style="min-width:230px">${s.label}</b><span class="mono">${s.type === 'money' ? num(s.value / 100, 2) : s.type === 'pct' ? pct(s.value) : num(s.value)}</span></div>`)}</div>` : ''}
        <div class="small muted" style="padding:10px 16px">${r.notes.join(' ')}</div>`);
    } catch (e) { mount(out, html`<div class="alert bad" style="margin:12px">${e.message}</div>`); }
  };
  $('#rk', view).onchange = (e) => { q.key = e.target.value; delete q.status; delete q.payment_status; load(); };
  $$('[data-f]', view).forEach((b) => b.addEventListener('click', () => { if (q.range === 'custom' && (!q.from || !q.to)) return toast('Choose a start and end date', 'error'); download(`/api/reports/${q.key}` + qs({ ...params(), format: b.dataset.f })); }));
  bindRange($('#rc', view), q, load); await load(); void today; void can; void fdate; void money; void fail;
}
