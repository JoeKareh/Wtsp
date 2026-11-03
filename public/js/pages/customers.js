import { html, raw, mount, $, $$, state, can, get, post, put, del, qs, money, baseMoney, num, fdate, fdt, badge, toast, fail, modal, formModal, confirmDialog, table, pager, setQuery, debounce, esc } from '../core.js';
import { chatBtn } from '../chat.js'; import { importDialog } from './import.js';

const LIMIT = 50;
export default async function (view, q) {
  q.offset = Number(q.offset) || 0;
  const meta = await get('/api/customers/meta');
  mount(view, html`<div class="page-head"><div class="grow"><h1>Customers</h1><p>Everyone you sell to. Phone numbers are unique, so duplicates are caught automatically.</p></div>${can('customers:write') ? html`<button class="btn" id="imp">Import</button> <button class="btn primary" id="new">+ New customer</button>` : ''}</div>
    <div class="toolbar"><input type="search" class="search" id="q" placeholder="Search by phone number, name or ID" value="${q.q || ''}">
      <select id="lc" aria-label="Lifecycle"><option value="">All lifecycle</option>${['Active', 'At risk', 'Inactive', 'Prospect', 'Archived'].map((s) => html`<option ${raw(q.lifecycle === s ? 'selected' : '')}>${s}</option>`)}</select>
      <select id="cat" aria-label="Category"><option value="">All categories</option>${meta.categories.map((s) => html`<option ${raw(q.category === s ? 'selected' : '')}>${s}</option>`)}</select>
      <select id="loc" aria-label="Location"><option value="">All locations</option>${meta.locations.map((s) => html`<option ${raw(q.location === s ? 'selected' : '')}>${s}</option>`)}</select>
      <select id="co" aria-label="WhatsApp consent"><option value="">Any consent</option><option value="opted_in" ${raw(q.consent === 'opted_in' ? 'selected' : '')}>Opted in</option><option value="opted_out" ${raw(q.consent === 'opted_out' ? 'selected' : '')}>Opted out</option><option value="none" ${raw(q.consent === 'none' ? 'selected' : '')}>No consent recorded</option></select>
      <label class="small"><input type="checkbox" id="bal" ${raw(q.balance ? 'checked' : '')}> Owes money</label><label class="small"><input type="checkbox" id="loy" ${raw(q.loyal ? 'checked' : '')}> Loyal</label></div>
    <div class="card flush" id="tbl"></div>`);
  $('#imp', view)?.addEventListener('click', () => importDialog('customers', load));
  $('#new', view)?.addEventListener('click', () => customerForm(null, (c) => { load(); openCustomer(c.id, load); }));
  const load = async () => {
    setQuery(q); const t = $('#tbl', view); t.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const r = await get('/api/customers' + qs({ q: q.q, lifecycle: q.lifecycle, category: q.category, location: q.location, consent: q.consent, balance: q.balance, loyal: q.loyal, sort: q.sort, dir: q.dir, limit: LIMIT, offset: q.offset }));
      mount(t, html`${table([
        { label: 'Customer', sort: 'name', render: (c) => html`<b>${c.name}</b> ${c.is_loyal ? html`<span title="Loyal customer">⭐</span>` : ''}<div class="muted small">${c.code}${c.category ? ' · ' + c.category : ''}</div>` },
        { label: 'Phone', render: (c) => html`${c.phone}${c.location ? html`<div class="muted small">${c.location}</div>` : ''}` },
        { label: 'Lifecycle', render: (c) => badge(c.lifecycle) }, { label: 'Orders', class: 'right', sort: 'total_orders', render: (c) => num(c.total_orders) },
        { label: 'Total spent', class: 'right mono', sort: 'total_spent', render: (c) => baseMoney(c.total_spent) }, { label: 'Outstanding', class: 'right mono', sort: 'outstanding', render: (c) => (c.outstanding ? html`<b class="bad">${baseMoney(c.outstanding)}</b>` : '–') },
        { label: 'Last purchase', sort: 'last_purchase', render: (c) => (c.last_purchase ? html`${fdate(c.last_purchase)}<div class="muted small">${c.days_since_purchase}d ago</div>` : '–') },
        { label: 'WhatsApp', render: (c) => badge(c.marketing_consent || 'none', c.marketing_consent === 'opted_in' ? 'opted in' : c.marketing_consent === 'opted_out' ? 'opted out' : 'no consent') },
      ], r.rows, { rowAttr: true, sort: q.sort, dir: q.dir, empty: 'No customers found', emptyHint: 'Search by phone number or add a new customer.' })}${pager(r.total, q.offset, LIMIT)}`);
      t.onclick = (e) => { const th = e.target.closest('[data-sort]'); if (th) { q.dir = q.sort === th.dataset.sort && q.dir !== 'asc' ? 'asc' : 'desc'; q.sort = th.dataset.sort; return load(); } const pg = e.target.closest('[data-page]'); if (pg) { q.offset = Number(pg.dataset.page) * LIMIT; return load(); } const tr = e.target.closest('tr[data-row]'); if (tr) openCustomer(r.rows[Number(tr.dataset.row)].id, load); };
    } catch (e) { mount(t, html`<div class="alert bad">${e.message}</div>`); }
  };
  $('#q', view).oninput = debounce((e) => { q.q = e.target.value; q.offset = 0; load(); }, 300);
  for (const [id, k] of [['#lc', 'lifecycle'], ['#cat', 'category'], ['#loc', 'location'], ['#co', 'consent']]) $(id, view).onchange = (e) => { q[k] = e.target.value; q.offset = 0; load(); };
  for (const [id, k] of [['#bal', 'balance'], ['#loy', 'loyal']]) $(id, view).onchange = (e) => { q[k] = e.target.checked ? '1' : ''; q.offset = 0; load(); };
  await load();
  if (q.open) { const id = q.open; delete q.open; setQuery(q); openCustomer(Number(id), load); }
}

