import { html, raw, mount, $, $$, state, can, get, post, put, del, qs, money, baseMoney, num, pct, fdate, fdt, badge, toast, fail, modal, formModal, confirmDialog, table, setQuery, esc, debounce } from '../core.js';

export default async function (view, q) {
  q.tab ||= 'campaigns'; const w = can('marketing:write');
  const st = await get('/api/whatsapp/status');
  mount(view, html`<div class="page-head"><div class="grow"><h1>WhatsApp Marketing</h1><p>Compliant campaigns via the official WhatsApp Business Platform. Only customers who opted in are messaged.</p></div>${w ? html`<button class="btn primary" id="new">+ New campaign</button>` : ''}</div>
    <div id="status"></div><div class="tabs" id="tabs">${[['campaigns', 'Campaigns'], ['segments', 'Customer segments'], ['templates', 'Message templates'], ['consent', 'Consent & opt-outs']].map(([k, l]) => html`<button data-t="${k}">${l}</button>`)}</div><div id="body"></div>`);
  const drawStatus = (s) => mount($('#status', view), s.connection === 'connected'
    ? html`<div class="alert good">✔ Connected to WhatsApp as <b>${s.last_test.verified_name}</b> (${s.last_test.display_phone_number}). ${!s.webhook_ready ? 'Webhook secrets missing: delivery/read receipts and replies will not be tracked.' : ''}</div>`
    : s.connection === 'not_configured' ? html`<div class="alert warn"><b>WhatsApp is not connected.</b> You can prepare segments, templates and campaigns, but nothing can be sent until the server has the credentials: <code>${s.missing.join(', ')}</code>. See <i>docs/WHATSAPP_SETUP.md</i>.</div>`
    : html`<div class="alert ${s.connection === 'failed' ? 'bad' : 'warn'}">${s.connection === 'failed' ? html`Last connection test failed: ${s.last_test.error}` : 'Credentials found but the connection has not been tested.'} ${w ? html`<button class="btn sm" id="test">Test connection</button>` : ''}</div>`);
  drawStatus(st); $('#test', view)?.addEventListener('click', async () => { try { drawStatus(await post('/api/whatsapp/test')); } catch (e) { fail(e); } });
  $('#new', view)?.addEventListener('click', () => campaignWizard({}, load));
  $('#tabs', view).onclick = (e) => { if (e.target.dataset.t) { q.tab = e.target.dataset.t; load(); } };
  async function load() { setQuery(q); $$('#tabs button', view).forEach((b) => b.classList.toggle('on', b.dataset.t === q.tab)); await ({ campaigns, segments, templates, consent }[q.tab] || campaigns)($('#body', view)); }

  async function campaigns(body) {
    const rows = await get('/api/whatsapp/campaigns');
    mount(body, html`<div class="card flush">${table([{ label: 'Campaign', render: (c) => html`<b>${c.name}</b><div class="muted small">${c.template_name} · ${fdate(c.created_at)}</div>` }, { label: 'Status', render: (c) => html`${badge(c.status)}${c.status === 'scheduled' ? html`<div class="small muted">${fdt(c.scheduled_at)}</div>` : ''}${c.error ? html`<div class="small bad">${c.error}</div>` : ''}` },
      { label: 'Targeted', class: 'right', render: (c) => c.targeted || '–' }, { label: 'Eligible', class: 'right', render: (c) => c.eligible || '–' }, { label: 'Sent', class: 'right', render: (c) => c.stats.sent }, { label: 'Delivered', class: 'right', render: (c) => c.stats.delivered }, { label: 'Read', class: 'right', render: (c) => c.stats.read }, { label: 'Failed', class: 'right', render: (c) => (c.stats.failed ? html`<b class="bad">${c.stats.failed}</b>` : 0) }, { label: 'Replies', class: 'right', render: (c) => c.stats.replies },
      { label: 'Orders', class: 'right', render: (c) => c.stats.attributed_orders }, { label: 'Revenue', class: 'right mono', render: (c) => baseMoney(c.stats.attributed_revenue) }], rows, { rowAttr: true, empty: 'No campaigns yet', emptyHint: 'Create one to reach your opted-in customers.' })}</div>
      <p class="small muted">“Orders / Revenue” are orders placed within ${'the attribution window'} after a customer received the campaign message (estimate of influence, not proof of causation).</p>`);
    body.onclick = (e) => { const tr = e.target.closest('tr[data-row]'); if (tr) campaignDetail(rows[Number(tr.dataset.row)].id, load); };
    if (q.segment && w) { const seg = q.segment; delete q.segment; setQuery(q); campaignWizard({ segmentKey: seg }, load); }
  }

  async function segments(body) {
    const r = await get('/api/whatsapp/segments');
    mount(body, html`<div class="toolbar"><span class="grow"></span>${w ? html`<button class="btn" id="cs">+ Custom segment</button>` : ''}</div><div class="card flush">${table([{ label: 'Segment', render: (s) => html`<b>${s.name}</b>` }, { label: 'Customers', class: 'right', render: (s) => s.targeted }, { label: 'Can receive marketing', class: 'right', render: (s) => html`<b>${s.eligible_marketing}</b>` }, { label: '', render: (s) => (w ? html`<button class="btn sm primary" data-seg="${s.key}" data-id="${s.id || ''}">Create campaign</button>${s.key === 'saved' ? html` <button class="btn sm ghost danger" data-delseg="${s.id}">✕</button>` : ''}` : '') }], [...r.builtin, ...r.saved])}</div>
      <p class="small muted">“Can receive marketing” counts customers with a recorded opt-in, a WhatsApp number, who are not on the suppression list. Inactivity periods are configurable in Settings.</p>`);
    $('#cs', body)?.addEventListener('click', () => customSegment(r, load));
    body.onclick = async (e) => { const b = e.target.closest('[data-seg]'); const d = e.target.closest('[data-delseg]');
      if (b) campaignWizard({ segmentKey: b.dataset.seg, savedId: b.dataset.id }, load);
      if (d && await confirmDialog({ title: 'Delete segment?', message: 'Campaigns already created keep working.', danger: true, confirmText: 'Delete' })) { await del('/api/whatsapp/segments/' + d.dataset.delseg); load(); } };
  }

  async function templates(body) {
    const rows = await get('/api/whatsapp/templates');
    mount(body, html`<div class="toolbar"><p class="muted small grow" style="margin:0">WhatsApp requires business-initiated messages to use templates approved by Meta. Submit a template, then sync its status once Meta has reviewed it (usually minutes to hours).</p>${w ? html`<button class="btn" id="sync" ${raw(st.can_manage_templates ? '' : 'disabled title="Needs WHATSAPP_BUSINESS_ACCOUNT_ID"')}>↻ Sync status from Meta</button><button class="btn primary" id="nt">+ New template</button>` : ''}</div>
      <div class="card flush">${table([{ label: 'Template', render: (t) => html`<b>${t.name}</b><div class="muted small">${t.category} · ${t.language} · <code>${t.wa_name}</code></div>` }, { label: 'Message', render: (t) => html`<span class="small" style="white-space:pre-wrap">${t.body}</span>${t.warnings.map((x) => html`<div class="small warn">⚠ ${x}</div>`)}${t.meta_reason ? html`<div class="small bad">Rejected: ${t.meta_reason}</div>` : ''}` }, { label: 'Meta status', render: (t) => badge(t.meta_status, t.meta_status === 'LOCAL_DRAFT' ? 'not submitted' : t.meta_status.toLowerCase()) },
        { label: '', render: (t) => html`<div class="nowrap"><button class="btn sm" data-pv="${t.id}">Preview</button>${w ? html` ${['LOCAL_DRAFT', 'REJECTED'].includes(t.meta_status) ? html`<button class="btn sm" data-ed="${t.id}">Edit</button> <button class="btn sm primary" data-sub="${t.id}" ${raw(st.can_manage_templates && !t.warnings.length ? '' : 'disabled')}>Submit</button>` : ''} <button class="btn sm ghost" data-dup="${t.id}">Duplicate</button>` : ''}</div>` }], rows)}</div>`);
    $('#nt', body)?.addEventListener('click', () => tplForm(null, load)); $('#sync', body)?.addEventListener('click', async () => { try { const r = await post('/api/whatsapp/templates/sync'); toast(`${r.updated} template(s) updated`, 'success'); load(); } catch (e) { fail(e); } });
    body.onclick = async (e) => { const g = (a) => e.target.closest(`[${a}]`)?.getAttribute(a); const find = (id) => rows.find((x) => x.id == id);
      try {
        if (g('data-pv')) previewTpl(find(g('data-pv'))); else if (g('data-ed')) tplForm(find(g('data-ed')), load);
        else if (g('data-dup')) { await post(`/api/whatsapp/templates/${g('data-dup')}/duplicate`); load(); }
        else if (g('data-sub')) { if (await confirmDialog({ title: 'Submit to WhatsApp for approval?', message: 'Once submitted the wording cannot be changed. Meta will review it.', confirmText: 'Submit' })) { await post(`/api/whatsapp/templates/${g('data-sub')}/submit`); toast('Submitted. Sync later to see the result.', 'success'); load(); } }
      } catch (er) { fail(er); } };
  }

  async function consent(body) {
    const [c, sup] = await Promise.all([get('/api/whatsapp/consents' + qs({ status: q.cs })), get('/api/whatsapp/suppression')]);
    mount(body, html`<div class="kpis"><div class="kpi"><div class="l">Opted in</div><div class="v good">${c.counts.opted_in}</div></div><div class="kpi"><div class="l">Opted out</div><div class="v bad">${c.counts.opted_out}</div></div><div class="kpi"><div class="l">No consent recorded</div><div class="v">${c.counts.none}</div></div><div class="kpi"><div class="l">Suppression list</div><div class="v">${sup.length}</div></div></div>
      <div class="alert">Promotional messages are only sent to customers with a recorded opt-in. Customers can reply <b>STOP</b> at any time to opt out automatically. Record consent on the customer profile (with how it was obtained).</div>
      <div class="grid g2"><div class="card flush"><div style="padding:12px 16px;display:flex;gap:8px"><h2 style="margin:0;flex:1">Customer consent</h2><select id="cf"><option value="">All</option><option value="opted_in" ${raw(q.cs === 'opted_in' ? 'selected' : '')}>Opted in</option><option value="opted_out" ${raw(q.cs === 'opted_out' ? 'selected' : '')}>Opted out</option><option value="none" ${raw(q.cs === 'none' ? 'selected' : '')}>None</option></select></div>${table([{ label: 'Customer', render: (x) => html`<a href="#/customers?open=${x.id}">${x.name}</a><div class="muted small">${x.whatsapp || 'no WhatsApp number'}</div>` }, { label: 'Consent', render: (x) => badge(x.consent, x.consent === 'none' ? 'none' : x.consent.replace('_', ' ')) }], c.rows.slice(0, 200), { empty: 'No customers' })}</div>
        <div class="card flush"><div style="padding:12px 16px;display:flex;gap:8px"><h2 style="margin:0;flex:1">Suppression list</h2>${w ? html`<button class="btn sm" id="addsup">+ Add number</button>` : ''}</div>${table([{ label: 'Number', render: (x) => html`${x.phone}<div class="muted small">${x.customer_name || ''}</div>` }, { label: 'Reason', render: (x) => x.reason }, { label: 'Since', render: (x) => fdate(x.created_at) }], sup, { empty: 'Nobody has opted out yet' })}</div></div>`);
    $('#cf', body).onchange = (e) => { q.cs = e.target.value; load(); };
    $('#addsup', body)?.addEventListener('click', () => formModal({ title: 'Add to suppression list', fields: [{ name: 'phone', label: 'Phone number', required: true, type: 'tel' }, { name: 'reason', label: 'Reason' }], onSubmit: async (v) => { await post('/api/whatsapp/suppression', v); load(); } }));
  }
  await load();
}

