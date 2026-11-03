// Click-to-chat: wa.me links with a prefilled message. Works for EVERY customer (personal WhatsApp or the WhatsApp Business app):
// no API, no approval, no ban risk. One message at a time, always sent by a human. We only log that the chat was OPENED.
import { GET, POST } from '../http.js';
import { all, get, run, audit, allSettings } from '../db.js';
import { bad, notFound, nowIso, phoneDigits, diffDays, todayStr, oneOf } from '../util.js';

const PURPOSES = { order_confirmation: 'order_confirmation', delivery_update: 'delivery_update', payment_reminder: 'payment_reminder', thank_you: 'thank_you', win_back: 'reactivation', reorder: null };
// Built-in fallbacks (used when the workspace has no template in the user's language, or the template needs values we cannot fill)
const FALLBACK = {
  en: { order_confirmation: 'Hello {customer_name}, your order {order_number} at {business_name} has been confirmed. Thank you!', delivery_update: 'Hello {customer_name}, your order {order_number} from {business_name} is on its way.', payment_reminder: 'Hello {customer_name}, a friendly reminder from {business_name}: order {order_number} has an unpaid balance of {balance}. Could you let us know when you can settle it? Thank you.', thank_you: 'Thank you {customer_name} for your order {order_number}! We appreciate your trust. {business_name}', win_back: 'Hello {customer_name}, it has been a while! We would love to see you again at {business_name}. Anything we can help you with?', reorder: 'Hello, this is {business_name}. We would like to reorder {product_name}. Could you share your current price and availability? Thank you.' },
  ar: { order_confirmation: 'مرحبًا {customer_name}، تم تأكيد طلبك {order_number} لدى {business_name}. شكرًا لك!', delivery_update: 'مرحبًا {customer_name}، طلبك {order_number} من {business_name} في الطريق إليك.', payment_reminder: 'مرحبًا {customer_name}، تذكير ودّي من {business_name}: الطلب {order_number} عليه رصيد غير مدفوع بقيمة {balance}. هل يمكنك إخبارنا متى يناسبك السداد؟ شكرًا لك.', thank_you: 'شكرًا لك {customer_name} على طلبك {order_number}! نقدّر ثقتك بنا. {business_name}', win_back: 'مرحبًا {customer_name}، مرّ وقت طويل! يسعدنا أن نراك من جديد في {business_name}. هل نستطيع مساعدتك بشيء؟', reorder: 'مرحبًا، معك {business_name}. نودّ إعادة طلب {product_name}. هل يمكنكم تزويدنا بالسعر والتوفر الحاليين؟ شكرًا لكم.' },
};
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== '' ? vars[k] : m));
const money = (c, cur) => `${(c / 100).toLocaleString('en-US', { minimumFractionDigits: cur === 'LBP' ? 0 : 2, maximumFractionDigits: cur === 'LBP' ? 0 : 2 })} ${cur}`;

export function chatMessage({ customer, order, purpose, lang, product, user }) {
  const st = allSettings(); const L = FALLBACK[lang] ? lang : 'en';
  const o = order || get("SELECT number, balance, currency FROM v_orders_fin WHERE customer_id=? AND status NOT IN ('Draft','Cancelled') ORDER BY (balance>0) DESC, id DESC LIMIT 1", customer.id);
  const vars = { customer_name: customer.name.split(' ')[0] || customer.name, order_number: o?.number || '', business_name: st.business_name, balance: o && o.balance > 0 ? money(o.balance, o.currency) : '', product_name: product || '', last_purchase: customer.last_purchase || '' };
  const tplPurpose = PURPOSES[purpose]; let text = null;
  if (tplPurpose) {
    const t = get('SELECT body FROM whatsapp_templates WHERE purpose=? AND language=? ORDER BY id LIMIT 1', tplPurpose, L);
    if (t) { const r = fill(t.body, vars); if (!/\{\w+\}/.test(r)) text = r; }       // editable workspace templates win, but only if every placeholder could be filled
  }
  if (!text) text = fill(FALLBACK[L][purpose], vars);
  if (/\{(order_number|balance)\}/.test(text) || /\{\w+\}/.test(text)) text = text.replace(/\s*\{\w+\}/g, '').replace(/\s+/g, ' ').trim();   // never show a raw placeholder to a customer
  return text;
}

const PERM = { perm: ['customers:read', 'orders:read', 'payments:read'] };
GET('/api/whatsapp/chat-link', PERM, (ctx) => {
  const purpose = oneOf(ctx.query.purpose || 'thank_you', 'Purpose', Object.keys(PURPOSES));
  const lang = ['en', 'ar'].includes(ctx.query.lang) ? ctx.query.lang : (ctx.user.language || allSettings().language || 'en');
  if (purpose === 'reorder') {
    const s = get('SELECT id, name, phone FROM suppliers WHERE id=?', Number(ctx.query.supplier_id)); if (!s) throw notFound('Supplier');
    if (!s.phone) throw bad('This supplier has no phone number');
    const p = ctx.query.product_id ? get('SELECT name FROM products WHERE id=?', Number(ctx.query.product_id)) : null;
    const text = chatMessage({ customer: { id: 0, name: s.name }, purpose, lang, product: p?.name || '' }); const digits = phoneDigits(s.phone);
    return { url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, text, phone: digits, lang, purpose };
  }
  const c = get('SELECT * FROM customers WHERE id=?', Number(ctx.query.customer_id)); if (!c) throw notFound('Customer');
  const order = ctx.query.order_id ? get('SELECT * FROM v_orders_fin WHERE id=? AND customer_id=?', Number(ctx.query.order_id), c.id) : null;
  const last = get("SELECT MAX(order_date) d FROM orders WHERE customer_id=? AND status NOT IN ('Draft','Cancelled','Returned')", c.id);
  const text = chatMessage({ customer: { ...c, last_purchase: last?.d }, order, purpose, lang });
  const digits = phoneDigits(c.whatsapp || c.phone);
  return { url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, text, phone: digits, lang, purpose, templates: { languages: ['en', 'ar'] } };
});
/** We cannot know whether the message was actually sent: we record that the chat was opened. */
POST('/api/whatsapp/chat-opened', PERM, (ctx) => {
  const c = get('SELECT id FROM customers WHERE id=?', Number(ctx.body.customer_id)); if (!c) throw notFound('Customer');
  const purpose = oneOf(ctx.body.purpose || 'thank_you', 'Purpose', Object.keys(PURPOSES));
  run('INSERT INTO customer_events(customer_id,type,detail,user_id,created_at) VALUES (?,?,?,?,?)', c.id, 'wa_opened', JSON.stringify({ purpose, order_id: ctx.body.order_id || null }), ctx.user.id, nowIso());
  audit(ctx.user, 'wa_opened', 'customer', c.id, null, { purpose });
  return { ok: true };
});