export async function customerForm(c, onDone) {
  const meta = await get('/api/customers/meta').catch(() => ({ categories: [] }));
  const v = c || {}; const cats = state.boot.settings.customer_categories;
  const fields = [
    { name: 'name', label: 'Full name', required: true }, { name: 'phone', label: 'Primary phone', type: 'tel', required: true, hint: 'International format is best, e.g. +961 71 123 456' },
    { name: 'phone2', label: 'Secondary phone', type: 'tel' }, { name: 'whatsapp', label: 'WhatsApp number', type: 'tel', hint: c ? '' : 'Leave empty to use the primary phone' },
    { name: 'category', label: 'Category', type: 'select', options: [['', '—'], ...cats] }, { name: 'location', label: 'Location / city' },
    { name: 'status', label: 'Status', type: 'select', options: ['Potential', 'Active', 'Inactive', 'Archived'], value: 'Potential' },
    { name: 'address', label: 'Address', full: true }, { name: 'tags', label: 'Tags (comma separated)', full: true }, { name: 'notes', label: 'Notes', type: 'textarea' },
    ...(c ? [] : [{ name: 'marketing_opt_in', label: 'Customer agreed to receive WhatsApp marketing messages', type: 'checkbox', hint: 'Only tick if they actually agreed. You must record how.' }, { name: 'consent_source', label: 'How did they consent?', hint: 'e.g. Verbal at the counter, signed form, WhatsApp message' }]),
  ];
  const m = formModal({ title: c ? `Edit ${c.name}` : 'New customer', fields, values: { ...v, whatsapp: c ? c.whatsapp : '', tags: (v.tags || []).join(', ') }, submitText: c ? 'Save changes' : 'Create customer',
    onSubmit: async (val, key) => {
      const body = { ...val, tags: val.tags ? val.tags.split(',').map((t) => t.trim()).filter(Boolean) : [] }; if (!body.whatsapp) body.whatsapp = c ? '' : undefined; if (!c && !body.marketing_opt_in) delete body.consent_source;
      let saved; try { saved = c ? await put('/api/customers/' + c.id, body) : await post('/api/customers', body, { 'Idempotency-Key': key }); }
      catch (e) { if (e.details?.duplicate) { const d = e.details.duplicate; throw new Error(`${e.message}. Open that customer instead from the list (search ${d.phone}).`); } throw e; }
      toast('Customer saved', 'success'); onDone?.(saved);
    } });
  return m;
}

