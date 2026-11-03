'use strict';
// BizControl operator console. No inline scripts (CSP); every dynamic value goes through textContent.
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'value') e.value = v; else e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : null;
  if (!r.ok) { const e = new Error((data && data.error) || `Error ${r.status}`); e.status = r.status; throw e; }
  return data;
}
const toast = (m) => { const t = h('div', { class: 'toast' }, m); $('#toasts').append(t); setTimeout(() => t.remove(), 3500); };
const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast('⚠ ' + e.message); throw e; } };
const money = (c, cur = 'USD') => (c / 100).toLocaleString(undefined, { style: 'currency', currency: cur || 'USD' });
const d = (s) => (s ? String(s).slice(0, 10) : '—');
const dt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');
const badge = (s) => h('span', { class: 'badge b-' + s }, String(s).replace('_', ' '));
const FOREVER = '2099-12-31';

const state = { admin: null, page: 'overview', q: '', status: '' };
const PAGES = [['overview', 'Overview'], ['customers', 'Customers'], ['people', 'People'], ['passes', 'Free passes'], ['payments', 'Payments'], ['plans', 'Plans'], ['activity', 'Activity'], ['emails', 'Emails']];

function table(cols, rows, onClick) {
  return h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c[0])))),
    h('tbody', {}, rows.length ? rows.map((r) => h('tr', { class: onClick ? 'click' : '', onclick: onClick ? () => onClick(r) : null }, cols.map((c) => h('td', {}, c[1](r))))) : h('tr', {}, h('td', { colspan: cols.length, class: 'mut' }, 'Nothing here yet.')))));
}

function loginView() {
  const err = h('div', { class: 'err' });
  const f = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { const r = await api('POST', '/api/admin/login', { email: f.email.value, password: f.password.value, code: f.code.value }); state.admin = r.admin; render(); }
    catch (x) { err.textContent = x.message; }
  } },
    h('label', {}, 'Email'), h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
    h('label', {}, 'Password'), h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
    h('label', {}, 'Authenticator code (or a recovery code)'), h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true }),
    err, h('button', { class: 'pri', style: 'width:100%;margin-top:12px' }, 'Sign in'));
  return h('div', { class: 'login' }, h('h1', {}, 'BizControl Admin'), h('p', { class: 'mut' }, 'Operator console. Sign-in needs your password and an authenticator code.'), f);
}

async function overview(box) {
  const m = await api('GET', '/api/admin/metrics');
  const k = (l, v) => h('div', { class: 'kpi' }, h('small', {}, l), h('div', {}, v));
  box.append(h('h2', {}, 'Overview'),
    h('div', { class: 'grid' }, k('Monthly revenue (MRR)', money(m.mrr_cents)), k('Yearly run-rate', money(m.arr_cents)), k('Paying workspaces', m.paying), k('All workspaces', m.tenants), k('New in 7 days', m.signups_7d), k('New in 30 days', m.signups_30d), k('Trials ending in 7 days', m.trials_expiring_7d), k('Canceled in 30 days', m.canceled_30d), k('Churn (30 days)', (m.churn_30d_pct ?? 0) + '%'), k('Data stored', (m.db_bytes_total / 1048576).toFixed(1) + ' MB')),
    h('h3', {}, 'Workspaces by state'), h('div', { class: 'row' }, Object.entries(m.by_status).map(([s, n]) => h('span', { class: 'card', style: 'margin:0;padding:8px 12px' }, badge(s), ' ', n))),
    h('p', { class: 'mut' }, 'Revenue counts real subscriptions only; demo workspaces and free passes are never counted as revenue.'));
}