// ---------------- dialogs ----------------
async function campaignDetail(id, onChange) {
  const c = await get('/api/whatsapp/campaigns/' + id).catch(fail); if (!c) return; const s = c.stats;
  const m = modal({ title: c.name, size: 'xl', footer: false, body: html`<div style="display:flex;gap:8px;margin-bottom:10px">${badge(c.status)} <span class="muted">${c.template_name}</span></div>${c.error ? html`<div class="alert bad">${c.error}</div>` : ''}
    <div class="kpis"><div class="kpi"><div class="l">Targeted</div><div class="v">${c.targeted}</div></div><div class="kpi"><div class="l">Eligible</div><div class="v">${c.eligible}</div></div><div class="kpi"><div class="l">Sent</div><div class="v">${s.sent}</div></div><div class="kpi"><div class="l">Delivered</div><div class="v">${s.delivered}</div></div><div class="kpi"><div class="l">Read</div><div class="v">${s.read}</div></div><div class="kpi"><div class="l">Failed</div><div class="v ${s.failed ? 'bad' : ''}">${s.failed}</div></div><div class="kpi"><div class="l">Replies</div><div class="v">${s.replies}</div></div><div class="kpi"><div class="l">Attributed orders</div><div class="v">${s.attributed_orders}</div><div class="d muted small">${baseMoney(s.attributed_revenue)}</div></div></div>
    ${Object.keys(c.excluded || {}).length ? html`<div class="alert">Excluded from the audience: ${Object.entries(c.excluded).map(([k, v]) => `${v} × ${k.replaceAll('_', ' ')}`).join(', ')}</div>` : ''}
    <p class="small muted">Read receipts are only available for customers who have read receipts enabled.</p>
    <div class="toolbar">${['scheduled', 'sending', 'draft'].includes(c.status) && can('marketing:write') ? html`<button class="btn danger" id="cn">Cancel campaign</button>` : ''}${['draft', 'cancelled', 'failed'].includes(c.status) && can('marketing:write') ? html`<button class="btn danger" id="dl">Delete</button>` : ''}${c.status === 'draft' && can('marketing:write') ? html`<button class="btn primary" id="go">Review & send</button>` : ''}</div>
    ${table([{ label: 'Customer', render: (x) => x.customer_name || x.phone }, { label: 'Status', render: (x) => html`${badge(x.status)}${x.error ? html`<div class="small bad">${x.error}</div>` : ''}` }, { label: 'Sent', render: (x) => fdt(x.sent_at) }, { label: 'Message', render: (x) => html`<span class="small">${x.body}</span>` }], c.messages, { empty: 'No messages yet' })}` });
  $('#cn', m.body)?.addEventListener('click', async () => { if (await confirmDialog({ title: 'Cancel campaign?', message: 'Messages not yet sent will be skipped.', danger: true, confirmText: 'Cancel campaign' })) { await post(`/api/whatsapp/campaigns/${id}/cancel`).catch(fail); m.close(); onChange(); } });
  $('#dl', m.body)?.addEventListener('click', async () => { await del('/api/whatsapp/campaigns/' + id).catch(fail); m.close(); onChange(); });
  $('#go', m.body)?.addEventListener('click', () => { m.close(); reviewAndSend(id, onChange); });
}