export async function openCustomer(id, onChange = () => {}) {
  const m = modal({ title: 'Customer', size: 'xl', footer: false, body: html`<div class="loading">Loading…</div>` }); let tab = 'overview';
  const render = async () => {
    let p; try { p = await get('/api/customers/' + id); } catch (e) { m.close(); return fail(e); }
    const c = p.customer; const w = can('customers:write'); const mw = can('marketing:write');
    $('.modal-head h2', m.el).textContent = c.name;
    const tabs = [['overview', 'Overview'], ['orders', `Orders (${p.orders.length})`], ['payments', `Payments (${p.payments.length})`], ['products', 'Products bought'], ['whatsapp', 'WhatsApp & consent']];
    const body = {
      overview: html`<div class="kpis"><div class="kpi"><div class="l">Total orders</div><div class="v">${c.total_orders}</div></div><div class="kpi"><div class="l">Total spending</div><div class="v">${baseMoney(c.total_spent)}</div></div><div class="kpi"><div class="l">Total payments</div><div class="v">${baseMoney(c.total_paid)}</div></div><div class="kpi"><div class="l">Outstanding</div><div class="v ${c.outstanding ? 'bad' : ''}">${baseMoney(c.outstanding)}</div></div><div class="kpi"><div class="l">Avg order value</div><div class="v">${baseMoney(c.avg_order_value)}</div></div></div>
        <div class="grid g2"><div class="card"><dl style="display:grid;grid-template-columns:130px 1fr;gap:6px;margin:0"><dt class="muted">Customer ID</dt><dd>${c.code}</dd><dt class="muted">Phone</dt><dd>${c.phone}${c.phone2 ? ' / ' + c.phone2 : ''}</dd><dt class="muted">WhatsApp</dt><dd>${c.whatsapp || '–'}</dd><dt class="muted">Address</dt><dd>${c.address || '–'}${c.location ? ' · ' + c.location : ''}</dd><dt class="muted">Category</dt><dd>${c.category || '–'}</dd><dt class="muted">Tags</dt><dd>${c.tags.join(', ') || '–'}</dd><dt class="muted">Registered</dt><dd>${fdate(c.registered_on)}</dd><dt class="muted">Notes</dt><dd style="white-space:pre-wrap">${c.notes || '–'}</dd></dl></div>
        <div class="card"><dl style="display:grid;grid-template-columns:150px 1fr;gap:6px;margin:0"><dt class="muted">Status</dt><dd>${badge(c.status)}</dd><dt class="muted">Lifecycle</dt><dd>${badge(c.lifecycle)} ${c.is_loyal ? '⭐ loyal' : ''}</dd><dt class="muted">Last purchase</dt><dd>${fdate(c.last_purchase)} ${c.days_since_purchase != null ? html`<span class="muted">(${c.days_since_purchase} days ago)</span>` : ''}</dd><dt class="muted">Purchase frequency</dt><dd>${p.frequency.avg_days_between_orders != null ? `every ${p.frequency.avg_days_between_orders} days on average` : 'not enough history'}</dd><dt class="muted">Last interaction</dt><dd>${fdate(p.last_interaction)}</dd>${p.credit.length ? html`<dt class="muted">Unallocated credit</dt><dd>${p.credit.map((x) => money(x.amount, x.currency)).join(', ')}</dd>` : ''}</dl></div></div>
        <div class="toolbar" style="margin-top:14px">${can('orders:write') && c.status !== 'Archived' ? html`<button class="btn primary" data-act="order">+ New order</button>` : ''}${can('payments:write') ? html`<button class="btn" data-act="pay">Record payment</button>` : ''} ${chatBtn({ customer: c.id, purpose: 'thank_you' }, 'Chat on WhatsApp', 'btn')}${w ? html`<button class="btn" data-act="edit">Edit</button>` : ''}${w ? html`<button class="btn danger" data-act="delete">Delete / archive</button>` : ''}</div>`,
      orders: table([{ label: 'Order', render: (o) => html`<a href="#/orders?open=${o.id}">${o.number}</a>` }, { label: 'Date', render: (o) => fdate(o.order_date) }, { label: 'Total', class: 'right mono', render: (o) => money(o.total, o.currency) }, { label: 'Balance', class: 'right mono', render: (o) => (o.balance > 0 ? html`<b class="bad">${money(o.balance, o.currency)}</b>` : '–') }, { label: 'Status', render: (o) => badge(o.status) }, { label: 'Payment', render: (o) => (['Cancelled', 'Draft', 'Returned'].includes(o.status) ? '' : badge(o.payment_status)) }], p.orders, { empty: 'No orders yet' }),
      payments: table([{ label: 'Payment', render: (x) => html`${x.code}${x.voided ? html` <span class="badge bad">voided</span>` : ''}` }, { label: 'Date', render: (x) => fdate(x.paid_at) }, { label: 'Type', render: (x) => x.type }, { label: 'Amount', class: 'right mono', render: (x) => money(x.amount, x.currency) }, { label: 'Method', render: (x) => x.method }, { label: 'Orders', render: (x) => x.orders || (x.unallocated ? 'unallocated credit' : '–') }], p.payments, { empty: 'No payments yet' }),
      products: table([{ label: 'Product', render: (x) => x.name }, { label: 'Quantity', class: 'right', render: (x) => num(x.qty, 2) }, { label: 'Total', class: 'right mono', render: (x) => money(x.total, x.currency) }, { label: 'Last bought', render: (x) => fdate(x.last_date) }], p.products, { empty: 'No purchases yet' }),
      whatsapp: html`<div class="alert ${c.marketing_consent === 'opted_in' ? 'good' : c.marketing_consent === 'opted_out' ? 'bad' : 'warn'}">Marketing consent: <b>${c.marketing_consent === 'opted_in' ? 'Opted in' : c.marketing_consent === 'opted_out' ? 'Opted out' : 'Not recorded'}</b>${p.suppressed ? ' · on suppression list (no messages will be sent)' : ''}. ${c.marketing_consent === 'opted_in' ? '' : 'Promotional messages will not be sent to this customer.'}</div>
        ${mw ? html`<div class="toolbar"><button class="btn sm" data-act="optin">Record opt-in…</button><button class="btn sm danger" data-act="optout">Record opt-out</button>${p.whatsapp_window_open ? html`<button class="btn sm primary" data-act="text">Reply (24h window open)</button>` : html`<span class="small muted">Free-text replies are only possible within 24h of the customer's last message.</span>`}</div>` : ''}
        <h3>Consent history</h3>${table([{ label: 'When', render: (x) => fdt(x.created_at) }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Source', render: (x) => x.source }], p.consent, { empty: 'No consent records' })}
        <h3 style="margin-top:14px">Message history</h3>${table([{ label: 'When', render: (x) => fdt(x.created_at) }, { label: 'Direction', render: (x) => (x.direction === 'in' ? '⬅ received' : '➡ sent') }, { label: 'Message', render: (x) => html`<span style="white-space:pre-wrap">${x.body}</span>` }, { label: 'Status', render: (x) => html`${badge(x.status)}${x.error ? html`<div class="small bad">${x.error}</div>` : ''}` }], p.messages, { empty: 'No messages yet' })}`,
    };
    mount(m.body, html`<div class="tabs" id="ctabs">${tabs.map(([k, l]) => html`<button data-t="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`)}</div>${body[tab]}`);
    m.body.onclick = async (e) => {
      const t = e.target.closest('#ctabs button'); if (t) { tab = t.dataset.t; return render(); }
      const b = e.target.closest('[data-act]'); if (!b) return;
      try {
        switch (b.dataset.act) {
          case 'order': { const { orderForm } = await import('./orders.js'); m.close(); orderForm(null, onChange, null, { customer: { id, name: c.name, phone: c.phone } }); break; }
          case 'pay': { const { paymentForm } = await import('./payments.js'); paymentForm({ customer: { id, name: c.name, phone: c.phone } }, () => { render(); onChange(); }); break; }
          case 'edit': customerForm(c, () => { render(); onChange(); }); break;
          case 'delete': { if (await confirmDialog({ title: 'Delete or archive?', message: 'Customers with orders or payments are archived (history is kept). Others are deleted permanently.', confirmText: 'Continue', danger: true })) { const r = await del('/api/customers/' + id); toast(r.message || 'Customer deleted', 'success'); m.close(); onChange(); } break; }
          case 'optin': formModal({ title: 'Record WhatsApp marketing opt-in', fields: [{ name: 'source', label: 'How did the customer consent?', required: true, placeholder: 'e.g. Verbal at the counter on 3 Nov' }, { name: 'evidence', label: 'Reference (optional)' }], onSubmit: async (v) => { await post(`/api/customers/${id}/consent`, { status: 'opted_in', ...v }); render(); onChange(); } }); break;
          case 'optout': if (await confirmDialog({ title: 'Opt this customer out?', message: 'They will be added to the suppression list and will not receive any promotional messages.', confirmText: 'Opt out', danger: true })) { await post(`/api/customers/${id}/consent`, { status: 'opted_out', source: 'Recorded by ' + state.user.name }); render(); onChange(); } break;
          case 'text': formModal({ title: 'Reply on WhatsApp', fields: [{ name: 'text', label: 'Message', type: 'textarea', required: true }], submitText: 'Send', onSubmit: async (v) => { await post('/api/whatsapp/send-text', { customer_id: id, text: v.text }); toast('Sent', 'success'); render(); } }); break;
        }
      } catch (er) { fail(er); }
    };
  };
  await render();
}