async function customers(box) {
  const qs = new URLSearchParams(); if (state.q) qs.set('q', state.q); if (state.status) qs.set('status', state.status);
  const r = await api('GET', '/api/admin/tenants?' + qs);
  const search = h('input', { placeholder: 'Search business, address or email…', value: state.q, onkeydown: (e) => { if (e.key === 'Enter') { state.q = e.target.value; render(); } } });
  const st = h('select', { onchange: (e) => { state.status = e.target.value; render(); } }, ['', 'trialing', 'active', 'past_due', 'suspended', 'canceled', 'pending_verification', 'deleted'].map((s) => h('option', { value: s, selected: s === state.status }, s || 'All states')));
  box.append(h('h2', {}, `Customers (${r.total})`), h('div', { class: 'row' }, search, st, h('button', { onclick: () => { state.q = search.value; render(); } }, 'Search')),
    table([
      ['Business', (t) => h('div', {}, h('b', {}, t.business_name), h('div', { class: 'mut' }, t.subdomain))],
      ['Owner', (t) => t.owner_email], ['State', (t) => [badge(t.effective_status), t.flags && t.flags.comp ? ' 🎁 free' : '']], ['Plan', (t) => t.plan || '—'],
      ['Paid / free until', (t) => (t.flags && t.flags.comp ? (t.flags.comp.until === FOREVER ? 'unlimited' : d(t.flags.comp.until)) : d(t.paid_through || t.trial_ends_at))],
      ['Orders', (t) => t.order_count], ['Last seen', (t) => dt(t.last_activity_at)], ['Joined', (t) => d(t.created_at)],
    ], r.rows, (t) => openTenant(t.id)));
}

async function people(box) {
  const r = await api('GET', '/api/admin/customers' + (state.q ? '?q=' + encodeURIComponent(state.q) : ''));
  const search = h('input', { placeholder: 'Search name or email…', value: state.q, onkeydown: (e) => { if (e.key === 'Enter') { state.q = e.target.value; render(); } } });
  box.append(h('h2', {}, 'People (accounts)'), h('p', { class: 'mut' }, 'Each person signs in and pays with their own email and password. One account = one subscription holder.'), h('div', { class: 'row' }, search),
    table([['Name', (a) => a.name], ['Email', (a) => a.email], ['Country', (a) => a.country], ['Pays via', (a) => a.billing_route], ['Verified', (a) => (a.email_verified_at ? '✓' : '—')], ['Workspaces', (a) => a.workspaces], ['Paid so far', (a) => money(a.paid_cents)], ['Joined', (a) => d(a.created_at)]], r.rows, (a) => { state.q = a.email; state.page = 'customers'; render(); }));
}

async function passes(box) {
  const r = await api('GET', '/api/admin/passes'); const plans = await api('GET', '/api/admin/plans');
  const f = h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); await act(() => api('POST', '/api/admin/passes', { code: f.code.value || undefined, plan: f.plan.value, days: f.unl.checked ? undefined : Number(f.days.value), unlimited: f.unl.checked, max_uses: Number(f.uses.value), note: f.note.value })); render(); } },
    h('b', {}, 'Create a free-pass code'), h('p', { class: 'mut' }, 'Give the code to someone. They type it when signing up and get free access without paying. To give free access to an existing customer, open them under Customers.'),
    h('div', { class: 'row' }, h('input', { name: 'code', placeholder: 'Code (blank = random)' }), h('select', { name: 'plan' }, plans.map((p) => h('option', { value: p.code }, p.name))), h('input', { name: 'days', type: 'number', min: 1, value: 30, style: 'width:90px' }), h('label', { style: 'margin:0' }, h('input', { name: 'unl', type: 'checkbox', style: 'width:auto' }), ' unlimited'), h('input', { name: 'uses', type: 'number', min: 1, value: 1, style: 'width:90px', title: 'How many people can use it' }), h('input', { name: 'note', placeholder: 'Note (who is it for?)' }), h('button', { class: 'pri' }, 'Create')));
  box.append(h('h2', {}, 'Free passes'), f, table([['Code', (p) => h('b', {}, p.code)], ['Plan', (p) => p.plan_code], ['Length', (p) => (p.unlimited ? 'unlimited' : p.days + ' days')], ['Used', (p) => `${p.used} / ${p.max_uses}`], ['Note', (p) => p.note || ''], ['Status', (p) => (p.active ? 'active' : 'disabled')], ['', (p) => (p.active ? h('button', { class: 'dng', onclick: async () => { await act(() => api('DELETE', '/api/admin/passes/' + p.code), 'Disabled'); render(); } }, 'Disable') : '')]], r.rows));
}

