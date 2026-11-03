import { html, raw, mount, $, $$, state, can, get, post, put, qs, money, baseMoney, num, pct, fdate, fdt, badge, toast, fail, modal, formModal, confirmDialog, table, pager, setQuery, debounce, toCents, fromCents, idemKey, today, rangeControl, bindRange, download, esc } from '../core.js';
import { chatBtn } from '../chat.js';
import { customerPicker } from '../pickers.js';
import { drawBars } from '../charts.js';

const LIMIT = 50;
export default async function (view, q) {
  const fin = can('finance:read'); const pr = can('payments:read');
  q.tab ||= pr ? 'payments' : 'summary'; q.range ||= 'this_month'; q.offset = Number(q.offset) || 0;
  const tabs = [pr && ['payments', 'Payments'], pr && ['receivables', 'Receivables'], fin && ['summary', 'Profit vs cash'], fin && ['ledger', 'Transaction ledger']].filter(Boolean);
  mount(view, html`<div class="page-head"><div class="grow"><h1>Payments & Finances</h1><p>Money received, money owed, and how profit differs from cash.</p></div>${can('payments:write') ? html`<button class="btn primary" id="new">+ Record payment</button>` : ''}</div>
    <div class="tabs" id="tabs">${tabs.map(([k, l]) => html`<button data-t="${k}">${l}</button>`)}</div><div id="body"></div>`);
  $('#new', view)?.addEventListener('click', () => paymentForm({}, load));
  $('#tabs', view).onclick = (e) => { if (e.target.dataset.t) { q.tab = e.target.dataset.t; q.offset = 0; load(); } };
  async function load() { setQuery(q); $$('#tabs button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === q.tab)); await ({ payments, receivables, summary, ledger }[q.tab] || payments)($('#body', view)); }

  async function payments(body) {
    mount(body, html`<div class="toolbar"><input type="search" class="search" id="q" placeholder="Search code, reference, customer name or phone" value="${q.q || ''}"><select id="m"><option value="">All methods</option>${state.boot.settings.payment_methods.map((m) => html`<option ${raw(q.method === m ? 'selected' : '')}>${m}</option>`)}</select>
      <select id="t"><option value="">Payments & refunds</option><option value="payment" ${raw(q.type === 'payment' ? 'selected' : '')}>Payments only</option><option value="refund" ${raw(q.type === 'refund' ? 'selected' : '')}>Refunds only</option></select>
      <input type="date" id="from" value="${q.from || ''}" aria-label="From"><input type="date" id="to" value="${q.to || ''}" aria-label="To"><label class="small"><input type="checkbox" id="vd" ${raw(q.voided ? 'checked' : '')}> Show voided</label><span class="grow"></span><button class="btn sm" id="csv">⬇ Export</button></div><div class="card flush" id="tbl"></div>`);
    const draw = async () => {
      setQuery(q);
      const r = await get('/api/payments' + qs({ q: q.q, method: q.method, type: q.type, from: q.from, to: q.to, voided: q.voided, customer_id: q.customer_id, limit: LIMIT, offset: q.offset }));
      mount($('#tbl', body), html`${table([{ label: 'Payment', render: (p) => html`<b>${p.code}</b>${p.voided ? html` <span class="badge bad">voided</span>` : ''}${p.type === 'refund' ? html` <span class="badge warn">refund</span>` : ''}` }, { label: 'Date', render: (p) => fdate(p.paid_at) }, { label: 'Customer', render: (p) => p.customer_name }, { label: 'Orders', render: (p) => html`<span class="small">${p.orders || (p.unallocated ? 'credit' : '–')}</span>` },
        { label: 'Method', render: (p) => p.method }, { label: 'Amount', class: 'right mono', render: (p) => html`<b class="${p.type === 'refund' ? 'bad' : ''}">${p.type === 'refund' ? '−' : ''}${money(p.amount, p.currency)}</b>${p.currency !== state.boot.settings.base_currency ? html`<div class="muted small">≈ ${baseMoney(p.amount_base)}</div>` : ''}` }, { label: 'Unallocated', class: 'right mono', render: (p) => (p.unallocated && !p.voided ? html`<span class="warn">${money(p.unallocated, p.currency)}</span>` : '–') }], r.rows, { rowAttr: true, empty: 'No payments found' })}
        <div class="pager"><b>${r.summary.count} records</b><span>· Net received ${baseMoney(r.summary.net_base)} (${state.boot.settings.base_currency})</span></div>${pager(r.summary.count, q.offset, LIMIT)}`);
      $('#tbl', body).onclick = (e) => { const pg = e.target.closest('[data-page]'); if (pg) { q.offset = Number(pg.dataset.page) * LIMIT; return draw(); } const tr = e.target.closest('tr[data-row]'); if (tr) openPayment(r.rows[Number(tr.dataset.row)].id, draw); };
    };
    $('#q', body).oninput = debounce((e) => { q.q = e.target.value; q.offset = 0; draw(); }, 300);
    for (const [id, k] of [['#m', 'method'], ['#t', 'type'], ['#from', 'from'], ['#to', 'to']]) $(id, body).onchange = (e) => { q[k] = e.target.value; q.offset = 0; draw(); };
    $('#vd', body).onchange = (e) => { q.voided = e.target.checked ? '1' : ''; draw(); };
    $('#csv', body).onclick = () => download(`/api/reports/payments?format=xlsx&range=custom&from=${q.from || '2000-01-01'}&to=${q.to || today()}`);
    await draw();
  }

  async function receivables(body) {
    const r = await get('/api/finance/receivables'); const t = r.totals;
    mount(body, html`<div class="kpis"><div class="kpi"><div class="l">Total outstanding</div><div class="v bad">${baseMoney(t.total)}</div></div><div class="kpi"><div class="l">0–30 days</div><div class="v">${baseMoney(t.current)}</div></div><div class="kpi"><div class="l">31–60 days</div><div class="v">${baseMoney(t.d31_60)}</div></div><div class="kpi"><div class="l">61–90 days</div><div class="v warn">${baseMoney(t.d61_90)}</div></div><div class="kpi"><div class="l">Over 90 days</div><div class="v bad">${baseMoney(t.d90)}</div></div></div>
      <p class="small muted">Age is measured from the order date. Amounts in ${r.reporting_currency}. Cancelled, returned and draft orders never appear here.</p>
      <div class="card flush">${table([{ label: 'Customer', render: (c) => html`<b>${c.name}</b><div class="muted small">${c.phone}</div>` }, { label: 'Open orders', class: 'right', render: (c) => c.orders }, { label: 'Oldest', render: (c) => fdate(c.oldest) }, { label: '0–30', class: 'right mono', render: (c) => (c.current ? baseMoney(c.current) : '') }, { label: '31–60', class: 'right mono', render: (c) => (c.d31_60 ? baseMoney(c.d31_60) : '') }, { label: '61–90', class: 'right mono', render: (c) => (c.d61_90 ? baseMoney(c.d61_90) : '') }, { label: '90+', class: 'right mono', render: (c) => (c.d90 ? html`<b class="bad">${baseMoney(c.d90)}</b>` : '') }, { label: 'Total', class: 'right mono', render: (c) => html`<b>${baseMoney(c.total)}</b>` },
        { label: '', render: (c) => html`${chatBtn({ customer: c.customer_id, purpose: 'payment_reminder' }, 'Remind', 'btn sm')} ${can('payments:write') ? html`<button class="btn sm primary" data-pay="${c.customer_id}">Collect</button>` : ''}` }], r.customers, { rowAttr: true, empty: 'Nobody owes you anything 🎉' })}</div>`);
    body.onclick = (e) => { const b = e.target.closest('[data-pay]'); if (b) { e.stopPropagation(); const c = r.customers.find((x) => x.customer_id == b.dataset.pay); return paymentForm({ customer: { id: c.customer_id, name: c.name, phone: c.phone } }, load); } const tr = e.target.closest('tr[data-row]'); if (tr) location.hash = `#/customers?open=${r.customers[Number(tr.dataset.row)].customer_id}`; };
  }

  async function summary(body) {
    mount(body, html`<div class="toolbar" id="rc">${rangeControl(q, { compare: true })}</div><div id="sum"><div class="loading">Loading…</div></div>`);
    const draw = async () => {
      setQuery(q);
      const s = await get('/api/finance/summary' + qs({ range: q.range, from: q.from, to: q.to, compare: q.compare || 'prev' })).catch(fail); if (!s) return;
      const c = s.current; const p = s.previous; const row = (l, v, pv, { bold, neg, hint } = {}) => html`<tr><td>${bold ? html`<b>${l}</b>` : l}${hint ? html`<div class="muted small">${hint}</div>` : ''}</td><td class="right mono">${bold ? html`<b>${baseMoney(v)}</b>` : baseMoney(v)}</td>${p ? html`<td class="right mono muted">${baseMoney(pv)}</td>` : ''}</tr>`;
      mount($('#sum', body), html`<p class="muted small">${s.range.from} → ${s.range.to}. Reporting currency ${s.fx.reporting_currency}. Revenue is recognised when orders are <b>${s.recognition_rule}</b>.</p>
        <div class="grid g2"><div class="card"><h2>Accounting profit (accrual)</h2><table><thead><tr><th></th><th class="right">${s.range.label}</th>${p ? html`<th class="right">${p.range.label}</th>` : ''}</tr></thead><tbody>
          ${row('Sales revenue', c.revenue, p?.revenue, { hint: `${c.recognized_orders} recognised orders. Includes unpaid orders.` })}${row('− Direct product costs', c.direct_costs, p?.direct_costs)}${row('Gross profit', c.gross_profit, p?.gross_profit, { bold: true, hint: c.gross_margin_pct != null ? `${pct(c.gross_margin_pct)} margin` : '' })}${row('− Operating expenses', c.opex, p?.opex)}${row('Net profit', c.net_profit, p?.net_profit, { bold: true, hint: c.net_margin_pct != null ? `${pct(c.net_margin_pct)} margin` : '' })}</tbody></table></div>
        <div class="card"><h2>Cash flow (money actually moved)</h2><table><thead><tr><th></th><th class="right">${s.range.label}</th>${p ? html`<th class="right">${p.range.label}</th>` : ''}</tr></thead><tbody>
          ${row('Payments received', c.collected, p?.collected, { hint: 'Voided payments are excluded; each payment counted once' })}${row('− Refunds paid', c.refunds, p?.refunds)}${row('− Expenses paid', c.opex, p?.opex)}${row('Net cash flow', c.cash_flow, p?.cash_flow, { bold: true })}</tbody></table></div></div>
        <div class="card" style="margin-top:14px"><h2>Why profit ≠ cash</h2><div class="kpis" style="margin-bottom:8px"><div class="kpi"><div class="l">Customers still owe you</div><div class="v bad">${baseMoney(s.position.receivables)}</div><div class="d muted small">${s.position.open_orders} open ${s.position.open_orders === 1 ? 'order' : 'orders'}: counted as revenue, not yet cash</div></div><div class="kpi"><div class="l">Customer credit held</div><div class="v">${baseMoney(s.position.customer_credit)}</div><div class="d muted small">paid for cancelled/returned orders, to refund or reuse</div></div><div class="kpi"><div class="l">Orders in progress</div><div class="v">${baseMoney(s.position.pipeline_value)}</div><div class="d muted small">${s.position.pipeline_orders} ${s.position.pipeline_orders === 1 ? 'order' : 'orders'} not yet recognised as revenue</div></div></div>
          <p class="small muted">Net profit shows what the business earned under the recognition rule; net cash flow shows what actually came in and went out. Stock purchases are not in either unless you record them as expenses.</p></div>
        ${c.cash_by_currency.length ? html`<div class="card" style="margin-top:14px"><h2>Cash by currency (not converted)</h2>${table([{ label: 'Currency', render: (x) => x.currency }, { label: 'Received/inflow', class: 'right mono', render: (x) => money(x.inflow, x.currency) }, { label: 'Refunds + expenses', class: 'right mono', render: (x) => money(x.outflow, x.currency) }, { label: 'Net', class: 'right mono', render: (x) => html`<b>${money(x.inflow - x.outflow, x.currency)}</b>` }], c.cash_by_currency)}<p class="small muted">${s.fx.rates.map((r) => r.text).join(' · ')}. ${s.fx.note}</p></div>` : ''}`);
    };
    bindRange($('#rc', body), q, draw); await draw();
  }

  async function ledger(body) {
    mount(body, html`<div class="toolbar"><input type="search" class="search" id="q" placeholder="Search code, party, reference" value="${q.q || ''}"><select id="k"><option value="">All transactions</option><option value="payment" ${raw(q.kind === 'payment' ? 'selected' : '')}>Payments in</option><option value="refund" ${raw(q.kind === 'refund' ? 'selected' : '')}>Refunds out</option><option value="expense" ${raw(q.kind === 'expense' ? 'selected' : '')}>Expenses out</option></select><input type="date" id="from" value="${q.from || ''}"><input type="date" id="to" value="${q.to || ''}"></div><div class="card flush" id="tbl"></div>`);
    const draw = async () => {
      setQuery(q); const r = await get('/api/finance/ledger' + qs({ q: q.q, kind: q.kind, from: q.from, to: q.to, limit: 200 }));
      mount($('#tbl', body), html`${table([{ label: 'Date', render: (x) => fdate(x.date) }, { label: 'Ref', render: (x) => html`${x.code}${x.voided ? html` <span class="badge bad">voided</span>` : ''}` }, { label: 'Type', render: (x) => badge(x.kind === 'payment' ? 'good' : 'bad', x.kind) }, { label: 'Party / category', render: (x) => x.party }, { label: 'Details', render: (x) => html`<span class="small muted">${x.method}${x.notes ? ' · ' + x.notes : ''}</span>` }, { label: 'Original', class: 'right mono', render: (x) => html`<span class="${x.direction === 'in' ? 'good' : 'bad'}">${x.direction === 'in' ? '+' : '−'}${money(x.amount, x.currency)}</span>` }, { label: `In ${r.reporting_currency}`, class: 'right mono', render: (x) => baseMoney(x.amount_base) }, { label: 'Rate', class: 'right small muted', render: (x) => (x.fx_rate === 1 ? '' : num(x.fx_rate)) }], r.rows, { empty: 'No transactions' })}<div class="pager"><b>In ${baseMoney(r.totals.inflow)}</b><span>· Out ${baseMoney(r.totals.outflow)}</span><span>· Net ${baseMoney(r.totals.inflow - r.totals.outflow)}</span><span class="muted">(voided excluded, ${r.reporting_currency})</span></div>`);
    };
    $('#q', body).oninput = debounce((e) => { q.q = e.target.value; draw(); }, 300);
    for (const [id, k] of [['#k', 'kind'], ['#from', 'from'], ['#to', 'to']]) $(id, body).onchange = (e) => { q[k] = e.target.value; draw(); };
    await draw();
  }
  await load();
  if (q.open) { const id = q.open; delete q.open; setQuery(q); openPayment(Number(id), load); }
}

async function openPayment(id, onChange) {
  const p = await get('/api/payments/' + id).catch(fail); if (!p) return;
  const m = modal({ title: `${p.code}${p.voided ? ' (voided)' : ''}`, size: 'wide', footer: false, body: html`
    <div class="grid g2"><div><b>${p.customer_name}</b><div class="muted">${p.customer_code}</div><div style="margin-top:8px">${p.type === 'refund' ? 'Refund' : 'Payment'} of <b class="mono" style="font-size:18px">${money(p.amount, p.currency)}</b></div><div class="small muted">via ${p.method} on ${fdate(p.paid_at)}${p.reference ? ' · ref ' + p.reference : ''}</div>${p.currency !== p.base_currency ? html`<div class="small muted">Rate recorded: 1 ${p.base_currency} = ${num(p.fx_rate)} ${p.currency} (≈ ${baseMoney(p.amount_base)})</div>` : ''}${p.notes ? html`<p>${p.notes}</p>` : ''}${p.voided ? html`<div class="alert bad">Voided: ${p.void_reason}</div>` : ''}</div>
    <div>${table([{ label: 'Applied to', render: (a) => html`<a href="#/orders?open=${a.order_id}">${a.number}</a>` }, { label: 'Amount', class: 'right mono', render: (a) => money(a.amount, p.currency) }], p.allocations, { empty: 'Not allocated to any order' })}${p.unallocated > 0 && !p.voided ? html`<div class="alert warn" style="margin-top:8px">${money(p.unallocated, p.currency)} is unallocated customer credit.</div>` : ''}</div></div>
    ${can('payments:write') && !p.voided ? html`<div class="toolbar" style="margin-top:14px"><button class="btn" id="ed">Edit / re-allocate</button><button class="btn danger" id="vd">Void payment</button></div>` : ''}` });
  $('#ed', m.body)?.addEventListener('click', () => { m.close(); paymentForm({ payment: p, customer: { id: p.customer_id, name: p.customer_name, phone: '' } }, onChange); });
  $('#vd', m.body)?.addEventListener('click', async () => { const reason = await confirmDialog({ title: `Void ${p.code}?`, message: 'The payment stops counting and order balances go back up. It stays in the audit trail.', confirmText: 'Void payment', danger: true, input: 'Reason for voiding' }); if (reason) { try { await post(`/api/payments/${id}/void`, { reason }); toast('Payment voided', 'success'); m.close(); onChange?.(); } catch (e) { fail(e); } } });
}

/** Record / edit a payment or refund. opts: {customer?, order?, payment?, type?} */
export async function paymentForm(opts, onDone) {
  const s = state.boot.settings; const rates = Object.fromEntries([[s.base_currency, 1], ...state.boot.exchange_rates.map((r) => [r.currency, r.rate_per_base])]);
  const editing = opts.payment; const type = editing?.type || opts.type || 'payment'; let customer = opts.customer?.id ? opts.customer : null; let orders = []; const key = idemKey();
  const m = modal({ title: editing ? `Edit ${editing.code}` : type === 'refund' ? 'Record refund' : 'Record payment', size: 'wide', body: html`<form id="pf" novalidate><div id="cust"></div>
    <div class="frow"><div class="field"><label>Amount *</label><input name="amount" type="number" step="0.01" min="0.01" required value="${editing ? fromCents(editing.amount) : ''}" inputmode="decimal"></div>
      <div class="field"><label>Currency</label><select name="currency">${s.currencies.map((c) => html`<option ${raw((editing?.currency || opts.order?.currency || s.base_currency) === c ? 'selected' : '')}>${c}</option>`)}</select></div>
      <div class="field"><label>Method</label><select name="method">${s.payment_methods.map((c) => html`<option ${raw(editing?.method === c ? 'selected' : '')}>${c}</option>`)}</select></div>
      <div class="field"><label>Date</label><input name="paid_at" type="date" value="${editing?.paid_at || today()}" max="${today()}"></div></div>
    <div class="frow"><div class="field"><label>Reference <span class="muted">(receipt / transfer no.)</span></label><input name="reference" value="${editing?.reference || ''}" maxlength="100"></div><div class="field"><label>Notes</label><input name="notes" value="${editing?.notes || ''}" maxlength="500"></div></div>
    <h3>${type === 'refund' ? 'Refund against which orders?' : 'Apply to which orders?'}</h3><div id="alloc" class="muted">Choose a customer first.</div><div class="alert warn" id="rest" hidden></div>
    ${editing ? html`<div class="field"><label>Reason for the change (audit trail)</label><input name="reason" maxlength="300"></div>` : ''}<div class="alert bad" id="merr" hidden></div></form>` });
  const form = $('#pf', m.body); const amountEl = $('[name=amount]', form); const curEl = $('[name=currency]', form);
  const payCur = () => curEl.value; const toPay = (amt, orderCur) => Math.round((amt / rates[orderCur]) * rates[payCur()]); const toOrd = (amt, orderCur) => Math.round((amt / rates[payCur()]) * rates[orderCur]);
  async function loadOrders() {
    if (!customer) return; $('#alloc', m.body).textContent = 'Loading orders…';
    let list = await get(`/api/customers/${customer.id}/open-orders${type === 'refund' ? '?refundable=1' : ''}`).catch(fail) || [];
    if (editing) { const own = Object.fromEntries(editing.allocations.map((a) => [a.order_id, a])); const have = new Set(list.map((o) => o.id)); list = list.map((o) => ({ ...o, room_extra: own[o.id]?.applied_amount ? Math.abs(own[o.id].applied_amount) : 0 })); for (const a of editing.allocations) if (!have.has(a.order_id)) { const o = await get('/api/orders/' + a.order_id).catch(() => null); if (o) list.push({ ...o, room_extra: Math.abs(a.applied_amount) }); } }
    orders = list; draw();
  }
  function room(o) { return type === 'refund' ? o.paid + (o.room_extra ? 0 : 0) : o.balance + (o.room_extra || 0); }
  function draw() {
    const el = $('#alloc', m.body);
    if (!orders.length) { el.innerHTML = `<p>${type === 'refund' ? 'This customer has no paid orders to refund.' : 'No open orders. The amount will be kept as customer credit and can be applied later.'}</p>`; return summary(); }
    el.innerHTML = `<div class="table-wrap"><table class="items-table"><thead><tr><th>Order</th><th>Date</th><th class="right">${type === 'refund' ? 'Paid' : 'Balance'}</th><th style="width:150px">Apply (${esc(payCur())})</th></tr></thead><tbody>${orders.map((o) => {
      const pre = editing?.allocations.find((a) => a.order_id === o.id)?.amount ?? (opts.order && opts.order.id === o.id ? Math.min(toPay(room(o), o.currency), 1e15) : '');
      return `<tr data-id="${o.id}" data-cur="${o.currency}"><td><b>${esc(o.number)}</b></td><td>${esc(o.order_date)}</td><td class="right mono">${esc(money(room(o), o.currency))}${o.currency !== payCur() ? `<div class="muted small">≈ ${esc(money(toPay(room(o), o.currency), payCur()))}</div>` : ''}</td><td><input data-a type="number" step="0.01" min="0" value="${pre === '' ? '' : fromCents(pre)}"></td></tr>`; }).join('')}</tbody></table></div><button type="button" class="btn sm" id="auto">Auto-fill oldest first</button>`;
    $('#auto', el).onclick = () => { let left = toCents(amountEl.value) || 0; $$('tr[data-id]', el).forEach((tr) => { const o = orders.find((x) => x.id == tr.dataset.id); const take = Math.min(left, toPay(room(o), o.currency)); $('[data-a]', tr).value = take > 0 ? fromCents(take) : ''; left -= Math.max(take, 0); }); summary(); };
    summary();
  }
  function allocations() { return $$('tr[data-id]', m.body).map((tr) => ({ order_id: Number(tr.dataset.id), amount: toCents($('[data-a]', tr).value) || 0 })).filter((a) => a.amount > 0); }
  function summary() {
    const amt = toCents(amountEl.value) || 0; const used = allocations().reduce((a, x) => a + x.amount, 0); const el = $('#rest', m.body);
    if (used > amt) { el.hidden = false; el.className = 'alert bad'; el.textContent = `Applied ${money(used, payCur())} is more than the amount ${money(amt, payCur())}.`; }
    else if (amt > used && amt) { el.hidden = false; el.className = 'alert warn'; el.textContent = type === 'refund' ? `${money(amt - used, payCur())} is not tied to an order (taken from customer credit).` : `${money(amt - used, payCur())} will be kept as customer credit (not applied to any order).`; }
    else el.hidden = true;
  }
  form.addEventListener('input', summary); curEl.addEventListener('change', draw); amountEl.addEventListener('input', () => { if (opts.order && !editing) { const tr = $(`tr[data-id="${opts.order.id}"] [data-a]`, m.body); if (tr) { tr.value = amountEl.value; summary(); } } });
  if (customer) { $('#cust', m.body).innerHTML = `<div class="alert good"><b>${esc(customer.name)}</b> ${esc(customer.phone || '')}</div>`; if (opts.order) { const r = rates[opts.order.currency]; amountEl.value = fromCents(Math.round(room(opts.order) / (r || 1) * 1)); } loadOrders(); }
  else customerPicker($('#cust', m.body), { onPick: (c) => { customer = c; loadOrders(); } });
  m.foot.innerHTML = `<button class="btn" data-no type="button">Cancel</button><button class="btn primary" data-yes type="button">${editing ? 'Save changes' : type === 'refund' ? 'Record refund' : 'Record payment'}</button>`;
  $('[data-no]', m.foot).onclick = () => m.close(); let busy = false;
  $('[data-yes]', m.foot).onclick = async () => {
    if (busy) return; const err = (t) => { const e = $('#merr', m.body); e.textContent = t; e.hidden = false; };
    if (!customer) return err('Choose a customer first.'); if (!form.reportValidity()) return;
    const g = (n) => $(`[name=${n}]`, form)?.value; const body = { customer_id: customer.id, type, amount: toCents(g('amount')), currency: g('currency'), method: g('method'), paid_at: g('paid_at'), reference: g('reference'), notes: g('notes'), allocations: allocations() };
    if (editing) body.reason = g('reason');
    busy = true; $('[data-yes]', m.foot).disabled = true;
    try { editing ? await put('/api/payments/' + editing.id, body) : await post('/api/payments', body, { 'Idempotency-Key': key }); toast(editing ? 'Payment updated' : 'Saved', 'success'); m.close(); onDone?.(); window.dispatchEvent(new Event('notifications-changed')); }
    catch (e) { err(e.message); busy = false; $('[data-yes]', m.foot).disabled = false; }
  };
}