async function reviewAndSend(id, onChange) {
  const pv = await post(`/api/whatsapp/campaigns/${id}/preview`).catch(fail); if (!pv) return;
  const m = modal({ title: 'Review campaign', size: 'wide', body: html`<div class="kpis"><div class="kpi"><div class="l">Targeted in segment</div><div class="v">${pv.targeted}</div></div><div class="kpi"><div class="l">Will receive message</div><div class="v good">${pv.eligible}</div></div></div>
    ${Object.keys(pv.excluded).length ? html`<div class="alert">Excluded: ${Object.entries(pv.excluded).map(([k, v]) => `${v} × ${k.replaceAll('_', ' ')}`).join(', ')}</div>` : ''}
    ${pv.problems.length ? html`<div class="alert warn">Some customers lack a value for a placeholder and will be skipped: ${pv.problems.map((p) => p.customer + ' (' + p.missing.join(', ') + ')').join('; ')}</div>` : ''}
    ${pv.send_blockers.length ? html`<div class="alert bad"><b>Cannot send yet:</b><ul style="margin:4px 0 0 18px">${pv.send_blockers.map((b) => html`<li>${b}</li>`)}</ul></div>` : ''}
    <h3>Message previews</h3><div class="pill-list" style="flex-direction:column;gap:10px">${pv.samples.map((s) => html`<div><div class="small muted">To ${s.customer} (${s.phone})</div><div class="tpl-preview">${s.text}</div></div>`)}</div>
    <div class="field" style="margin-top:14px"><label>When to send</label><div class="seg" id="when"><button type="button" data-w="now" class="on">Send now</button><button type="button" data-w="later">Schedule…</button></div><input type="datetime-local" id="at" hidden style="margin-top:8px"></div>` });
  let mode = 'now'; $('#when', m.body).onclick = (e) => { if (!e.target.dataset.w) return; mode = e.target.dataset.w; $$('#when button', m.body).forEach((b) => b.classList.toggle('on', b === e.target)); $('#at', m.body).hidden = mode === 'now'; };
  m.foot.innerHTML = `<button class="btn" data-no>Close</button><button class="btn primary" data-yes ${pv.send_blockers.length ? 'disabled' : ''}>Confirm</button>`; $('[data-no]', m.foot).onclick = () => m.close();
  $('[data-yes]', m.foot).onclick = async () => { try { const at = mode === 'later' ? new Date($('#at', m.body).value).toISOString() : undefined; if (mode === 'later' && !$('#at', m.body).value) return toast('Choose a date and time', 'error'); await post(`/api/whatsapp/campaigns/${id}/send`, { scheduled_at: at }); toast(mode === 'now' ? 'Campaign is sending' : 'Campaign scheduled', 'success'); m.close(); onChange(); } catch (e) { fail(e); } };
}