async function payments(box) {
  const [inv, ev] = await Promise.all([api('GET', '/api/admin/invoices'), api('GET', '/api/admin/payment-events')]);
  box.append(h('h2', {}, 'Payments & invoices'), table([['Number', (i) => i.number], ['Workspace', (i) => i.subdomain], ['Description', (i) => i.description], ['Amount', (i) => money(i.amount_cents, i.currency)], ['Via', (i) => i.provider + (i.method ? ' / ' + i.method : '')], ['Date', (i) => d(i.issued_at)], ['PDF', (i) => h('a', { href: `/api/admin/invoices/${i.number}/pdf`, target: '_blank' }, 'Open')]], inv.rows),
    h('h3', {}, 'Provider events (Paddle)'), table([['When', (e) => dt(e.received_at)], ['Provider', (e) => e.provider], ['Type', (e) => e.type], ['Status', (e) => e.status + (e.error ? ' – ' + e.error : '')]], ev.rows));
}

async function plans(box) {
  const ps = await api('GET', '/api/admin/plans'); box.append(h('h2', {}, 'Plans & prices'), h('p', { class: 'mut' }, 'Changes apply to new checkouts. Prices are in US dollars.'));
  for (const p of ps) {
    const f = h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); const limits = {}; for (const k of Object.keys(p.limits)) limits[k] = Number(f['l_' + k].value); await act(() => api('PUT', '/api/admin/plans/' + p.id, { name: f.name.value, price_monthly: Math.round(f.pm.value * 100), price_annual: Math.round(f.pa.value * 100), limits, active: f.active.checked ? 1 : 0 }), 'Saved'); } },
      h('div', { class: 'row' }, h('input', { name: 'name', value: p.name, style: 'width:140px' }), h('label', { style: 'margin:0' }, '$/month ', h('input', { name: 'pm', type: 'number', step: '0.01', value: p.price_monthly / 100, style: 'width:100px' })), h('label', { style: 'margin:0' }, '$/year ', h('input', { name: 'pa', type: 'number', step: '0.01', value: p.price_annual / 100, style: 'width:110px' })), h('label', { style: 'margin:0' }, h('input', { name: 'active', type: 'checkbox', checked: !!p.active, style: 'width:auto' }), ' on sale')),
      h('div', { class: 'row' }, Object.entries(p.limits).map(([k, v]) => h('label', { style: 'margin:0' }, k.replace(/_/g, ' ') + ' ', h('input', { name: 'l_' + k, type: 'number', min: 0, value: v, style: 'width:100px' })))), h('button', { class: 'pri' }, 'Save ' + p.name));
    box.append(f);
  }
}
async function activity(box) { const r = await api('GET', '/api/admin/audit'); box.append(h('h2', {}, 'Activity log'), table([['When', (a) => dt(a.at)], ['Who', (a) => a.actor], ['What', (a) => a.action], ['Workspace', (a) => a.tenant_id || ''], ['Detail', (a) => a.detail || ''], ['IP', (a) => a.ip || '']], r.rows)); }
async function emails(box) { const r = await api('GET', '/api/admin/outbox'); box.append(h('h2', {}, 'Emails sent by the platform'), table([['When', (e) => dt(e.created_at)], ['To', (e) => e.to_addr], ['Subject', (e) => e.subject], ['Status', (e) => e.status + (e.error ? ' – ' + e.error : '')]], r.rows)); }

