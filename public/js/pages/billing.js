// Billing: plan & state, usage meters, upgrade (card via Paddle when enabled, or manual transfer), invoices, cancel. Owner only.
import { html, raw, mount, $, $$, state, get, post, put, fail, toast, money, fdate, modal, formModal, confirmDialog } from '../core.js';
import { refreshWorkspace } from '../saas.js';

const STATE_LABEL = { trialing: ['Free trial', 'info'], active: ['Active', 'good'], past_due: ['Past due', 'warn'], suspended: ['Suspended', 'bad'], canceled: ['Canceled', 'bad'] };
const METERS = { users: 'Users', orders: 'Orders this month', wa_marketing: 'WhatsApp campaign messages', ai_credits: 'AI credits' };
const cm = (c, cur) => money(c, cur || 'USD').replace(/\.00$/, '');

export default async function billing(view, q) {
  let interval = 'month'; let months = 12; let S;
  const load = async () => { S = await get('/api/billing/summary'); state.workspace = S.workspace; draw(); refreshWorkspace(); };
  const draw = () => {
    const ws = S.workspace; const [stLabel, stCls] = STATE_LABEL[ws.state] || [ws.state, '']; const cur = ws.plan?.code; const manual = S.route === 'manual';
    const sub = S.subscription; const canceling = sub?.cancel_at || (ws.stored_state === 'active' && state.workspace && false);
    mount(view, html`<div class="page-head"><div class="grow"><h1>Subscription & billing</h1><p>Your plan, usage and invoices. Your data stays yours: you can always export it.</p></div></div>
      <div class="card"><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div class="grow"><div class="muted small">Current plan</div><div style="font-size:22px;font-weight:700">${ws.plan?.name || '—'} <span class="badge ${stCls}">${stLabel}</span></div>
        <div class="small muted" style="margin-top:4px">${ws.state === 'trialing' ? html`Free trial ends ${fdate(ws.trial_ends_at)} (${ws.trial_days_left} days left).` : ws.paid_through ? html`Paid through <b>${fdate(ws.paid_through)}</b>.` : ''}${canceling ? ' Cancellation scheduled.' : ''}</div></div>
        <div class="toolbar" style="margin:0">${S.route === 'paddle' && sub ? html`<button class="btn" id="portal">Manage card & invoices</button>` : ''}${ws.state !== 'canceled' ? html`<button class="btn danger" id="cancel">Cancel subscription</button>` : ''}</div></div></div>
      ${S.usage ? html`<div class="card"><h2>Usage this month</h2><div class="meters">${Object.entries(S.usage.meters).filter(([k, m]) => m.limit || m.used).map(([k, m]) => html`<div class="meter"><div class="small" style="display:flex;justify-content:space-between"><span>${METERS[k] || k}</span><b>${m.used.toLocaleString()} / ${m.limit ? m.limit.toLocaleString() : '—'}</b></div>
        <div class="bar"><span class="${m.pct >= 100 ? 'bad' : m.pct >= 80 ? 'warn' : ''}" style="width:${Math.min(100, m.pct)}%"></span></div>${m.pct >= 80 ? html`<div class="small ${m.pct >= 100 ? 'bad' : 'warn'}">${m.pct >= 100 ? 'Limit reached – upgrade to add more. You can still view and export everything.' : 'Almost at your limit.'}</div>` : ''}</div>`)}</div></div>` : ''}
      <div class="card"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px"><h2 style="margin:0">Choose a plan</h2><span class="grow"></span>
        ${S.route_options.length > 1 ? html`<select id="route" aria-label="How do you want to pay?"><option value="manual" ${manual ? 'selected' : ''}>Pay by bank transfer / Whish / OMT</option><option value="paddle" ${!manual ? 'selected' : ''}>Pay by card</option></select>` : ''}
        ${manual ? html`<select id="months" aria-label="Months">${S.plans[0].prepaid.map((p) => html`<option value="${p.months}" ${p.months === months ? 'selected' : ''}>${p.months} month${p.months > 1 ? 's' : ''}</option>`)}</select>`
          : html`<div class="seg" id="intv"><button data-i="month" class="${interval === 'month' ? 'on' : ''}">Monthly</button><button data-i="year" class="${interval === 'year' ? 'on' : ''}">Yearly (2 months free)</button></div>`}</div>
        <div class="plan-grid">${S.plans.map((p) => { const pq = p.prepaid.find((x) => x.months === months); const price = manual ? pq.amount_cents : interval === 'year' ? p.price_annual : p.price_monthly; const isCur = cur === p.code;
          return html`<div class="plan ${p.code === 'growth' ? 'pop' : ''} ${isCur ? 'cur' : ''}"><h3>${p.name}</h3><div class="pp">${cm(price, p.currency)}<small> / ${manual ? months + ' mo' : interval === 'year' ? 'year' : 'month'}</small></div>
            <ul><li>${p.limits.users} users</li><li>${p.limits.orders_month.toLocaleString()} orders / month</li>${p.limits.wa_marketing_month ? html`<li>${p.limits.wa_marketing_month.toLocaleString()} WhatsApp campaign messages</li>` : ''}${p.features.ai ? html`<li>AI assistant</li>` : ''}</ul>
            <button class="btn ${isCur && ws.state === 'active' ? '' : 'primary'}" data-plan="${p.code}" style="width:100%;justify-content:center">${isCur && ws.state === 'active' ? 'Renew / extend' : isCur ? 'Choose this plan' : 'Select'}</button></div>`; })}</div>
        ${S.route === 'paddle' && !S.card.enabled ? html`<div class="alert warn" style="margin-top:12px">Card payments are being set up and will be available soon. ${S.route_options.includes('manual') ? 'You can pay by bank transfer / Whish / OMT now.' : 'Contact support and we will activate your plan.'}</div>` : ''}</div>
      <div class="card"><h2>Invoices & receipts</h2>${S.invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Description</th><th class="right">Amount</th><th></th></tr></thead><tbody>${S.invoices.map((i) => html`<tr><td>${i.number}</td><td>${fdate(i.issued_at)}</td><td>${i.description}</td><td class="right mono">${money(i.amount_cents, i.currency)}</td><td><a class="btn sm" href="/api/billing/invoices/${i.number}/pdf" target="_blank" rel="noopener">Download PDF</a></td></tr>`)}</tbody></table></div>` : html`<p class="muted">No invoices yet.</p>`}</div>
      <div class="card"><h2>Your data</h2><p class="muted">Download everything any time, even after canceling.</p><div class="toolbar"><a class="btn" href="/api/export/all">Export all my data</a><a class="btn" href="/api/export/sqlite">Download my database</a></div></div>`);
    wire();
  };
  const wire = () => {
    $('#portal', view)?.addEventListener('click', async () => { try { const r = await post('/api/billing/portal'); if (r.url) window.open(r.url, '_blank', 'noopener'); else toast(r.message || 'Nothing to manage'); } catch (e) { fail(e); } });
    $('#cancel', view)?.addEventListener('click', cancelFlow);
    $('#route', view)?.addEventListener('change', async (e) => { try { await put('/api/billing/route', { route: e.target.value }); await load(); } catch (er) { fail(er); load(); } });
    $('#months', view)?.addEventListener('change', (e) => { months = Number(e.target.value); draw(); });
    $$('#intv button', view).forEach((b) => b.addEventListener('click', () => { interval = b.dataset.i; draw(); }));
    $$('[data-plan]', view).forEach((b) => b.addEventListener('click', () => choose(b.dataset.plan)));
  };
  const choose = async (plan) => {
    try {
      const cur = S.workspace.plan?.code;
      if (S.route === 'paddle' && cur && cur !== plan && S.subscription && ['active', 'trialing', 'past_due'].includes(S.subscription.status)) { const r = await post('/api/billing/change-plan', { plan, interval }); if (r.ok) { toast(r.message, 'success'); return load(); } }
      const r = await post('/api/billing/checkout', { plan, interval });
      if (r.provider === 'manual') return manualDialog(plan, r);
      if (r.provider === 'paddle') return await paddleCheckout(r);
      toast(r.message || 'Not available yet');
    } catch (e) { fail(e); }
  };
  const manualDialog = (plan, r) => {
    const p = S.plans.find((x) => x.code === plan); const m = modal({ title: `Pay for ${p.name} by transfer`, size: 'lg', body: html`
      <p>${r.instructions}</p><div class="table-wrap"><table><thead><tr><th>Period</th><th class="right">Amount</th><th class="right">Per month</th></tr></thead><tbody>${r.quotes.map((x) => html`<tr><td>${x.months} month${x.months > 1 ? 's' : ''}</td><td class="right mono"><b>${cm(x.amount_cents, x.currency)}</b></td><td class="right mono">${cm(x.per_month_cents, x.currency)}</td></tr>`)}</tbody></table></div>
      <p class="small muted">Use this reference in your transfer: <b>${r.reference_hint}</b>. After paying, tell us below – we confirm and activate your plan, and you get a PDF receipt by email.</p>
      <div class="frow"><div class="field"><label>Period you paid for</label><select id="mm">${r.quotes.map((x) => html`<option value="${x.months}" ${x.months === months ? 'selected' : ''}>${x.months} month${x.months > 1 ? 's' : ''}</option>`)}</select></div><div class="field"><label>Payment reference (transfer number, receipt number…)</label><input id="mr" maxlength="100"></div></div>
      <div class="field"><label>Note (optional)</label><input id="mn" maxlength="300"></div>` });
    m.foot.innerHTML = '<button class="btn" data-no type="button">Close</button><button class="btn primary" data-yes type="button">I have paid</button>'; $('[data-no]', m.foot).onclick = () => m.close();
    $('[data-yes]', m.foot).onclick = async () => { try { const x = await post('/api/billing/manual-request', { plan, months: Number($('#mm', m.body).value), reference: $('#mr', m.body).value, note: $('#mn', m.body).value }); toast(x.message, 'success'); m.close(); } catch (e) { fail(e); } };
  };
  const paddleCheckout = async (r) => {
    if (!r.client_token) throw Object.assign(new Error('Card payments are not available yet. Please contact support.'), {});
    await loadPaddle(); if (r.env === 'sandbox') window.Paddle.Environment.set('sandbox');
    window.Paddle.Initialize({ token: r.client_token, eventCallback: (ev) => { if (ev.name === 'checkout.completed') { toast('Payment received. Activating your plan…', 'success'); waitActive(); } } });
    window.Paddle.Checkout.open({ items: r.items, customData: r.customData, customer: r.customer, settings: r.settings });
  };
  const waitActive = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2500)); await load().catch(() => {}); if (S.workspace.state === 'active') { toast('Your plan is active. Thank you!', 'success'); return; } } };
  const cancelFlow = () => {
    const m = formModal({ title: 'Cancel subscription', danger: true, submitText: 'Cancel subscription', fields: [{ name: 'reason', label: 'What is the main reason? (helps us improve)', type: 'select', options: [['', 'Choose…'], 'Too expensive', 'Missing a feature I need', 'Too hard to use', 'I closed or paused my business', 'I use another tool', 'Other'] }, { name: 'delete_my_data', label: 'Also permanently delete all my data in 14 days', type: 'checkbox', hint: 'Otherwise we keep your data read-only and exportable for ' + S.delete_after_days + ' days.' }],
      extra: html`<p>You keep access until the end of the period you paid for. You can export all your data any time.</p>`, onSubmit: async (v) => { const r = await post('/api/billing/cancel', { reason: v.reason, delete_my_data: v.delete_my_data }); toast(r.message, 'success'); await load(); } }); void m;
  };
  await load(); void q; void raw; void confirmDialog;
}
let paddleP; const loadPaddle = () => paddleP ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'; s.onload = res; s.onerror = () => { paddleP = null; rej(new Error('Could not load the card payment form. Check your connection.')); }; document.head.append(s); });