async function campaignWizard(init, onDone) {
  const [seg, tpls] = await Promise.all([get('/api/whatsapp/segments'), get('/api/whatsapp/templates')]).catch((e) => { fail(e); return []; }); if (!seg) return;
  const products = await get('/api/products?active=1&limit=500').then((r) => r.rows).catch(() => []);
  const opts = [...seg.builtin.map((s) => ({ v: 'b:' + s.key, l: `${s.name} (${s.eligible_marketing}/${s.targeted})` })), ...seg.saved.map((s) => ({ v: 's:' + s.id, l: `★ ${s.name} (${s.eligible_marketing}/${s.targeted})` })), { v: 'product', l: 'Customers who bought a specific product…' }];
  const initial = init.savedId ? 's:' + init.savedId : init.segmentKey ? 'b:' + init.segmentKey : 'b:all';
  const m = modal({ title: 'New campaign', size: 'wide', body: html`<form id="cw"><div class="field"><label>Campaign name *</label><input id="name" required maxlength="120" placeholder="e.g. Autumn reactivation"></div>
    <div class="frow"><div class="field"><label>1. Customer segment</label><select id="seg">${opts.map((o) => html`<option value="${o.v}" ${raw(o.v === initial ? 'selected' : '')}>${o.l}</option>`)}</select><span class="hint">Numbers show customers who can receive marketing / total in segment</span></div><div class="field" id="prodf" hidden><label>Product</label><select id="prod">${products.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div></div>
    <div id="audience" class="alert">Checking audience…</div>
    <div class="field"><label>2. Message template</label><select id="tpl">${tpls.map((t) => html`<option value="${t.id}">${t.name}${t.usable ? '' : ' - not approved yet'}</option>`)}</select></div>
    <div class="frow"><div class="field"><label>Discount <span class="muted">{discount}</span></label><input id="discount" placeholder="e.g. 15%"></div><div class="field"><label>Offer expiry <span class="muted">{offer_expiry}</span></label><input id="expiry" placeholder="e.g. 30 Nov"></div><div class="field"><label>Product name <span class="muted">{product_name}</span></label><input id="pname" placeholder="blank = each customer's last product"></div></div>
    <h3>3. Preview</h3><div class="tpl-preview" id="pv"></div><div class="small muted" id="pvn"></div><div class="alert bad" id="merr" hidden></div></form>` });
  const segDef = () => { const v = $('#seg', m.body).value; if (v === 'product') return { key: 'product', product_id: Number($('#prod', m.body).value) }; if (v.startsWith('s:')) return { key: 'saved', id: Number(v.slice(2)) }; return { key: v.slice(2) }; };
  const refreshAud = debounce(async () => { $('#prodf', m.body).hidden = $('#seg', m.body).value !== 'product'; try { const a = await post('/api/whatsapp/segments/preview', { segment: segDef(), category: tpls.find((t) => t.id == $('#tpl', m.body).value)?.category }); $('#audience', m.body).className = a.eligible ? 'alert good' : 'alert warn'; $('#audience', m.body).innerHTML = `<b>${a.eligible}</b> of ${a.targeted} customers will receive this${Object.keys(a.excluded).length ? ` · excluded: ${Object.entries(a.excluded).map(([k, v]) => `${v} ${esc(k.replaceAll('_', ' '))}`).join(', ')}` : ''}`; } catch (e) { $('#audience', m.body).textContent = e.message; } }, 200);
  const refreshPv = async () => { const t = tpls.find((x) => x.id == $('#tpl', m.body).value); if (!t) return; const vars = { discount: $('#discount', m.body).value || '{discount}', offer_expiry: $('#expiry', m.body).value || '{offer_expiry}', product_name: $('#pname', m.body).value || '{product_name}' }; const r = await post(`/api/whatsapp/templates/${t.id}/preview`, { vars }).catch(() => null); $('#pv', m.body).textContent = r?.text || t.body; $('#pvn', m.body).textContent = `Category: ${t.category} · ${t.usable ? 'approved by WhatsApp' : 'NOT approved yet: you can save the campaign but not send it'}`; };
  $('#cw', m.body).addEventListener('input', () => refreshPv()); $('#cw', m.body).addEventListener('change', () => { refreshAud(); refreshPv(); }); refreshAud(); refreshPv();
  m.foot.innerHTML = '<button class="btn" data-no type="button">Cancel</button><button class="btn primary" data-yes type="button">Save & review</button>'; $('[data-no]', m.foot).onclick = () => m.close();
  $('[data-yes]', m.foot).onclick = async () => {
    if (!$('#name', m.body).value.trim()) return $('#name', m.body).focus();
    try { const c = await post('/api/whatsapp/campaigns', { name: $('#name', m.body).value, segment: segDef(), template_id: Number($('#tpl', m.body).value), params: { discount: $('#discount', m.body).value, offer_expiry: $('#expiry', m.body).value, product_name: $('#pname', m.body).value } }); m.close(); onDone(); reviewAndSend(c.id, onDone); }
    catch (e) { const er = $('#merr', m.body); er.textContent = e.message; er.hidden = false; }
  };
}