// ---- customer drawer ----
async function openTenant(id) {
  const close = () => { m.remove(); render(); }; const body = h('div', { class: 'drawer' }); const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) close(); } }, body); document.body.append(m);
  const load = async () => {
    const r = await api('GET', '/api/admin/tenants/' + id); const t = r.tenant; const plansList = await api('GET', '/api/admin/plans'); body.replaceChildren();
    const comp = t.flags && t.flags.comp; const call = (fn, msg) => async () => { await act(fn, msg); await load(); };
    const inp = (name, type, val, ph, w) => h('input', { name, type, value: val, placeholder: ph, style: `width:${w || 110}px` });
    const g = { days: inp('days', 'number', 30, 'days', 80), note: inp('note', 'text', '', 'note', 160), plan: h('select', {}, plansList.map((p) => h('option', { value: p.code, selected: p.code === (t.plan || 'growth') }, p.name))) };
    const pay = { months: inp('m', 'number', 1, 'months', 70), amount: inp('a', 'number', '', 'amount $', 90), method: h('select', {}, ['bank', 'whish', 'omt', 'cash'].map((x) => h('option', {}, x))), ref: inp('r', 'text', '', 'reference', 130) };
    const dev = inp('dev', 'number', (t.flags && t.flags.max_sessions) || 1, 'devices', 70);
    const result = h('div', {});
    body.append(
      h('div', { class: 'row' }, h('button', { onclick: close }, '← Back'), h('h2', { style: 'margin:0' }, t.business_name), badge(t.effective_status), comp ? h('span', { class: 'badge' }, '🎁 free ' + (comp.until === FOREVER ? '(unlimited)' : 'until ' + comp.until)) : ''),
      h('div', { class: 'card' }, h('div', {}, h('b', {}, 'Owner: '), `${t.owner_name || ''} <${t.owner_email}>`, ' · ', t.country || ''), h('div', {}, h('b', {}, 'Address: '), h('a', { href: t.url, target: '_blank', rel: 'noopener' }, t.url)), h('div', {}, h('b', {}, 'Plan: '), t.plan || '—', ` (${t.interval || 'month'}) · pays via ${t.billing_route}`),
        h('div', {}, h('b', {}, 'Trial ends: '), d(t.trial_ends_at), ' · ', h('b', {}, 'Paid through: '), d(t.paid_through)), h('div', {}, h('b', {}, 'Orders: '), t.order_count, ' · ', h('b', {}, 'Last seen: '), dt(t.last_activity_at), ' · ', h('b', {}, 'Data: '), ((t.db_bytes || 0) / 1024).toFixed(0), ' KB')),
      h('div', { class: 'card' }, h('b', {}, '🎁 Free pass'), h('p', { class: 'mut' }, 'Gives full access with no payment. Works on any customer, any time.'),
        h('div', { class: 'row' }, g.plan, g.days, g.note, h('button', { class: 'pri', onclick: call(() => api('POST', `/api/admin/tenants/${id}/grant`, { plan: g.plan.value, days: Number(g.days.value), note: g.note.value }), 'Free pass given') }, 'Give free days'), h('button', { onclick: call(() => api('POST', `/api/admin/tenants/${id}/grant`, { plan: g.plan.value, unlimited: true, note: g.note.value }), 'Unlimited free access given') }, 'Give unlimited'), comp ? h('button', { class: 'dng', onclick: call(() => api('POST', `/api/admin/tenants/${id}/revoke-pass`, {}), 'Pass removed') }, 'Remove pass') : '')),
      h('div', { class: 'card' }, h('b', {}, 'Access'), h('div', { class: 'row' },
        t.effective_status === 'suspended' || t.status === 'suspended' ? h('button', { class: 'pri', onclick: call(() => api('POST', `/api/admin/tenants/${id}/unsuspend`, {}), 'Reactivated') }, 'Reactivate') : h('button', { class: 'dng', onclick: () => { const reason = prompt('Reason for suspending (shown in the log):', 'unpaid'); if (reason !== null) call(() => api('POST', `/api/admin/tenants/${id}/suspend`, { reason }), 'Suspended')(); } }, 'Suspend'),
        inp('tdays', 'number', 7, 'days', 70), h('button', { onclick: call(() => api('POST', `/api/admin/tenants/${id}/extend-trial`, { days: Number($('input[name=tdays]', body).value) }), 'Trial extended') }, 'Extend trial (days)')),
        h('div', { class: 'row' }, h('span', { class: 'mut' }, 'Devices allowed to be signed in at once:'), dev, h('button', { onclick: call(() => api('POST', `/api/admin/tenants/${id}/sessions`, { max_sessions: Number(dev.value) }), 'Saved') }, 'Save'), h('button', { class: 'dng', onclick: call(() => api('POST', `/api/admin/tenants/${id}/logout-all`, {}), 'Everyone signed out') }, 'Sign everyone out')),
        h('p', { class: 'mut' }, 'Default is 1 device: if the login is shared, the previous person is signed out as soon as someone else signs in.')),
      h('div', { class: 'card' }, h('b', {}, 'Record a payment (bank / Whish / OMT / cash)'), h('div', { class: 'row' }, pay.months, pay.amount, pay.method, pay.ref,
        h('button', { class: 'pri', onclick: call(() => api('POST', `/api/admin/tenants/${id}/manual-payment`, { months: Number(pay.months.value), amount_cents: Math.round(Number(pay.amount.value) * 100), method: pay.method.value, reference: pay.ref.value, plan: g.plan.value }), 'Payment recorded, invoice sent') }, 'Record & email receipt'))),
      h('div', { class: 'card' }, h('b', {}, 'Support'), h('div', { class: 'row' }, h('button', { onclick: async () => { const r2 = await act(() => api('POST', `/api/admin/tenants/${id}/impersonate`, { reason: 'support' })); result.replaceChildren(h('p', {}, 'Link ready (valid 60 seconds, read-only, logged): '), h('a', { href: r2.url, target: '_blank', rel: 'noopener' }, 'Open this customer’s workspace')); } }, 'View as customer (read-only)')), result),
      h('div', { class: 'card' }, h('b', {}, 'Invoices'), table([['No.', (i) => i.number], ['Amount', (i) => money(i.amount_cents, i.currency)], ['Date', (i) => d(i.issued_at)], ['', (i) => h('a', { href: `/api/admin/invoices/${i.number}/pdf`, target: '_blank' }, 'PDF')]], r.invoices)),
      h('div', { class: 'card' }, h('b', {}, 'History'), table([['When', (a) => dt(a.at)], ['Who', (a) => a.actor], ['What', (a) => a.action], ['Detail', (a) => a.detail || '']], r.audit)),
      h('div', { class: 'card' }, h('b', {}, 'Danger zone'), h('div', { class: 'row' }, h('button', { class: 'dng', onclick: async () => { if (confirm(`Delete ${t.business_name}? It is kept for ${30} days and can be restored.`)) { await act(() => api('DELETE', '/api/admin/tenants/' + id), 'Deleted'); close(); } } }, 'Delete workspace'))));
  };
  try { await load(); } catch (e) { body.append(h('p', { class: 'err' }, e.message)); }
}

const VIEWS = { overview, customers, people, passes, payments, plans, activity, emails };
async function render() {
  const app = $('#app'); app.replaceChildren();
  if (!state.admin) return app.append(loginView());
  const main = h('main', {});
  app.append(h('div', { class: 'shell' }, h('nav', {}, h('b', {}, 'BizControl Admin'), PAGES.map(([k, l]) => h('a', { class: state.page === k ? 'on' : '', onclick: () => { state.page = k; state.q = ''; state.status = ''; render(); } }, l)), h('div', { class: 'sp' }), h('a', { onclick: async () => { await api('POST', '/api/admin/logout', {}).catch(() => {}); state.admin = null; render(); } }, 'Sign out (' + state.admin.email + ')')), main));
  try { await VIEWS[state.page](main); } catch (e) { if (e.status === 401) { state.admin = null; return render(); } main.append(h('p', { class: 'err' }, e.message)); }
}
(async () => { try { state.admin = await api('GET', '/api/admin/me'); } catch { state.admin = null; } render(); })();
