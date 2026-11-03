import { initLanguage, savedLang, lang as curLang } from './i18n.js';
import { bannerHtml, refreshWorkspace, languageSelect, bindLanguage } from './saas.js';
import './chat.js';
import { html, raw, mount, $, $$, state, can, canAny, get, post, api, route, dispatch, parseHash, toast, fail, esc, go, readForm, fieldHtml } from './core.js';

const ICONS = {
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  orders: 'M7 4h10l3 4v12H4V8l3-4zm0 0v4h10V4M9 12h6',
  customers: 'M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 3.6-6 8-6s8 2 8 6',
  products: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
  payments: 'M3 7h18v12H3V7zm0 4h18M7 15h3',
  expenses: 'M12 3v18M17 7H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  analytics: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  marketing: 'M21 11.5a8.4 8.4 0 01-12.2 7.5L3 21l2-5.6A8.5 8.5 0 1121 11.5z',
  notifications: 'M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 20a2 2 0 01-3.4 0',
  reports: 'M14 3H6v18h12V7l-4-4zM14 3v4h4M9 13h6M9 17h6',
  ask: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
  billing: 'M2 7h20v12H2V7zm0 4h20M6 15h4',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-6v-1c0-1.500 2-2 2-3.500a2 2 0 00-4 0M12 17.500v.01',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 00-2.2-1.3L14.300 3h-4l-.4 2.400a7 7 0 00-2.200 1.300l-2.400-1-2 3.400 2 1.600a7.400 7.400 0 000 2.600l-2 1.600 2 3.400 2.400-1a7 7 0 002.200 1.300l.4 2.400h4l.4-2.400a7 7 0 002.200-1.300l2.400 1 2-3.400-2-1.600c.1-.4.100-.9.100-1.300z',
};
const ic = (n) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`);
const NAV = [
  ['dashboard', 'Dashboard', 'dashboard', () => can('dashboard:read')],
  ['orders', 'Orders', 'orders', () => can('orders:read')],
  ['customers', 'Customers', 'customers', () => can('customers:read')],
  ['products', 'Products & Inventory', 'products', () => can('products:read')],
  ['payments', 'Payments & Finances', 'payments', () => canAny('payments:read', 'finance:read')],
  ['expenses', 'Expenses', 'expenses', () => can('expenses:read')],
  ['analytics', 'Sales Analytics', 'analytics', () => can('analytics:read')],
  ['marketing', 'WhatsApp Marketing', 'marketing', () => can('marketing:read')],
  ['notifications', 'Notifications', 'notifications', () => can('notifications:read')],
  ['reports', 'Reports', 'reports', () => can('reports:read')],
  ['settings', 'Settings', 'settings', () => canAny('settings:write', 'users:manage')],
  ['ask', 'Ask your business', 'ask', () => can('analytics:read')],
  ['billing', 'Billing', 'billing', () => state.saas && can('users:manage')],
  ['help', 'Help', 'help', () => true],
];
const PAGES = {
  dashboard: () => import('./pages/dashboard.js'), orders: () => import('./pages/orders.js'), customers: () => import('./pages/customers.js'),
  products: () => import('./pages/products.js'), payments: () => import('./pages/payments.js'), expenses: () => import('./pages/expenses.js'),
  analytics: () => import('./pages/analytics.js'), marketing: () => import('./pages/marketing.js'), notifications: () => import('./pages/notifications.js'),
  reports: () => import('./pages/reports.js'), settings: () => import('./pages/settings.js'),
  ask: () => import('./pages/ask.js'), billing: () => import('./pages/billing.js'), help: () => import('./pages/help.js'), 'whatsapp-setup': () => import('./pages/whatsapp-setup.js'), 'get-started': () => import('./pages/onboarding.js'),
};
// every page enforces its permission, not just the menu (the server enforces it again on every API call)
for (const [k, loader] of Object.entries(PAGES)) route('/' + k, async (view, q) => {
  const nav = NAV.find(([key]) => key === k);
  if (nav && !nav[3]()) throw Object.assign(new Error('Forbidden'), { status: 403 });
  return (await loader()).default(view, q);
});

const app = $('#app');
const authCard = (inner) => mount(app, html`<div class="auth"><div class="card">${inner}</div></div>`);

async function loadBoot() { state.boot = await get('/api/bootstrap'); }
function applyTheme() { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; }

function loginView(status) {
  authCard(html`<h1>${status.business_name || 'BizControl'}</h1><p class="muted">Sign in to continue</p>
    ${status.is_demo ? html`<div class="alert warn">Demo database: sign in with the demo credentials from the README.</div>` : ''}
    <form id="f" style="margin-top:16px">
      <div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="username" autofocus></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" required autocomplete="current-password"></div>
      <div class="alert bad" id="err" hidden></div>
      <button class="btn primary" style="width:100%;justify-content:center">Sign in</button>
      <p class="small" style="text-align:center;margin-top:14px"><a href="#/forgot">Forgot your password?</a></p><p style="text-align:center">${languageSelect()}</p></form>`);
  bindLanguage();
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); const btn = $('button', e.target); btn.disabled = true;
    try { state.user = await post('/api/auth/login', { email: $('#email').value, password: $('#pw').value }); await startApp(); }
    catch (er) { $('#err').textContent = er.message; $('#err').hidden = false; btn.disabled = false; }
  };
}
function setupView() {
  authCard(html`<h1>Welcome 👋</h1><p class="muted">Create the owner account to get started. There are no default passwords.</p>
    <form id="f" style="margin-top:14px">
      <div class="field"><label>Business name</label><input id="bn" required maxlength="120"></div>
      <div class="field"><label>Your name</label><input id="nm" required autocomplete="name"></div>
      <div class="field"><label>Email</label><input id="em" type="email" required autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="pw" type="password" required minlength="8" autocomplete="new-password"><span class="hint">At least 8 characters.</span></div>
      <div class="alert bad" id="err" hidden></div>
      <button class="btn primary" style="width:100%;justify-content:center">Create owner account</button></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { state.user = await post('/api/auth/setup', { business_name: $('#bn').value, name: $('#nm').value, email: $('#em').value, password: $('#pw').value }); location.hash = '#/settings?welcome=1'; await startApp(); }
    catch (er) { $('#err').textContent = er.message; $('#err').hidden = false; }
  };
}
function forgotView() {
  authCard(html`<h1>Reset password</h1><p class="muted">Enter your email. If an account exists we will send a reset link. If email is not configured, ask the owner for a reset link.</p>
    <form id="f" style="margin-top:14px"><div class="field"><label>Email</label><input id="em" type="email" required></div><div class="alert good" id="ok" hidden></div>
    <button class="btn primary" style="width:100%;justify-content:center">Send reset link</button><p class="small" style="text-align:center;margin-top:12px"><a href="#/login">Back to sign in</a></p></form>`);
  $('#f').onsubmit = async (e) => { e.preventDefault(); try { const r = await post('/api/auth/forgot', { email: $('#em').value }); $('#ok').textContent = r.message; $('#ok').hidden = false; } catch (er) { fail(er); } };
}
function resetView(token) {
  authCard(html`<h1>Choose a new password</h1><form id="f" style="margin-top:14px"><div class="field"><label>New password</label><input id="pw" type="password" minlength="8" required autocomplete="new-password"></div><div class="alert bad" id="err" hidden></div><button class="btn primary" style="width:100%;justify-content:center">Save password</button></form>`);
  $('#f').onsubmit = async (e) => { e.preventDefault(); try { await post('/api/auth/reset', { token, password: $('#pw').value }); toast('Password updated. Please sign in.', 'success'); location.hash = '#/login'; } catch (er) { $('#err').textContent = er.message; $('#err').hidden = false; } };
}

