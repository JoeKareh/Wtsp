import { html, raw, mount, $, $$, state, can, get, post, put, del, qs, money, baseMoney, num, fdate, fdt, badge, toast, fail, esc, modal, formModal, confirmDialog, table, pager, setQuery, debounce, toCents, fromCents, idemKey, today, statusLabel, go, download } from '../core.js';
import { chatBtn } from '../chat.js';
import { customerPicker } from '../pickers.js';

const OPEN = ['Pending', 'Confirmed', 'Processing', 'Ready', 'Out for delivery'];
const FLOW = ['Pending', 'Confirmed', 'Processing', 'Ready', 'Out for delivery', 'Delivered', 'Completed'];
const LIMIT = 50;

export default async function (view, q) {
  q.tab ||= 'all'; q.offset = Number(q.offset) || 0;
  mount(view, html`<div class="page-head"><div class="grow"><h1>Orders</h1><p>Create, track and collect on customer orders.</p></div>${can('orders:write') ? html`<button class="btn primary" id="new">+ New order</button>` : ''}</div>
    <div class="tabs" id="tabs"><button data-t="all">All orders</button><button data-t="pending">Pending orders</button></div><div id="body"></div>`);
  $('#new', view)?.addEventListener('click', () => orderForm(null, () => load()));
  $('#tabs', view).onclick = (e) => { if (e.target.dataset.t) { q.tab = e.target.dataset.t; q.offset = 0; load(); } };
  const load = async () => { setQuery(q); $$('#tabs button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === q.tab)); await (q.tab === 'pending' ? pending : list)($('#body', view)); };
  await load();
  if (q.open) { const id = q.open; delete q.open; setQuery(q); openOrder(Number(id), load); }

  async function list(body) {
    const f = ['q', 'status', 'payment_status', 'from', 'to', 'overdue', 'unpaid', 'recognized', 'product_id', 'customer_id', 'sort', 'dir']; const params = Object.fromEntries(f.map((k) => [k, q[k]]));
    mount(body, html`<div class="toolbar"><input type="search" class="search" id="q" placeholder="Search order #, customer name or phone" value="${q.q || ''}">
      <select id="st" aria-label="Status"><option value="">All statuses</option>${state.boot.statuses.map((s) => html`<option value="${s}" ${raw(q.status === s ? 'selected' : '')}>${statusLabel(s)}</option>`)}</select>
      <select id="ps" aria-label="Payment status"><option value="">Any payment</option>${['Unpaid', 'Partially paid', 'Paid', 'Refunded'].map((s) => html`<option ${raw(q.payment_status === s ? 'selected' : '')}>${s}</option>`)}</select>
      <input type="date" id="from" value="${q.from || ''}" aria-label="From date"><input type="date" id="to" value="${q.to || ''}" aria-label="To date">
      <label class="small"><input type="checkbox" id="od" ${raw(q.overdue ? 'checked' : '')}> Overdue</label><label class="small"><input type="checkbox" id="up" ${raw(q.unpaid ? 'checked' : '')}> Unpaid</label>
      <button class="btn sm ghost" id="clr">Clear</button><span class="grow"></span><button class="btn sm" id="csv">⬇ CSV</button></div><div id="chips"></div><div class="card flush" id="tbl"><div class="loading">Loading…</div></div>`);
    const bind = (id, key, ev = 'change') => $(id, body).addEventListener(ev, (e) => { q[key] = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '') : e.target.value; q.offset = 0; if (key === 'status' || key === 'q') delete q.recognized; load(); });
    bind('#q', 'q', 'input'); $('#q', body).oninput = debounce((e) => { q.q = e.target.value; q.offset = 0; load(); }, 350);
    bind('#st', 'status'); bind('#ps', 'payment_status'); bind('#from', 'from'); bind('#to', 'to'); bind('#od', 'overdue'); bind('#up', 'unpaid');
    $('#clr', body).onclick = () => { for (const k of f) delete q[k]; q.offset = 0; load(); };
    $('#csv', body).onclick = () => download('/api/reports/orders?format=csv&range=custom' + `&from=${q.from || '2000-01-01'}&to=${q.to || today()}` + (q.status && !q.status.includes(',') ? `&status=${encodeURIComponent(q.status)}` : ''));
    const chips = []; if (q.recognized) chips.push('Revenue-recognised orders only'); if (q.product_id) chips.push('Filtered by product'); if (q.customer_id) chips.push('Filtered by customer'); if (q.status?.includes(',')) chips.push('Status: ' + q.status);
    if (chips.length) mount($('#chips', body), html`<div class="alert">${chips.join(' · ')} <a href="#" id="chipclr">remove</a></div>`), $('#chipclr', body).onclick = (e) => { e.preventDefault(); delete q.recognized; delete q.product_id; delete q.customer_id; if (q.status?.includes(',')) delete q.status; load(); };
    try {
      const r = await get('/api/orders' + qs({ ...params, limit: LIMIT, offset: q.offset })); const fin = r.rows[0] && r.rows[0].profit_base !== undefined;
      const cols = [
        { label: 'Order', sort: 'number', render: (o) => html`<b>${o.number}</b>${o.overdue ? html` <span class="badge bad">overdue</span>` : ''}` },
        { label: 'Date', sort: 'order_date', render: (o) => fdate(o.order_date) },
        { label: 'Customer', sort: 'customer', render: (o) => html`${o.customer_name}<div class="muted small">${o.customer_phone}</div>` },
        { label: 'Items', render: (o) => html`<span class="small muted" style="display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${o.items_summary}">${o.items_summary}</span>` },
        { label: 'Total', class: 'right mono', sort: 'total', render: (o) => money(o.total, o.currency) },
        { label: 'Paid', class: 'right mono', render: (o) => money(o.paid, o.currency) },
        { label: 'Balance', class: 'right mono', sort: 'balance', render: (o) => (o.balance > 0 ? html`<b class="bad">${money(o.balance, o.currency)}</b>` : o.balance < 0 ? html`<span class="warn">credit ${money(-o.balance, o.currency)}</span>` : '–') },
        ...(fin ? [{ label: 'Profit', class: 'right mono', render: (o) => (['Draft', 'Cancelled', 'Returned'].includes(o.status) ? '–' : baseMoney(o.profit_base)) }] : []),
        { label: 'Status', sort: 'status', render: (o) => badge(o.status) }, { label: 'Payment', render: (o) => (['Draft', 'Cancelled', 'Returned'].includes(o.status) ? '' : badge(o.payment_status)) },
      ];
      mount($('#tbl', body), html`${table(cols, r.rows, { rowAttr: true, sort: q.sort, dir: q.dir, rowClass: (o) => (o.overdue ? 'row-bad' : ''), empty: 'No orders found', emptyHint: 'Try different filters, or create a new order.' })}
        <div class="pager"><b>${r.summary.count} orders</b><span>· Value ${baseMoney(r.summary.due_base)}</span>${r.summary.cost_base !== undefined ? html`<span>· Profit (recognised) ${baseMoney(r.summary.revenue_base - r.summary.cost_base)}</span>` : ''}<span>· Outstanding ${baseMoney(r.summary.balance_base)}</span></div>${pager(r.summary.count, q.offset, LIMIT)}`);
      const t = $('#tbl', body);
      t.onclick = (e) => {
        const th = e.target.closest('[data-sort]'); if (th) { q.dir = q.sort === th.dataset.sort && q.dir !== 'asc' ? 'asc' : 'desc'; q.sort = th.dataset.sort; return load(); }
        const pg = e.target.closest('[data-page]'); if (pg) { q.offset = Number(pg.dataset.page) * LIMIT; return load(); }
        const tr = e.target.closest('tr[data-row]'); if (tr) openOrder(r.rows[Number(tr.dataset.row)].id, load);
      };
    } catch (e) { mount($('#tbl', body), html`<div class="alert bad">${e.message}</div>`); }
  }

  async function pending(body) {
    const r = await get('/api/orders/pending'); const G = r.groups;
    const sec = (key, title, hint) => html`<div class="card flush" style="margin-bottom:14px"><div style="padding:12px 16px;display:flex;gap:8px;align-items:center"><h2 style="margin:0">${title}</h2><span class="badge ${key === 'overdue' && G[key].length ? 'bad' : ''}">${G[key].length}</span><span class="muted small">${hint}</span></div>
      ${table([
        { label: 'Order', render: (o) => html`<b>${o.number}</b>` }, { label: 'Customer', render: (o) => html`${o.customer_name}<div class="muted small">${o.customer_phone}</div>` },
        { label: 'Placed', render: (o) => html`${fdate(o.order_date)}<div class="muted small">${o.age_days}d ago</div>` },
        { label: 'Expected', render: (o) => (o.expected_date ? html`${fdate(o.expected_date)}${o.days_late ? html` <span class="badge bad">${o.days_late}d late</span>` : ''}` : '–') },
        { label: 'Total', class: 'right mono', render: (o) => money(o.total, o.currency) }, { label: 'Balance', class: 'right mono', render: (o) => (o.balance > 0 ? html`<b class="bad">${money(o.balance, o.currency)}</b>` : '–') }, { label: 'Status', render: (o) => badge(o.status) },
        { label: '', render: (o) => chatBtn({ customer: o.customer_id, order: o.id, purpose: o.balance > 0 ? 'payment_reminder' : 'delivery_update' }, '', 'btn sm ghost') },
      ], G[key], { rowAttr: true, rowClass: (o) => (o.days_late ? 'row-bad' : ''), empty: 'Nothing here 🎉' })}</div>`;
    mount(body, html`<div class="kpis">${[['awaiting_confirmation', 'Awaiting confirmation'], ['processing', 'Being processed'], ['awaiting_delivery', 'Awaiting delivery'], ['overdue', 'Overdue'], ['unpaid', 'With unpaid balance']].map(([k, l]) => html`<div class="kpi"><div class="l">${l}</div><div class="v ${k === 'overdue' && r.counts[k] ? 'bad' : ''}">${r.counts[k]}</div></div>`)}</div>
      ${sec('overdue', 'Overdue & delayed', 'Past the expected delivery date')}${sec('awaiting_confirmation', 'Waiting for confirmation', 'Status Pending')}${sec('processing', 'Being processed', 'Confirmed or processing')}${sec('awaiting_delivery', 'Awaiting delivery', 'Ready or out for delivery')}${sec('unpaid', 'Unpaid balances', 'Delivered or in progress, not fully paid')}`);
    const trs = $$('tbody', body); const keys = ['overdue', 'awaiting_confirmation', 'processing', 'awaiting_delivery', 'unpaid'];
    body.onclick = (e) => { const tr = e.target.closest('tr[data-row]'); if (!tr) return; const idx = $$('tbody', body).indexOf(tr.parentElement); const key = keys.filter((k) => G[k].length)[idx]; if (key) openOrder(G[key][Number(tr.dataset.row)].id, load); }; void trs;
  }
}

// ======================= detail =======================
export async function openOrder(id, onChange = () => {}) {
  const m = modal({ title: 'Order', size: 'wide', body: html`<div class="loading">Loading…</div>`, footer: false });
  const render = async () => {
    let o; try { o = await get('/api/orders/' + id); } catch (e) { m.close(); return fail(e); }
    const fin = o.total_cost !== undefined; const locked = ['Cancelled', 'Returned'].includes(o.status); const w = can('orders:write');
    const idx = FLOW.indexOf(o.status); const next = idx >= 0 && idx < FLOW.length - 1 ? FLOW[idx + 1] : null;
    $('.modal-head h2', m.el).textContent = `Order ${o.number}`;
    mount(m.body, html`
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">${badge(o.status)} ${o.status !== 'Draft' && !locked ? badge(o.payment_status) : ''} ${o.overdue ? html`<span class="badge bad">Overdue</span>` : ''} ${o.credit > 0 ? html`<span class="badge warn">Refund due ${money(o.credit, o.currency)}</span>` : ''}
        <span class="muted small">${o.currency !== state.boot.settings.base_currency ? `Rate used: 1 ${state.boot.settings.base_currency} = ${num(o.fx_rate)} ${o.currency}` : ''}</span></div>
      ${w ? html`<div class="toolbar">${next ? html`<button class="btn primary sm" data-act="status" data-s="${next}">Mark ${statusLabel(next)}</button>` : ''}
        <select id="st-sel" aria-label="Change status"><option value="">Change status…</option>${state.boot.statuses.filter((s) => s !== o.status).map((s) => html`<option value="${s}">${statusLabel(s)}</option>`)}</select>
        ${!locked ? html`<button class="btn sm" data-act="edit">Edit</button>` : ''}<button class="btn sm" data-act="dup">Duplicate</button>
        ${!locked && can('payments:write') && o.status !== 'Draft' && o.balance > 0 ? html`<button class="btn sm primary" data-act="pay">Record payment</button>` : ''}
        ${o.credit > 0 && can('payments:write') ? html`<button class="btn sm" data-act="refund">Record refund</button>` : ''}
        ${chatBtn({ customer: o.customer_id, order: o.id, purpose: o.balance > 0 && o.status !== 'Draft' ? 'payment_reminder' : o.status === 'Delivered' || o.status === 'Completed' ? 'thank_you' : 'order_confirmation' })}
        ${can('marketing:write') ? html`<button class="btn sm" data-act="wa">WhatsApp…</button>` : ''}
        ${!locked && o.status !== 'Draft' ? html`<button class="btn sm danger" data-act="cancel">Cancel order</button>` : ''}${o.status === 'Draft' ? html`<button class="btn sm danger" data-act="delete">Delete draft</button>` : ''}</div>` : ''}
      <div class="grid g2" style="margin-bottom:14px"><div><b>${o.customer_name}</b> <a href="#/customers?open=${o.customer_id}" class="small">view profile</a><div class="muted">${o.customer_phone}</div>
        <div class="small muted" style="margin-top:6px">Ordered ${fdate(o.order_date)} · Expected ${fdate(o.expected_date)} · Delivered ${fdate(o.delivery_date)}</div>${o.cancel_reason ? html`<div class="small bad">Cancelled: ${o.cancel_reason}</div>` : ''}${o.notes ? html`<div style="margin-top:6px;white-space:pre-wrap">${o.notes}</div>` : ''}
        ${o.attribution ? html`<div class="small" style="margin-top:6px">📣 Attributed to campaign <b>${o.attribution.campaign}</b></div>` : ''}</div>
        <div class="totals mono"><div><span>Items</span><span>${money(o.subtotal, o.currency)}</span></div>${o.discount ? html`<div><span>Discount</span><span>−${money(o.discount, o.currency)}</span></div>` : ''}${o.additional_charges ? html`<div><span>Additional charges</span><span>${money(o.additional_charges, o.currency)}</span></div>` : ''}${o.delivery_fee ? html`<div><span>Delivery</span><span>${money(o.delivery_fee, o.currency)}</span></div>` : ''}${o.tax ? html`<div><span>${state.boot.settings.tax_label} (${o.tax_rate}%)</span><span>${money(o.tax, o.currency)}</span></div>` : ''}
        <div class="big"><span>Total</span><span>${money(o.total, o.currency)}</span></div><div><span>Paid</span><span class="good">${money(o.paid, o.currency)}</span></div><div><span>Balance</span><span class="${o.balance > 0 ? 'bad' : ''}">${money(o.balance, o.currency)}</span></div>
        ${fin ? html`<div class="sep"></div><div><span>Product cost</span><span>${money(o.total_cost, o.currency)}</span></div><div><span>Gross profit</span><span class="${o.gross_profit >= 0 ? 'good' : 'bad'}">${money(o.gross_profit, o.currency)}</span></div>` : ''}</div></div>
      <h3>Items</h3>${table([{ label: 'Item', render: (i) => i.description }, { label: 'Qty', class: 'right', render: (i) => num(i.qty, 3) }, { label: 'Price', class: 'right mono', render: (i) => money(i.unit_price, o.currency) }, ...(fin ? [{ label: 'Cost', class: 'right mono', render: (i) => money(i.unit_cost, o.currency) }] : []), { label: 'Line total', class: 'right mono', render: (i) => money(i.line_total, o.currency) }], o.items)}
      <h3 style="margin-top:14px">Payments</h3>${table([{ label: 'Payment', render: (p) => html`${p.code}${p.voided ? html` <span class="badge bad">voided</span>` : ''}` }, { label: 'Date', render: (p) => fdate(p.paid_at) }, { label: 'Method', render: (p) => p.method }, { label: 'Applied', class: 'right mono', render: (p) => money(p.applied_amount, o.currency) }], o.payments, { empty: 'No payments yet' })}
      <h3 style="margin-top:14px">History</h3><div class="small">${o.history.map((h) => html`<div style="padding:3px 0"><span class="muted">${fdt(h.created_at)}</span> · ${h.user_name} · ${h.event === 'status' ? html`${h.from_status} → <b>${h.to_status}</b>` : h.event}${h.note ? html` <span class="muted">(${h.note})</span>` : ''}</div>`)}</div>`);
    m.body.onchange = async (e) => { if (e.target.id === 'st-sel' && e.target.value) await changeStatus(e.target.value); };
    m.body.onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return; const act = b.dataset.act;
      try {
        if (act === 'status') await changeStatus(b.dataset.s);
        else if (act === 'edit') { m.close(); orderForm(o, onChange, () => openOrder(id, onChange)); }
        else if (act === 'dup') { const n = await post(`/api/orders/${id}/duplicate`, {}, { 'Idempotency-Key': idemKey() }); toast(`Draft ${n.number} created`, 'success'); onChange(); m.close(); openOrder(n.id, onChange); }
        else if (act === 'pay' || act === 'refund') { const { paymentForm } = await import('./payments.js'); paymentForm({ customer: { id: o.customer_id, name: o.customer_name, phone: o.customer_phone }, order: o, type: act === 'refund' ? 'refund' : 'payment' }, () => { render(); onChange(); }); }
        else if (act === 'wa') waDialog(o);
        else if (act === 'cancel') { const reason = await confirmDialog({ title: `Cancel ${o.number}?`, message: 'Stock will be returned and the order will stop counting as revenue. Payments already received remain as customer credit until refunded.', confirmText: 'Cancel order', danger: true, input: 'Reason for cancelling' }); if (reason) { const r = await post(`/api/orders/${id}/cancel`, { reason }); if (r.warning) toast(r.warning); render(); onChange(); } }
        else if (act === 'delete') { if (await confirmDialog({ title: 'Delete draft?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true })) { await del('/api/orders/' + id); m.close(); onChange(); } }
      } catch (er) { fail(er); }
    };
    async function changeStatus(s) {
      if (s === 'Cancelled') return m.body.querySelector('[data-act=cancel]')?.click();
      if (['Returned'].includes(s) && !(await confirmDialog({ title: 'Mark as returned?', message: 'Goods go back into stock and the order stops counting as revenue.', confirmText: 'Mark returned', danger: true }))) return render();
      try { const r = await post(`/api/orders/${id}/status`, { status: s }); toast(`Order is now ${statusLabel(r.status)}`, 'success'); } catch (er) { fail(er); }
      await render(); onChange(); window.dispatchEvent(new Event('notifications-changed'));
    }
  };
  await render();
}

async function waDialog(o) {
  const [tpls, st] = await Promise.all([get('/api/whatsapp/templates'), get('/api/whatsapp/status')]).catch((e) => { fail(e); return []; });
  if (!tpls) return;
  const usable = tpls.filter((t) => t.category === 'UTILITY');
  const m = formModal({ title: 'Send WhatsApp message', submitText: 'Send', extra: html`${!st.can_send ? html`<div class="alert warn">WhatsApp is not configured on the server yet (see Settings → WhatsApp).</div>` : ''}<p class="small muted">Only approved transactional templates can be sent to customers. Customers who opted out are blocked automatically.</p>`,
    fields: [{ name: 'template_id', label: 'Template', type: 'select', required: true, options: usable.map((t) => [t.id, `${t.name}${t.usable ? '' : ' (not approved: ' + t.meta_status + ')'}`]) }],
    onSubmit: async (v) => { await post('/api/whatsapp/send-template', { customer_id: o.customer_id, template_id: Number(v.template_id), order_id: o.id }); toast('Message sent', 'success'); } });
  return m;
}

// ======================= form =======================
export async function orderForm(order, onDone, afterClose, prefill) {
  const [pm, cfg] = await Promise.all([get('/api/products?active=1&limit=1000'), Promise.resolve(state.boot.settings)]).catch((e) => { fail(e); return []; });
  if (!pm) return;
  const products = pm.rows; const finance = can('finance:read'); const key = idemKey();
  let customer = order ? { id: order.customer_id, name: order.customer_name, phone: order.customer_phone } : prefill?.customer || null;
  const items = order ? order.items.map((i) => ({ ...i })) : [{ product_id: '', description: '', qty: 1, unit_price: 0, unit_cost: 0 }];
  const m = modal({ title: order ? `Edit ${order.number}` : 'New order', size: 'xl', onClose: () => afterClose?.() , body: html`<form id="of" novalidate><div id="cust"></div>
    <div class="frow"><div class="field"><label>Order date</label><input type="date" name="order_date" value="${order?.order_date || today()}" required></div><div class="field"><label>Expected delivery</label><input type="date" name="expected_date" value="${order?.expected_date || ''}"></div>
      <div class="field"><label>Currency</label><select name="currency" ${raw(order ? 'disabled' : '')}>${cfg.currencies.map((c) => html`<option ${raw((order?.currency || cfg.base_currency) === c ? 'selected' : '')}>${c}</option>`)}</select></div>
      ${order ? '' : html`<div class="field"><label>Status</label><select name="status">${['Pending', 'Confirmed', 'Draft', 'Processing', 'Delivered'].map((s) => html`<option value="${s}">${statusLabel(s)}</option>`)}</select></div>`}</div>
    <h3>Products & services</h3><div class="table-wrap"><table class="items-table"><thead><tr><th style="min-width:200px">Item</th><th style="width:90px">Qty</th><th style="width:120px">Unit price</th>${finance ? html`<th style="width:110px">Unit cost</th>` : ''}<th class="right" style="width:110px">Line total</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
    <button type="button" class="btn sm" id="add">+ Add item</button>
    <div class="frow" style="margin-top:14px"><div class="field"><label>Discount</label><input name="discount" type="number" step="0.01" min="0" value="${fromCents(order?.discount || 0)}"></div><div class="field"><label>Additional charges</label><input name="additional_charges" type="number" step="0.01" min="0" value="${fromCents(order?.additional_charges || 0)}"></div>
      <div class="field"><label>Delivery fee</label><input name="delivery_fee" type="number" step="0.01" min="0" value="${fromCents(order?.delivery_fee || 0)}"></div>${finance ? html`<div class="field"><label>Extra costs <span class="muted">(e.g. delivery cost)</span></label><input name="extra_cost" type="number" step="0.01" min="0" value="${fromCents(order?.extra_cost || 0)}"></div>` : ''}</div>
    <div class="field"><label>Internal notes</label><textarea name="notes">${order?.notes || ''}</textarea></div>
    <div class="totals mono" id="tot"></div><div class="alert bad" id="merr" hidden></div></form>`});
  customerPicker($('#cust', m.body), { initial: customer, onPick: (c) => { customer = c; } });
  const tbody = $('#items', m.body); const form = $('#of', m.body);
  const cur = () => (order?.currency || $('[name=currency]', form).value);
  const calc = () => {
    const rows = $$('tr', tbody); let sub = 0, cost = 0;
    rows.forEach((tr, i) => { const it = items[i]; it.qty = Number($('[data-f=qty]', tr).value) || 0; it.unit_price = toCents($('[data-f=price]', tr).value) ?? 0; if (finance) it.unit_cost = toCents($('[data-f=cost]', tr).value) ?? 0; const lt = Math.round(it.qty * it.unit_price); sub += lt; cost += Math.round(it.qty * (it.unit_cost || 0)); $('[data-f=lt]', tr).textContent = money(lt, cur()); });
    const v = (n) => toCents($(`[name=${n}]`, form)?.value || '0') || 0; const disc = v('discount'), add = v('additional_charges'), del_ = v('delivery_fee'), extra = finance ? v('extra_cost') : 0;
    const taxable = sub - disc + add; const tax = cfg.tax_enabled && !order ? Math.round(taxable * cfg.tax_rate / 100) : (order?.tax_rate ? Math.round(taxable * order.tax_rate / 100) : 0); const total = taxable + del_ + tax;
    $('#tot', m.body).innerHTML = `<div><span>Items</span><span>${esc(money(sub, cur()))}</span></div>${tax ? `<div><span>${esc(cfg.tax_label)}</span><span>${esc(money(tax, cur()))}</span></div>` : ''}<div class="big"><span>Order total</span><span>${esc(money(total, cur()))}</span></div>${finance ? `<div class="muted"><span>Est. gross profit</span><span>${esc(money(taxable + del_ - cost - extra, cur()))}</span></div>` : ''}<div class="small muted" style="display:block;text-align:right">Final amounts are calculated by the server</div>`;
  };
  const drawItems = () => {
    tbody.innerHTML = items.map((it, i) => `<tr data-i="${i}"><td><select data-f="prod" aria-label="Product"><option value="">Custom item…</option>${products.map((p) => `<option value="${p.id}" ${String(it.product_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}${p.quantity <= 0 ? ' (out of stock)' : ` (${p.quantity} in stock)`}</option>`).join('')}</select>
      <input data-f="desc" placeholder="Description" value="${esc(it.description)}" ${it.product_id ? 'hidden' : ''} style="margin-top:4px" required></td><td><input data-f="qty" type="number" min="0.001" step="any" value="${it.qty}" required></td>
      <td><input data-f="price" type="number" min="0" step="0.01" value="${fromCents(it.unit_price)}" required></td>${finance ? `<td><input data-f="cost" type="number" min="0" step="0.01" value="${fromCents(it.unit_cost || 0)}"></td>` : ''}<td class="right mono" data-f="lt"></td><td><button type="button" class="btn sm ghost" data-rm aria-label="Remove item">✕</button></td></tr>`).join('');
    calc();
  };
  drawItems();
  tbody.addEventListener('input', (e) => { if (e.target.dataset.f === 'desc') items[Number(e.target.closest('tr').dataset.i)].description = e.target.value; calc(); });
  tbody.addEventListener('change', (e) => {
    if (e.target.dataset.f !== 'prod') return; const i = Number(e.target.closest('tr').dataset.i); const p = products.find((x) => String(x.id) === e.target.value); const it = items[i];
    it.product_id = p ? p.id : ''; if (p) { it.description = p.name; it.unit_price = p.price; it.unit_cost = p.cost ?? 0; if (p.currency !== cur()) { toast(`${p.name} is priced in ${p.currency}; the server will convert it. Check the price.`); } } drawItems();
  });
  tbody.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { items.splice(Number(e.target.closest('tr').dataset.i), 1); if (!items.length) items.push({ product_id: '', description: '', qty: 1, unit_price: 0, unit_cost: 0 }); drawItems(); } });
  $('#add', m.body).onclick = () => { items.push({ product_id: '', description: '', qty: 1, unit_price: 0, unit_cost: 0 }); drawItems(); };
  form.addEventListener('input', (e) => { if (e.target.name) calc(); }); $('[name=currency]', form)?.addEventListener('change', calc);
  m.foot.innerHTML = `<button class="btn" data-no type="button">Cancel</button><button class="btn" data-draft type="button" ${order ? 'hidden' : ''}>Save as draft</button><button class="btn primary" data-yes type="button">${order ? 'Save changes' : 'Create order'}</button>`;
  $('[data-no]', m.foot).onclick = () => m.close();
  let busy = false;
  const save = async (asDraft) => {
    if (busy) return; if (!customer) return showErr('Choose a customer first (search by phone number).');
    calc(); if (!form.reportValidity()) return; busy = true; $$('button', m.foot).forEach((b) => (b.disabled = true));
    const g = (n) => $(`[name=${n}]`, form)?.value;
    const body = { customer_id: customer.id, order_date: g('order_date'), expected_date: g('expected_date') || null, currency: cur(), discount: toCents(g('discount') || '0'), additional_charges: toCents(g('additional_charges') || '0'), delivery_fee: toCents(g('delivery_fee') || '0'), notes: g('notes'),
      items: items.map((it) => ({ id: it.id, product_id: it.product_id || undefined, description: it.description, qty: it.qty, unit_price: it.unit_price, ...(finance && !it.product_id ? { unit_cost: it.unit_cost } : {}), ...(finance && it.product_id && it.id ? { unit_cost: it.unit_cost } : {}) })) };
    if (finance) body.extra_cost = toCents(g('extra_cost') || '0');
    try {
      const saved = order ? await put('/api/orders/' + order.id, body) : await api2(body, asDraft ? 'Draft' : g('status'));
      toast(`Order ${saved.number} saved`, 'success'); if (saved.warning) toast(saved.warning); m.close(); onDone?.(saved); window.dispatchEvent(new Event('notifications-changed')); if (!order) openOrder(saved.id, onDone);
    } catch (e) { showErr(e.message); busy = false; $$('button', m.foot).forEach((b) => (b.disabled = false)); }
  };
  const api2 = (body, status) => post('/api/orders', { ...body, status }, { 'Idempotency-Key': key });
  const showErr = (t) => { const er = $('#merr', m.body); er.textContent = t; er.hidden = false; er.scrollIntoView({ block: 'nearest' }); };
  $('[data-yes]', m.foot).onclick = () => save(false); $('[data-draft]', m.foot).onclick = () => save(true);
}
