// Click-to-chat: opens WhatsApp (wa.me) with a message the user can edit. Works on every plan, needs no WhatsApp API.
// window.open runs synchronously inside the click that confirms, so browsers never block it as a popup.
import { html, raw, $, get, post, modal, fail, esc } from './core.js';
import { lang } from './i18n.js';

const PURPOSES = [['thank_you', 'Thank you'], ['order_confirmation', 'Order confirmation'], ['delivery_update', 'Delivery update'], ['payment_reminder', 'Payment reminder'], ['win_back', 'We miss you']];
export async function openChat({ customer, order, purpose = 'thank_you', supplier, product }) {
  const isSup = Boolean(supplier); const q = (p, l) => `/api/whatsapp/chat-link?purpose=${p}&lang=${l}` + (isSup ? `&supplier_id=${supplier}` + (product ? `&product_id=${product}` : '') : `&customer_id=${customer}` + (order ? `&order_id=${order}` : ''));
  let cur; try { cur = await get(q(isSup ? 'reorder' : purpose, lang === 'ar' ? 'ar' : 'en')); } catch (e) { return fail(e); }
  const m = modal({ title: isSup ? 'Reorder from supplier' : 'Chat on WhatsApp', body: html`
    ${isSup ? '' : html`<div class="frow"><div class="field"><label>Message type</label><select id="ch-p">${PURPOSES.map(([v, l]) => html`<option value="${v}" ${v === purpose ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label>Language</label><select id="ch-l"><option value="en" ${lang !== 'ar' ? 'selected' : ''}>English</option><option value="ar" ${lang === 'ar' ? 'selected' : ''}>العربية</option></select></div></div>`}
    <div class="field"><label>Message</label><textarea id="ch-t" rows="6" style="width:100%"></textarea><span class="hint">You can edit the message before sending. This opens WhatsApp with the message ready. Press send there.</span></div>
    <p class="small muted">To: <b dir="ltr" id="ch-to"></b></p>` });
  const ta = $('#ch-t', m.body); const to = $('#ch-to', m.body); const fill = () => { ta.value = cur.text; to.textContent = '+' + cur.phone; }; fill();
  const refetch = async () => { try { cur = await get(q($('#ch-p', m.body).value, $('#ch-l', m.body).value)); fill(); } catch (e) { fail(e); } };
  $('#ch-p', m.body)?.addEventListener('change', refetch); $('#ch-l', m.body)?.addEventListener('change', refetch);
  m.foot.innerHTML = '<button class="btn" data-no type="button">Cancel</button><button class="btn primary" data-go type="button">Open WhatsApp</button>';
  $('[data-no]', m.foot).onclick = () => m.close();
  $('[data-go]', m.foot).onclick = () => {
    window.open(`https://wa.me/${cur.phone}?text=${encodeURIComponent(ta.value)}`, '_blank', 'noopener');
    if (!isSup) post('/api/whatsapp/chat-opened', { customer_id: Number(customer), purpose: $('#ch-p', m.body)?.value || purpose, order_id: order ? Number(order) : undefined }).catch(() => {});
    m.close();
  };
}
export const chatBtn = (attrs, label = 'Chat on WhatsApp', cls = 'btn sm') => html`<button class="${cls}" type="button" data-chat ${raw(Object.entries(attrs).filter(([, v]) => v != null && v !== '').map(([k, v]) => `data-${k}="${esc(v)}"`).join(' '))}>💬 ${label}</button>`;
// capture phase: wins over row-click handlers on the page
document.addEventListener('click', (e) => { const b = e.target.closest('[data-chat]'); if (!b) return; e.preventDefault(); e.stopPropagation(); openChat({ customer: b.dataset.customer, order: b.dataset.order, purpose: b.dataset.purpose, supplier: b.dataset.supplier, product: b.dataset.product }); }, true);
