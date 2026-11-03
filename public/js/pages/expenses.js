import { html, raw, mount, $, $$, state, can, get, post, put, del, qs, money, baseMoney, fdate, badge, toast, fail, modal, formModal, confirmDialog, table, setQuery, debounce, today, rangeControl, bindRange, download } from '../core.js';
import { drawDonut } from '../charts.js';

export default async function (view, q) {
  q.range ||= 'this_month'; const w = can('expenses:write');
  mount(view, html`<div class="page-head"><div class="grow"><h1>Expenses</h1><p>Operating costs: rent, salaries, utilities and more. Product costs are tracked on orders and stock instead.</p></div>${w ? html`<button class="btn primary" id="new">+ Add expense</button>` : ''}</div>
    <div class="toolbar"><input type="search" class="search" id="q" placeholder="Search description or code" value="${q.q || ''}"><select id="cat"><option value="">All categories</option>${state.boot.settings.expense_categories.map((c) => html`<option ${raw(q.category === c ? 'selected' : '')}>${c}</option>`)}</select>
      <div id="rc" style="display:contents">${rangeControl(q)}</div><label class="small"><input type="checkbox" id="rec" ${raw(q.recurring ? 'checked' : '')}> Recurring only</label><span class="grow"></span><button class="btn sm" id="xl">⬇ Export</button></div><div id="body"></div>`);
  $('#new', view)?.addEventListener('click', () => expenseForm(null, load));
  const range = () => { if (q.range === 'custom') return { from: q.from, to: q.to }; return null; };
  async function load() {
    setQuery(q); const body = $('#body', view); body.innerHTML = '<div class="loading">Loading…</div>';
    let from = q.from, to = q.to;
    if (q.range !== 'custom' && !(q.from && q.to && !q.range)) { const a = await get('/api/analytics?range=' + q.range + '&compare=none').catch(() => null); if (a) { from = a.range.from; to = a.range.to; } }
    const r = await get('/api/expenses' + qs({ q: q.q, category: q.category, recurring: q.recurring, from, to, limit: 300 })).catch(fail); if (!r) return;
    mount(body, html`<div class="grid g2" style="margin-bottom:14px"><div class="kpi"><div class="l">Total expenses (${from} → ${to})</div><div class="v">${baseMoney(r.summary.total_base)}</div><div class="d muted small">${r.summary.count} records, converted to ${state.boot.settings.base_currency} at each expense's recorded rate</div></div><div class="card"><div id="dn"></div></div></div>
      <div class="card flush">${table([{ label: 'Expense', render: (e) => html`<b>${e.code}</b>${e.recurring ? html` <span class="badge info">${e.recurring_active ? '↻ ' : ''}${e.recurring}</span>` : ''}${e.parent_id ? html` <span class="badge">auto</span>` : ''}` }, { label: 'Date', render: (e) => fdate(e.paid_at) }, { label: 'Category', render: (e) => e.category }, { label: 'Description', render: (e) => e.description }, { label: 'Method', render: (e) => e.method },
        { label: 'Amount', class: 'right mono', render: (e) => html`<b>${money(e.amount, e.currency)}</b>${e.currency !== state.boot.settings.base_currency ? html`<div class="muted small">≈ ${baseMoney(e.amount_base)}</div>` : ''}` }, { label: '', render: (e) => html`${e.has_attachment ? html`<a href="/api/expenses/${e.id}/attachment" title="${e.attachment_name}">📎</a> ` : ''}${w ? html`<button class="btn sm ghost" data-ed="${e.id}">Edit</button><button class="btn sm ghost danger" data-del="${e.id}">✕</button>` : ''}` }], r.rows, { empty: 'No expenses in this period', emptyHint: 'Record rent, salaries and other operating costs here.' })}</div>`);
    drawDonut($('#dn', body), { items: r.by_category.map((c) => ({ name: c.category, value: c.total_base })), fmt: baseMoney, title: 'By category' });
    body.onclick = async (e) => { const ed = e.target.closest('[data-ed]'); const dl = e.target.closest('[data-del]');
      if (ed) expenseForm(r.rows.find((x) => x.id == ed.dataset.ed), load);
      if (dl) { const reason = await confirmDialog({ title: 'Delete expense?', message: 'This removes it from profit calculations. The deletion is kept in the audit log.', confirmText: 'Delete', danger: true, input: 'Reason' }); if (reason) { try { await del(`/api/expenses/${dl.dataset.del}?reason=${encodeURIComponent(reason)}`); toast('Deleted', 'success'); load(); } catch (er) { fail(er); } } } };
  }
  $('#q', view).oninput = debounce((e) => { q.q = e.target.value; load(); }, 300); $('#cat', view).onchange = (e) => { q.category = e.target.value; load(); }; $('#rec', view).onchange = (e) => { q.recurring = e.target.checked ? '1' : ''; load(); };
  $('#xl', view).onclick = () => download(`/api/reports/expenses?format=xlsx&range=${q.range}${q.from ? `&from=${q.from}&to=${q.to}` : ''}`);
  bindRange($('#rc', view), q, load); void range; await load();
}

function expenseForm(e, onDone) {
  const s = state.boot.settings;
  const m = formModal({ title: e ? `Edit ${e.code}` : 'Add expense', size: 'wide', submitText: e ? 'Save changes' : 'Add expense', values: e || {}, fields: [
    { name: 'category', label: 'Category', type: 'select', options: s.expense_categories, required: true }, { name: 'paid_at', label: 'Date', type: 'date', value: today(), required: true },
    { name: 'amount', label: 'Amount', type: 'money', required: true }, { name: 'currency', label: 'Currency', type: 'select', options: s.currencies, value: s.base_currency }, { name: 'method', label: 'Paid by', type: 'select', options: s.payment_methods },
    ...(e?.parent_id ? [] : [{ name: 'recurring', label: 'Repeats', type: 'select', options: [['', 'One-off'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']], hint: 'Repeating expenses are added automatically' }]),
    { name: 'description', label: 'Description', required: true, full: true }, ...(e ? [{ name: 'reason', label: 'Reason for change (audit trail)', full: true }] : []),
  ], extra: html`<div class="field"><label>Attachment (receipt / invoice: PDF, PNG, JPG, max 5 MB)</label><input type="file" id="att" accept=".pdf,.png,.jpg,.jpeg,.webp"></div>`,
    onSubmit: async (v, key) => {
      const f = $('#att', m.body).files[0]; if (f) { if (f.size > 5 * 1024 * 1024) throw new Error('Attachment is larger than 5 MB'); v.attachment = { name: f.name, data_base64: await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(f); }) }; }
      e ? await put('/api/expenses/' + e.id, v) : await post('/api/expenses', v, { 'Idempotency-Key': key }); toast('Expense saved', 'success'); onDone?.(); window.dispatchEvent(new Event('notifications-changed'));
    } });
  return m;
}
