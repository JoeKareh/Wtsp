// ---------- safe HTML templating: interpolations are escaped unless wrapped in raw() ----------
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s ?? ''));
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Safe ? x.s : esc(x))).join('') : v instanceof Safe ? v.s : esc(v);
    out += part + strings[i + 1];
  });
  return new Safe(out);
}
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const mount = (el, content) => { el.innerHTML = content instanceof Safe ? content.s : esc(content); };

// ---------- global state ----------
export const state = { user: null, boot: null, unread: 0 };
export const can = (p) => !!state.user && state.user.permissions.includes(p);
export const canAny = (...p) => p.some(can);

// ---------- API ----------
export class ApiError extends Error { constructor(status, msg, details) { super(msg); this.status = status; this.details = details; } }
export async function api(method, url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) { state.user = null; location.hash = '#/login'; window.dispatchEvent(new Event('session-expired')); }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.details);
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}, h) => api('POST', u, b, h);
export const put = (u, b = {}) => api('PUT', u, b);
export const del = (u) => api('DELETE', u);
export const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && v !== false) p.set(k, v === true ? '1' : v); const s = p.toString(); return s ? '?' + s : ''; };
/** One key per form-open: resubmitting the same dialog can never create a duplicate financial record. */
export const idemKey = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));   // randomUUID needs a secure context

// ---------- formatting (all money is integer minor units) ----------
const base = () => state.boot?.settings.base_currency || 'USD';
export function money(cents, cur = base(), { sign = false } = {}) {
  if (cents == null || Number.isNaN(cents)) return '–';
  const lbp = cur === 'LBP'; const v = cents / 100;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: lbp ? 0 : 2, maximumFractionDigits: lbp ? 0 : 2 });
  const sym = { USD: '$', EUR: '€', GBP: '£' }[cur];
  const body = sym ? sym + s : `${s} ${cur}`;
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + body;
}
export const baseMoney = (c) => money(c, base());
export const num = (n, d = 0) => (n == null ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
export const pct = (n, d = 1) => (n == null ? 'n/a' : `${Number(n).toFixed(d)}%`);
export const toCents = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
export const fromCents = (c) => (c == null ? '' : (c / 100).toFixed(2));
export const fdate = (d) => (d ? String(d).slice(0, 10) : '–');
export const fdt = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const today = () => state.boot?.today || new Date().toISOString().slice(0, 10);
export const statusLabel = (s) => state.boot?.settings.order_status_labels?.[s] || s;
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const BADGES = {
  Draft: '', Pending: 'warn', Confirmed: 'info', Processing: 'info', Ready: 'info', 'Out for delivery': 'info', Delivered: 'good', Completed: 'good', Cancelled: 'bad', Returned: 'bad',
  Unpaid: 'bad', 'Partially paid': 'warn', Paid: 'good', Refunded: '',
  Active: 'good', 'At risk': 'warn', Inactive: 'bad', Potential: 'info', Prospect: 'info', Archived: '',
  opted_in: 'good', opted_out: 'bad', none: '', new: 'info', completed: 'good', ignored: '', scheduled: 'warn',
  draft: '', sending: 'info', failed: 'bad', cancelled: 'bad', sent: 'info', delivered: 'good', read: 'good', skipped: 'warn', queued: '', received: 'info',
  APPROVED: 'good', PENDING: 'warn', REJECTED: 'bad', LOCAL_DRAFT: '', out: 'bad', low: 'warn', high: 'info', ok: 'good',
};
export const badge = (s, label) => html`<span class="badge ${BADGES[s] ?? ''}">${label ?? (state.boot?.statuses?.includes(s) ? statusLabel(s) : String(s).replaceAll('_', ' '))}</span>`;

// ---------- toast / modal ----------
export function toast(msg, type = '') {
  const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg; el.setAttribute('role', 'status');
  const box = $('#toasts'); while (box.children.length >= 3) box.firstChild.remove();
  box.append(el); setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}
export const fail = (e) => { console.error(e); toast(e.message || String(e), 'error'); };

export function modal({ title, body, footer, size = '', onClose }) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); onClose?.(v); };
  const onKey = (e) => { if (e.key === 'Escape' && ov === document.body.lastElementChild?.previousElementSibling?.constructor && false) close(); };
  ov.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost sm" data-x aria-label="Close">✕</button></div><div class="modal-body"></div><div class="modal-foot" ${footer === false ? 'hidden' : ''}></div></div>`;
  const bodyEl = $('.modal-body', ov); const footEl = $('.modal-foot', ov);
  if (body) mount(bodyEl, body);
  $('[data-x]', ov).onclick = () => close();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov && !ov._drag) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ov.isConnected && ov === [...document.querySelectorAll('.overlay')].pop()) close(); }, { once: false });
  document.body.append(ov);
  const first = $('input:not([type=hidden]),select,textarea', bodyEl); first?.focus();
  return { el: ov, body: bodyEl, foot: footEl, close };
}
export function confirmDialog({ title = 'Are you sure?', message, confirmText = 'Confirm', danger = false, input }) {
  return new Promise((resolve) => {
    const m = modal({ title, body: html`<p>${message}</p>${input ? html`<div class="field"><label>${input}</label><input id="cd-input" maxlength="300" required></div>` : ''}`, onClose: () => resolve(null) });
    m.foot.innerHTML = `<button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-yes>${esc(confirmText)}</button>`;
    $('[data-no]', m.foot).onclick = () => m.close();
    $('[data-yes]', m.foot).onclick = () => { const v = input ? $('#cd-input', m.body).value.trim() : true; if (input && !v) { $('#cd-input', m.body).focus(); return; } resolve(v); m.el.remove(); };
  });
}