function customSegment(meta, onDone) {
  formModal({ title: 'Custom segment', size: 'wide', submitText: 'Save segment', fields: [
    { name: 'name', label: 'Segment name', required: true, full: true }, { name: 'min_orders', label: 'Minimum orders', type: 'number', min: 0 }, { name: 'max_orders', label: 'Maximum orders', type: 'number', min: 0 },
    { name: 'min_spend', label: 'Minimum total spend', type: 'money' }, { name: 'max_spend', label: 'Maximum total spend', type: 'money' }, { name: 'bought_within_days', label: 'Bought within the last N days', type: 'number', min: 1 }, { name: 'not_bought_within_days', label: 'Has NOT bought for N+ days', type: 'number', min: 1 },
    { name: 'category', label: 'Customer category', type: 'select', options: [['', 'Any'], ...meta.categories] }, { name: 'location', label: 'Location contains' }, { name: 'has_balance', label: 'Only customers with an outstanding balance', type: 'checkbox' }],
    onSubmit: async (v) => { const rules = {}; for (const k of ['min_orders', 'max_orders', 'min_spend', 'max_spend', 'bought_within_days', 'not_bought_within_days']) if (v[k] != null) rules[k] = v[k]; if (v.category) rules.category = v.category; if (v.location) rules.location = v.location; if (v.has_balance) rules.has_balance = true; await post('/api/whatsapp/segments', { name: v.name, rules }); toast('Segment saved', 'success'); onDone(); } });
}
function tplForm(t, onDone) {
  const ph = ['customer_name', 'order_number', 'product_name', 'last_purchase', 'discount', 'offer_expiry', 'business_name'];
  formModal({ title: t ? `Edit ${t.name}` : 'New template', size: 'wide', values: t || { category: 'MARKETING', language: 'en' }, submitText: 'Save', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category', type: 'select', options: [['MARKETING', 'Marketing (promotions, offers; needs opt-in)'], ['UTILITY', 'Utility (order/delivery/payment updates)']] }, { name: 'language', label: 'Language code', hint: 'e.g. en, ar, fr' }, { name: 'body', label: 'Message', type: 'textarea', required: true, hint: 'Placeholders: ' + ph.map((p) => '{' + p + '}').join(' ') + '. Do not start or end with a placeholder.' }],
    onSubmit: async (v) => { t ? await put('/api/whatsapp/templates/' + t.id, v) : await post('/api/whatsapp/templates', v); toast('Template saved', 'success'); onDone(); } });
}
async function previewTpl(t) {
  const r = await post(`/api/whatsapp/templates/${t.id}/preview`, {}).catch(fail); if (!r) return;
  modal({ title: t.name, footer: false, body: html`<p class="small muted">Preview with sample values</p><div class="tpl-preview">${r.text}</div><p class="small muted" style="margin-top:12px">Sent to WhatsApp as: <code>${t.meta_body}</code></p>` });
}
