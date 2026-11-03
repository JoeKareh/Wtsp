// Hosted-service chrome: workspace state banners (trial / past due / read-only / canceled / support / demo) and the language switcher.
import { html, raw, $, state, get, put, fail } from './core.js';
import { LANGS, lang, rememberLang } from './i18n.js';

const fmt = (d) => (d ? String(d).slice(0, 10) : '');
export function bannerHtml() {
  const ws = state.workspace; const out = [];
  if (state.support) out.push(html`<div class="ws-banner info">🛟 <b>Support session</b> by ${state.support.by}${state.support.readonly ? ' – read-only' : ''}. Everything you do here is logged.</div>`);
  if (state.boot?.settings.is_demo) out.push(html`<div class="ws-banner warn">Demo workspace – read-only sample data. <a href="/" data-notr>Start your own free trial</a></div>`);
  const b = ws?.banner; if (!b || state.boot?.settings.is_demo) return html`${out}`;
  const link = html` <a href="#/billing" class="ws-act">Choose a plan</a>`;
  if (b.type === 'trial') out.push(html`<div class="ws-banner ${b.days <= 3 ? 'warn' : 'info'}">Free trial: <b>${b.days}</b> day${b.days === 1 ? '' : 's'} left.${link}</div>`);
  else if (b.type === 'past_due') out.push(html`<div class="ws-banner warn">Your payment is overdue. Please renew before <b>${fmt(b.until)}</b> to avoid interruption. <a href="#/billing" class="ws-act">Renew now</a></div>`);
  else if (b.type === 'suspended') out.push(html`<div class="ws-banner bad">Your workspace is read-only until the subscription is renewed. You can still view and export all your data. <a href="#/billing" class="ws-act">Renew now</a></div>`);
  else if (b.type === 'canceled') out.push(html`<div class="ws-banner bad">This workspace was canceled and is read-only. Your data is kept until <b>${fmt(b.delete_after)}</b>. <a href="#/billing" class="ws-act">Reactivate</a></div>`);
  return html`${out}`;
}
export async function refreshWorkspace() {
  try { const s = await get('/api/auth/status'); state.workspace = s.workspace; state.support = s.support_session; const el = $('#ws-banner'); if (el) el.innerHTML = bannerHtml().toString(); } catch { /* ignore */ }
}
export const isReadOnly = () => Boolean(state.workspace?.read_only || state.support?.readonly || state.boot?.settings.is_demo);
export function languageSelect() {
  return html`<select id="langsel" aria-label="Interface language" title="Interface language">${Object.entries(LANGS).map(([c, n]) => html`<option value="${c}" ${c === lang ? 'selected' : ''} data-notr>${n}</option>`)}</select>`;
}
export function bindLanguage(root = document) {
  const s = $('#langsel', root); if (!s) return;
  s.onchange = async () => { rememberLang(s.value); try { await put('/api/auth/language', { language: s.value }); } catch (e) { if (state.user && !state.support && !state.boot?.settings.is_demo) return fail(e); } location.reload(); };
}
void raw;
