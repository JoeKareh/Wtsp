import { html, raw, mount, $, $$, state, can, get, post, put, del, qs, money, baseMoney, num, fdate, fdt, badge, toast, fail, modal, formModal, confirmDialog, table, setQuery, debounce, download } from '../core.js';
import { chatBtn } from '../chat.js'; import { importDialog } from './import.js';
import { drawBars } from '../charts.js';

export default async function (view, q) {
  q.tab ||= 'products';
  const meta = await get('/api/products/meta'); const w = can('products:write'); const fin = can('finance:read');
  mount(view, html`<div class="page-head"><div class="grow"><h1>Products & Inventory</h1><p>Stock levels update automatically as orders move through your workflow (rule: deduct at <b>${state.boot.settings.stock_deduction}</b>).</p></div>${w ? html`<button class="btn" id="imp">Import</button> <button class="btn primary" id="new">+ New product</button>` : ''}</div>
    <div id="summary"></div><div class="tabs" id="tabs"><button data-t="products">Products</button><button data-t="movements">Stock movements</button>${w ? html`<button data-t="setup">Categories & suppliers</button>` : ''}</div><div id="body"></div>`);
  $('#imp', view)?.addEventListener('click', () => importDialog('products', load));
  $('#new', view)?.addEventListener('click', () => productForm(null, meta, load));
  $('#tabs', view).onclick = (e) => { if (e.target.dataset.t) { q.tab = e.target.dataset.t; load(); } };
  async function load() {
    setQuery(q); $$('#tabs button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === q.tab));
    const s = await get('/api/inventory/summary').catch(fail); if (!s) return;
    const t = s.totals; const flt = (st) => `#/products?stock=${st}`;
    mount($('#summary', view), html`<div class="kpis"><a class="kpi" href="#/products"><div class="l">Active products</div><div class="v">${t.products}</div></a><a class="kpi" href="${flt('out')}"><div class="l">Out of stock</div><div class="v ${t.out ? 'bad' : ''}">${t.out}</div></a><a class="kpi" href="${flt('low')}"><div class="l">Low stock</div><div class="v ${t.low ? 'warn' : ''}">${t.low}</div></a><a class="kpi" href="${flt('high')}"><div class="l">Above max</div><div class="v">${t.high}</div></a>
      <div class="kpi"><div class="l">Fast-moving</div><div class="v">${t.fast}</div></div><div class="kpi"><div class="l">Slow-moving</div><div class="v">${t.slow}</div></div><div class="kpi"><div class="l">Shortage risk</div><div class="v ${t.shortage_risk ? 'bad' : ''}">${t.shortage_risk}</div><div class="d muted small">stock &lt; ${state.boot.settings.lead_time_days ?? 7} days of demand</div></div>${fin ? html`<div class="kpi"><div class="l">Stock value (at cost)</div><div class="v">${baseMoney(t.stock_cost_value)}</div></div>` : ''}</div>`);
    await ({ products, movements, setup }[q.tab] || products)($('#body', view), s);
  }
  async function products(body, s) {
    mount(body, html`<div class="toolbar"><input type="search" class="search" id="q" placeholder="Search name, SKU, barcode" value="${q.q || ''}"><select id="cat"><option value="">All categories</option>${meta.categories.map((c) => html`<option value="${c.id}" ${raw(String(q.category_id) === String(c.id) ? 'selected' : '')}>${c.name}</option>`)}</select>
      <select id="stk"><option value="">Any stock level</option>${[['out', 'Out of stock'], ['low', 'Low'], ['high', 'Above max'], ['ok', 'OK']].map(([v, l]) => html`<option value="${v}" ${raw(q.stock === v ? 'selected' : '')}>${l}</option>`)}</select><select id="sts"><option value="">Active only</option><option value="all" ${raw(q.status === 'all' ? 'selected' : '')}>All statuses</option><option ${raw(q.status === 'Inactive' ? 'selected' : '')}>Inactive</option><option ${raw(q.status === 'Discontinued' ? 'selected' : '')}>Discontinued</option></select><span class="grow"></span><button class="btn sm" id="csv">⬇ Inventory report</button></div><div class="card flush" id="tbl"></div>`);
    const draw = async () => {
      const r = await get('/api/products' + qs({ q: q.q, category_id: q.category_id, stock: q.stock, status: q.status === 'all' ? '' : q.status || undefined, active: !q.status ? '1' : '', limit: 500 }));
      const info = new Map(s.rows.map((x) => [x.id, x]));
      mount($('#tbl', body), table([
        { label: 'Product', render: (p) => html`<b>${p.name}</b><div class="muted small">${p.code}${p.sku ? ' · ' + p.sku : ''}${p.category ? ' · ' + p.category : ''}</div>` },
        { label: 'In stock', class: 'right', render: (p) => html`<b>${num(p.quantity, 3)}</b>` }, { label: 'Min / Max', class: 'right small', render: (p) => `${p.min_stock} / ${p.max_stock ?? '–'}` },
        { label: 'Level', render: (p) => badge(p.stock_state, { out: 'Out of stock', low: 'Low', high: 'Too high', ok: 'OK' }[p.stock_state]) },
        { label: 'Sold 30d', class: 'right', render: (p) => { const i = info.get(p.id); return i ? html`${num(i.sold_30d, 1)}${i.fast_moving ? ' 🔥' : ''}${i.slow_moving ? ' 🐢' : ''}` : '–'; } },
        { label: 'Cover', class: 'right', render: (p) => { const i = info.get(p.id); return i?.days_cover != null ? html`<span class="${i.shortage_risk ? 'bad' : ''}">${i.days_cover}d</span>` : '–'; } },
        ...(fin ? [{ label: 'Cost', class: 'right mono', render: (p) => money(p.cost, p.currency) }] : []), { label: 'Price', class: 'right mono', render: (p) => money(p.price, p.currency) },
        ...(fin ? [{ label: 'Margin', class: 'right', render: (p) => (p.margin_pct != null ? p.margin_pct + '%' : '–') }] : []),
        { label: '', render: (p) => (w ? html`${p.supplier_id && (p.stock_state === 'out' || p.stock_state === 'low') ? chatBtn({ supplier: p.supplier_id, product: p.id, purpose: 'reorder' }, 'Reorder', 'btn sm') : ''} <button class="btn sm" data-stock="${p.id}">Stock</button> <button class="btn sm ghost" data-edit="${p.id}">Edit</button>` : '') },
      ], r.rows, { empty: 'No products', emptyHint: 'Add your first product with “New product”.', rowClass: (p) => (p.stock_state === 'out' ? 'row-bad' : p.stock_state === 'low' ? 'row-warn' : '') }));
      $('#tbl', body).onclick = async (e) => {
        const st = e.target.closest('[data-stock]'); const ed = e.target.closest('[data-edit]'); const id = Number((st || ed)?.dataset.stock || (st || ed)?.dataset.edit); if (!id) return;
        const prod = r.rows.find((x) => x.id === id); if (st) stockForm(prod, load); else productForm(prod, meta, load);
      };
    };
    $('#q', body).oninput = debounce((e) => { q.q = e.target.value; draw(); }, 300);
    $('#cat', body).onchange = (e) => { q.category_id = e.target.value; draw(); }; $('#stk', body).onchange = (e) => { q.stock = e.target.value; draw(); }; $('#sts', body).onchange = (e) => { q.status = e.target.value; draw(); };
    $('#csv', body).onclick = () => download('/api/reports/inventory?format=xlsx');
    await draw();
  }
  async function movements(body) {
    const r = await get('/api/inventory/movements?limit=200');
    mount(body, html`<div class="card flush">${table([{ label: 'When', render: (m) => fdt(m.created_at) }, { label: 'Product', render: (m) => html`${m.product} <span class="muted small">${m.code}</span>` }, { label: 'Type', render: (m) => badge(m.type, { sale: 'Sale', return: 'Return', order_cancel: 'Order cancelled/edited', purchase: 'Stock in', damage: 'Damaged', adjustment: 'Adjustment', initial: 'Opening stock' }[m.type]) }, { label: 'Change', class: 'right mono', render: (m) => html`<b class="${m.qty_change < 0 ? 'bad' : 'good'}">${m.qty_change > 0 ? '+' : ''}${num(m.qty_change, 3)}</b>` }, { label: 'Balance', class: 'right', render: (m) => num(m.qty_after, 3) }, { label: 'Note', render: (m) => m.note || '' }, { label: 'By', render: (m) => m.user_name || 'system' }], r.rows, { empty: 'No stock movements yet' })}</div>`);
  }
  async function setup(body) {
    mount(body, html`<div class="grid g2"><div class="card"><h2>Product categories</h2><div id="cats"></div><button class="btn sm" id="addcat">+ Add category</button></div><div class="card"><h2>Suppliers</h2><div id="sups"></div><button class="btn sm" id="addsup">+ Add supplier</button></div></div>`);
    const draw = async () => {
      const m2 = await get('/api/products/meta'); meta.categories = m2.categories; meta.suppliers = m2.suppliers;
      mount($('#cats', body), html`${m2.categories.length ? m2.categories.map((c) => html`<div style="display:flex;gap:6px;padding:4px 0"><span style="flex:1">${c.name}</span><button class="btn sm ghost" data-rc="${c.id}">Rename</button><button class="btn sm ghost danger" data-dc="${c.id}">✕</button></div>`) : html`<p class="muted">No categories yet.</p>`}`);
      mount($('#sups', body), html`${m2.suppliers.length ? m2.suppliers.map((c) => html`<div style="display:flex;gap:6px;padding:4px 0"><span style="flex:1">${c.name} <span class="muted small">${c.phone}</span></span>${c.phone ? chatBtn({ supplier: c.id, purpose: 'reorder' }, 'Reorder', 'btn sm ghost') : ''}<button class="btn sm ghost" data-es="${c.id}">Edit</button><button class="btn sm ghost danger" data-ds="${c.id}">✕</button></div>`) : html`<p class="muted">No suppliers yet.</p>`}`);
    };
    await draw();
    $('#addcat', body).onclick = () => formModal({ title: 'New category', fields: [{ name: 'name', label: 'Name', required: true }], onSubmit: async (v) => { await post('/api/product-categories', v); draw(); } });
    $('#addsup', body).onclick = () => supForm(null);
    const supForm = (s) => formModal({ title: s ? 'Edit supplier' : 'New supplier', values: s || {}, fields: [{ name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'notes', label: 'Notes', type: 'textarea' }], onSubmit: async (v) => { s ? await put('/api/suppliers/' + s.id, v) : await post('/api/suppliers', v); draw(); } });
    body.onclick = async (e) => {
      const g = (a) => e.target.closest(`[${a}]`)?.getAttribute(a);
      if (g('data-rc')) { const c = meta.categories.find((x) => x.id == g('data-rc')); formModal({ title: 'Rename category', values: c, fields: [{ name: 'name', label: 'Name', required: true }], onSubmit: async (v) => { await put('/api/product-categories/' + c.id, v); draw(); } }); }
      if (g('data-dc') && await confirmDialog({ title: 'Delete category?', message: 'Products in it become uncategorised.', danger: true, confirmText: 'Delete' })) { await del('/api/product-categories/' + g('data-dc')); draw(); }
      if (g('data-es')) supForm(meta.suppliers.find((x) => x.id == g('data-es')));
      if (g('data-ds') && await confirmDialog({ title: 'Delete supplier?', message: 'This cannot be undone.', danger: true, confirmText: 'Delete' })) { await del('/api/suppliers/' + g('data-ds')); draw(); }
    };
  }
  await load();
}

function productForm(p, meta, onDone) {
  const s = state.boot.settings; const fin = can('finance:read');
  const fields = [
    { name: 'name', label: 'Name', required: true }, { name: 'sku', label: 'SKU' }, { name: 'barcode', label: 'Barcode' },
    { name: 'category_id', label: 'Category', type: 'select', options: [['', '—'], ...meta.categories.map((c) => [c.id, c.name])] }, { name: 'supplier_id', label: 'Supplier', type: 'select', options: [['', '—'], ...meta.suppliers.map((c) => [c.id, c.name])] },
    { name: 'currency', label: 'Price currency', type: 'select', options: s.currencies, value: s.base_currency },
    ...(fin ? [{ name: 'cost', label: 'Purchase cost', type: 'money', required: true }] : []), { name: 'price', label: 'Selling price', type: 'money', required: true },
    ...(p ? [] : [{ name: 'quantity', label: 'Opening quantity', type: 'number', step: 'any', min: 0, value: 0 }]),
    { name: 'min_stock', label: 'Minimum stock (low-stock alert)', type: 'number', step: 'any', min: 0, value: 0 }, { name: 'max_stock', label: 'Maximum stock (high-stock alert)', type: 'number', step: 'any', min: 0, hint: 'Optional' },
    { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive', 'Discontinued'] }, { name: 'description', label: 'Description', type: 'textarea' },
  ];
  return formModal({ title: p ? `Edit ${p.name}` : 'New product', fields, values: { ...p, category_id: p?.category_id ?? '', supplier_id: p?.supplier_id ?? '', max_stock: p?.max_stock ?? '' }, size: 'wide', submitText: p ? 'Save changes' : 'Create product',
    extra: !p && !fin ? html`<div class="alert warn">Purchase cost is set by an owner/admin with finance access.</div>` : '',
    onSubmit: async (v, key) => { if (!fin) delete v.cost; if (v.max_stock == null) v.max_stock = null; p ? await put('/api/products/' + p.id, v) : await post('/api/products', v, { 'Idempotency-Key': key }); toast('Product saved', 'success'); onDone?.(); window.dispatchEvent(new Event('notifications-changed')); } });
}
async function stockForm(p, onDone) {
  const detail = await get('/api/products/' + p.id).catch(fail); if (!detail) return;
  const m = formModal({ title: `Stock: ${p.name}`, submitText: 'Apply', size: 'wide',
    extra: html`<p>Currently <b>${num(p.quantity, 3)}</b> in stock (min ${p.min_stock}, max ${p.max_stock ?? 'not set'}).</p>`,
    fields: [{ name: 'type', label: 'Action', type: 'select', options: [['purchase', 'Add stock (purchase / delivery from supplier)'], ['return', 'Returned to stock (customer return)'], ['damage', 'Remove damaged / lost goods'], ['adjustment', 'Set counted quantity (stocktake)']] }, { name: 'qty', label: 'Quantity', type: 'number', step: 'any', min: 0 }, { name: 'new_quantity', label: 'Counted quantity (for stocktake)', type: 'number', step: 'any', min: 0 },
      ...(can('finance:read') ? [{ name: 'unit_cost', label: 'Unit cost (for purchases)', type: 'money' }, { name: 'update_cost', label: 'Update product cost using weighted average', type: 'checkbox' }] : []), { name: 'note', label: 'Note / reason', hint: 'Required for damage and stocktake' }],
    onSubmit: async (v, key) => { const b = { type: v.type, note: v.note }; if (v.type === 'adjustment') b.new_quantity = v.new_quantity; else b.qty = v.qty; if (v.type === 'purchase' && v.unit_cost != null) { b.unit_cost = v.unit_cost; b.update_cost = v.update_cost; } await post(`/api/products/${p.id}/stock`, b, { 'Idempotency-Key': key }); toast('Stock updated', 'success'); onDone?.(); window.dispatchEvent(new Event('notifications-changed')); } });
  const hist = detail.movements.slice(0, 8);
  m.body.insertAdjacentHTML('beforeend', `<h3 style="margin-top:12px">Recent movements</h3><div class="small">${hist.map((x) => `<div>${new Date(x.created_at).toLocaleDateString()} · ${x.type} · <b>${x.qty_change > 0 ? '+' : ''}${x.qty_change}</b> → ${x.qty_after}</div>`).join('') || '<span class="muted">none</span>'}</div>`);
}