let navTimer;
async function refreshUnread() {
  if (!can('notifications:read')) return;
  try { const { count } = await get('/api/notifications/unread-count'); state.unread = count; const el = $('#nav-count'); if (el) { el.textContent = count > 99 ? '99+' : count; el.hidden = !count; } const b = $('#bell-count'); if (b) { b.textContent = count; b.hidden = !count; } } catch { /* ignore */ }
}

async function startApp() {
  if (state.user.language && state.user.language !== curLang) await initLanguage(state.user.language);
  state.saas ??= state.boot?.settings?.saas; await loadBoot(); try { const st = await get('/api/auth/status'); state.saas = st.saas; state.workspace = st.workspace; state.support = st.support_session; } catch { /* ignore */ }
  const s = state.boot.settings;
  const items = NAV.filter(([, , , ok]) => ok());
  mount(app, html`<div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation"><div class="brand">${s.logo ? raw(`<img alt="" src="${esc(s.logo)}">`) : html`<span class="logo">B</span>`}<span>${s.business_name}</span></div>
      <nav class="nav">${items.map(([k, label, icon]) => html`<a href="#/${k}" data-nav="${k}">${ic(icon)}<span>${label}</span>${k === 'notifications' ? html`<span class="count" id="nav-count" hidden></span>` : ''}</a>`)}</nav>
      <div class="side-foot"><div style="color:#fff;font-weight:600">${state.user.name}</div><div>${state.user.role.charAt(0) + state.user.role.slice(1).toLowerCase()} · <a href="#" id="logout" style="color:var(--nav-text);text-decoration:underline">Sign out</a></div></div></aside>
    <div class="main"><div id="ws-banner">${bannerHtml()}</div>${s.is_demo ? html`<div class="demo-banner">DEMO DATA: this is a demonstration database, not real business data</div>` : ''}
      <header class="topbar"><button class="btn ghost menu-btn" id="menu" aria-label="Open menu">☰</button><div class="grow" id="crumb"></div>
        ${languageSelect()}
        <a class="btn ghost" href="#/notifications" aria-label="Notifications" style="position:relative">${ic('notifications')}<span class="badge bad" id="bell-count" hidden style="position:absolute;top:-4px;right:-6px;padding:0 6px"></span></a>
        <button class="btn ghost" id="theme" aria-label="Toggle dark mode" title="Toggle light/dark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg></button>
        <button class="btn ghost" id="pwbtn" title="Account">${state.user.name.split(' ')[0]}</button></header>
      <main class="content" id="view" tabindex="-1"></main></div></div>`);
  $('#logout').onclick = async (e) => { e.preventDefault(); try { await post('/api/auth/logout'); } catch { /* */ } state.user = null; location.hash = '#/login'; boot(); };
  $('#menu').onclick = () => $('#sidebar').classList.toggle('open');
  $('#theme').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'); const n = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('theme', n); } catch { /* */ } dispatch($('#view')); };
  $('#pwbtn').onclick = accountDialog; bindLanguage();
  $('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) $('#sidebar').classList.remove('open'); });
  clearInterval(navTimer); navTimer = setInterval(refreshUnread, 60000); refreshUnread();
  await render();
}

async function accountDialog() {
  const { modal, formModal } = await import('./core.js');
  const sessions = await get('/api/auth/sessions').catch(() => []);
  const m = formModal({ title: 'My account', submitText: 'Change password', fields: [{ name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' }, { name: 'new_password', label: 'New password (min 8)', type: 'password', required: true, autocomplete: 'new-password' }],
    extra: html`<p class="muted small">${state.user.email} · ${state.user.role}</p><p class="small muted">Active sessions: ${sessions.length}. Changing your password signs out your other devices.</p>`,
    onSubmit: async (v) => { await post('/api/auth/change-password', v); toast('Password changed', 'success'); } });
  return m;
}

async function render() {
  const view = $('#view'); if (!view) return;
  const { path } = parseHash();
  const r = await dispatch(view);
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', '/' + a.dataset.nav === r.path));
  const label = NAV.find(([k]) => '/' + k === r.path)?.[1]; document.title = `${label || 'BizControl'} · ${state.boot.settings.business_name}`;
  $('#crumb').textContent = label || ''; view.focus({ preventScroll: true }); void path;
}

async function boot() {
  applyTheme();
  let status;
  try { status = await get('/api/auth/status'); } catch (e) { mount(app, html`<div class="auth"><div class="card"><h1>Cannot reach server</h1><p>${e.message}</p><button class="btn" data-reload>Retry</button></div></div>`); return; }
  state.saas = status.saas; state.workspace = status.workspace; state.support = status.support_session;
  await initLanguage(status.user?.language || savedLang() || status.language);
  const { path, query } = parseHash();
  if (status.needs_setup) return setupView();
  if (!status.user) {
    if (path === '/forgot') return forgotView();
    if (path === '/reset') return resetView(query.token);
    return loginView(status);
  }
  state.user = status.user; if (path === '/login' || path === '/forgot' || path === '/reset') location.hash = '#/dashboard';
  await startApp();
}
window.addEventListener('hashchange', () => { if (state.user) render(); else boot(); });
window.addEventListener('session-expired', () => boot());
window.addEventListener('notifications-changed', refreshUnread);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