// ---------- forms ----------
/** field = {name,label,type,options,required,hint,value,placeholder,step,min,max,attrs} ; type: text|email|tel|number|money|date|datetime-local|select|textarea|checkbox|password */
export function fieldHtml(f, values = {}) {
  const v = values[f.name] ?? f.value ?? '';
  const id = 'f-' + f.name; const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') input = html`<select id="${id}" name="${f.name}" ${raw(req)}>${(f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return html`<option value="${val}" ${raw(String(val) === String(v) ? 'selected' : '')}>${lab}</option>`; })}</select>`;
  else if (f.type === 'textarea') input = html`<textarea id="${id}" name="${f.name}" ${raw(req)} placeholder="${f.placeholder || ''}">${v}</textarea>`;
  else if (f.type === 'checkbox') return html`<div class="field check"><input type="checkbox" id="${id}" name="${f.name}" ${raw(v ? 'checked' : '')}><label for="${id}">${f.label}</label></div>${f.hint ? html`<div class="hint small muted" style="margin:-8px 0 12px 24px">${f.hint}</div>` : ''}`;
  else {
    const t = f.type === 'money' ? 'number' : f.type || 'text';
    const val = f.type === 'money' ? fromCents(v === '' ? null : v) : v;
    input = html`<input id="${id}" name="${f.name}" type="${t}" value="${val}" ${raw(req)} placeholder="${f.placeholder || ''}" ${raw(f.type === 'money' ? 'step="0.01" min="0" inputmode="decimal"' : f.step ? `step="${f.step}"` : '')} ${raw(f.min != null ? `min="${f.min}"` : '')} ${raw(f.max != null ? `max="${f.max}"` : '')} ${raw(f.attrs || '')} autocomplete="${f.autocomplete || 'off'}">`;
  }
  return html`<div class="field"><label for="${id}">${f.label}${f.required ? ' *' : ''}</label>${input}${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}</div>`;
}
export function readForm(root, fields) {
  const out = {};
  for (const f of fields) {
    const el = $(`[name="${f.name}"]`, root); if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked;
    else if (f.type === 'money') out[f.name] = el.value === '' ? null : toCents(el.value);
    else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
    else out[f.name] = el.value.trim();
  }
  return out;
}
/** Opens a modal with a form; onSubmit(values) may throw to keep it open. */
export function formModal({ title, fields, values = {}, submitText = 'Save', size = '', onSubmit, extra, danger }) {
  const m = modal({ title, size, body: html`<form novalidate id="mform">${extra ? extra : ''}<div class="frow">${fields.filter((f) => f.type !== 'textarea' && f.type !== 'checkbox' && !f.full).map((f) => fieldHtml(f, values))}</div>${fields.filter((f) => f.type === 'textarea' || f.type === 'checkbox' || f.full).map((f) => fieldHtml(f, values))}<div class="alert bad" id="merr" hidden></div></form>` });
  const key = idemKey();
  m.foot.innerHTML = `<button class="btn" data-no type="button">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-yes type="button">${esc(submitText)}</button>`;
  const form = $('#mform', m.body); let busy = false;
  const submit = async () => {
    if (busy) return;
    if (!form.reportValidity()) return;
    busy = true; const btn = $('[data-yes]', m.foot); btn.disabled = true; $('#merr', m.body).hidden = true;
    try { await onSubmit(readForm(form, fields), key, m); m.close(); } catch (e) { const er = $('#merr', m.body); er.textContent = e.message; er.hidden = false; er.scrollIntoView({ block: 'nearest' }); } finally { busy = false; btn.disabled = false; }
  };
  $('[data-no]', m.foot).onclick = () => m.close(); $('[data-yes]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  return m;
}

// ---------- tables ----------
/** columns: [{key,label,render(row)->html|string,class,sort}] */
export function table(columns, rows, { rowClass, rowAttr, empty = 'Nothing to show', sort, dir, emptyHint = '' } = {}) {
  if (!rows.length) return html`<div class="empty"><b>${empty}</b>${emptyHint}</div>`;
  return html`<div class="table-wrap"><table><thead><tr>${columns.map((c) => html`<th class="${c.class || ''} ${c.sort ? 'sort' : ''}" ${raw(c.sort ? `data-sort="${c.sort}"` : '')}>${c.label}${c.sort && sort === c.sort ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`)}</tr></thead><tbody>${rows.map((r, i) => html`<tr class="${rowClass?.(r) || ''} ${rowAttr ? 'click' : ''}" ${raw(rowAttr ? `data-row="${i}"` : '')}>${columns.map((c) => html`<td class="${c.class || ''}">${c.render ? c.render(r) : r[c.key]}</td>`)}</tr>`)}</tbody></table></div>`;
}
export function pager(total, offset, limit) {
  const page = Math.floor(offset / limit) + 1; const pages = Math.max(1, Math.ceil(total / limit));
  return html`<div class="pager"><span>${total ? `${offset + 1}–${Math.min(offset + limit, total)} of ${num(total)}` : '0 results'}</span><span style="flex:1"></span><button class="btn sm" data-page="${page - 2}" ${raw(page <= 1 ? 'disabled' : '')}>‹ Prev</button><span>Page ${page}/${pages}</span><button class="btn sm" data-page="${page}" ${raw(page >= pages ? 'disabled' : '')}>Next ›</button></div>`;
}

// ---------- router ----------
const routes = []; let cleanup = null;
export const route = (path, loader, opts = {}) => routes.push({ path, loader, opts });
export function parseHash() {
  const h = location.hash.slice(1) || '/dashboard'; const [p, q] = h.split('?');
  return { path: p, query: Object.fromEntries(new URLSearchParams(q || '')) };
}
export const go = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
export async function dispatch(view) {
  const { path, query } = parseHash();
  const r = routes.find((x) => x.path === path) || routes[0];
  document.querySelectorAll('.overlay').forEach((o) => o.remove()); // dialogs never outlive the page they were opened on
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  view.innerHTML = '<div class="loading">Loading…</div>';
  try { const c = await r.loader(view, query); if (typeof c === 'function') cleanup = c; }
  catch (e) { if (e.status === 403) mount(view, html`<div class="card empty"><b>Access restricted</b>You do not have permission to view this page.</div>`); else { console.error(e); mount(view, html`<div class="card"><div class="alert bad">${e.message}</div><button class="btn" data-reload>Reload</button></div>`); } }
  return r;
}
export function setQuery(patch) {
  const { path, query } = parseHash(); const q = { ...query, ...patch };
  for (const k of Object.keys(q)) if (q[k] === '' || q[k] == null) delete q[k];
  history.replaceState(null, '', `#${path}${qs(q)}`);
}
export const download = (url) => { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.append(a); a.click(); a.remove(); };

/** Date-range control shared by dashboard / analytics / reports */
export const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_year', 'This year'], ['custom', 'Custom']];
export function rangeControl(q, { compare = false } = {}) {
  return html`<select data-r="range" aria-label="Date range">${RANGES.map(([v, l]) => html`<option value="${v}" ${raw(q.range === v ? 'selected' : '')}>${l}</option>`)}</select>
    <span ${raw(q.range === 'custom' ? '' : 'hidden')} data-custom><input type="date" data-r="from" value="${q.from || ''}" aria-label="From"> <input type="date" data-r="to" value="${q.to || ''}" aria-label="To"></span>
    ${compare ? html`<select data-r="compare" aria-label="Compare with"><option value="none" ${raw(q.compare === 'none' ? 'selected' : '')}>No comparison</option><option value="prev" ${raw(q.compare === 'prev' || !q.compare ? 'selected' : '')}>vs previous period</option><option value="year" ${raw(q.compare === 'year' ? 'selected' : '')}>vs same period last year</option></select>` : ''}`;
}
export function bindRange(root, q, onChange) {
  $$('[data-r]', root).forEach((el) => el.addEventListener('change', () => {
    q[el.dataset.r] = el.value;
    $('[data-custom]', root)?.toggleAttribute('hidden', q.range !== 'custom');
    if (q.range === 'custom' && (!q.from || !q.to)) return;
    onChange();
  }));
}

// CSP forbids inline handlers, so shared one-liners are wired by delegation
document.addEventListener('click', (e) => { if (e.target.closest('[data-reload]')) location.reload(); const s = e.target.closest('[data-select]'); if (s) s.select(); });
