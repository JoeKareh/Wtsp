// WhatsApp Business Platform (Cloud API) integration. Official API only. No browser automation.
import crypto from 'node:crypto';
import { GET, POST, PUT, DELETE, route, reply, raw } from '../http.js';
import { all, get, run, tx, audit, allSettings, setSettings } from '../db.js';
import { bad, notFound, conflict, str, oneOf, nowIso, todayStr, addDays, diffDays, phoneDigits, safeJson, normPhone, uuid } from '../util.js';
import { config } from '../config.js';
import { customerSelect, recordConsent, getCustomer } from './customers.js';
import { notify, setOwnerWhatsAppSender } from './notifications.js';
import { on } from '../events.js';
import { log } from '../log.js';

export const PLACEHOLDERS = ['customer_name', 'order_number', 'product_name', 'last_purchase', 'discount', 'offer_expiry', 'business_name'];
const SAMPLE = { customer_name: 'Sara', order_number: 'ORD-000123', product_name: 'Olive oil 1L', last_purchase: '2025-01-15', discount: '10%', offer_expiry: '2025-12-31' };

// ---------------- configuration & Graph API client ----------------
export function waStatus() {
  const c = config.wa(); const st = allSettings();
  const required = { WHATSAPP_TOKEN: c.token, WHATSAPP_PHONE_NUMBER_ID: c.phoneNumberId, WHATSAPP_BUSINESS_ACCOUNT_ID: c.wabaId, WHATSAPP_APP_SECRET: c.appSecret, WHATSAPP_VERIFY_TOKEN: c.verifyToken };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  const sendReady = Boolean(c.token && c.phoneNumberId);
  const last = st.wa_last_test;
  return {
    configured: sendReady, missing, can_send: sendReady, can_manage_templates: Boolean(c.token && c.wabaId),
    webhook_ready: Boolean(c.appSecret && c.verifyToken), webhook_url: `${config.baseUrl}/webhooks/whatsapp`, api_version: c.version,
    connection: !sendReady ? 'not_configured' : last?.ok ? 'connected' : last ? 'failed' : 'untested',
    last_test: last || null,
  };
}
async function graph(method, pathPart, body) {
  const c = config.wa();
  if (!c.token) throw bad('WhatsApp is not configured. Set WHATSAPP_TOKEN in the server environment (see docs/WHATSAPP_SETUP.md).');
  const url = `${c.apiBase}/${c.version}/${pathPart}`;
  let res;
  try {
    res = await fetch(url, { method, headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw Object.assign(new Error(`Could not reach WhatsApp API: ${e.message}`), { status: 502 }); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ? `WhatsApp API: ${json.error.message}${json.error.error_data?.details ? ' - ' + json.error.error_data.details : ''}` : `WhatsApp API error ${res.status}`), { status: res.status === 401 || res.status === 190 ? 502 : 400, waCode: json?.error?.code });
  return json;
}

// ---------------- templates ----------------
export const paramsOf = (body) => { const out = []; for (const m of body.matchAll(/\{(\w+)\}/g)) if (!out.includes(m[1])) out.push(m[1]); return out; };
const render = (body, vars) => body.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null && vars[k] !== '' ? String(vars[k]) : m));
const metaBody = (body) => { const p = paramsOf(body); return body.replace(/\{(\w+)\}/g, (_, k) => `{{${p.indexOf(k) + 1}}}`); };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

const DEFAULT_TEMPLATES = [
  ['New product announcement', 'MARKETING', 'new_product', 'Hello {customer_name}, we have just added {product_name} at {business_name}. Reply to this message to order yours.'],
  ['Promotion / discount', 'MARKETING', 'promotion', 'Hello {customer_name}, enjoy {discount} off {product_name} at {business_name}. The offer expires on {offer_expiry}, so reply to this message to order.'],
  ['Special offer', 'MARKETING', 'special_offer', 'Hello {customer_name}, a special offer from {business_name}: {discount} on {product_name} until {offer_expiry}. Reply to claim it.'],
  ['Seasonal campaign', 'MARKETING', 'seasonal', 'Hello {customer_name}, {business_name} has seasonal offers on {product_name} with {discount} off until {offer_expiry}. Reply to this message to find out more.'],
  ['Customer reactivation', 'MARKETING', 'reactivation', 'Hello {customer_name}, we miss you at {business_name}! Your last order was on {last_purchase}. Enjoy {discount} off your next order until {offer_expiry}. Just reply to this message to order.'],
  ['Thank you', 'UTILITY', 'thank_you', 'Thank you {customer_name} for your order {order_number} at {business_name}. We appreciate your trust.'],
  ['Order confirmation', 'UTILITY', 'order_confirmation', 'Hello {customer_name}, your order {order_number} at {business_name} has been confirmed. We will keep you updated.'],
  ['Delivery update', 'UTILITY', 'delivery_update', 'Hello {customer_name}, your order {order_number} from {business_name} is out for delivery.'],
  ['Payment reminder', 'UTILITY', 'payment_reminder', 'Hello {customer_name}, this is a friendly reminder from {business_name} that order {order_number} still has an unpaid balance. Please contact us to arrange payment.'],
  ['Personalized recommendation', 'MARKETING', 'recommendation', 'Hello {customer_name}, since you enjoyed {product_name}, we think you will like our latest items at {business_name}. Reply to see more.'],
  ['Loyalty offer', 'MARKETING', 'loyalty', 'Hello {customer_name}, as one of our valued customers at {business_name}, enjoy {discount} off {product_name} until {offer_expiry}. Thank you for your loyalty!'],
];
export function ensureDefaultTemplates() {
  if (get('SELECT COUNT(*) c FROM whatsapp_templates').c) return;
  for (const [name, category, purpose, body] of DEFAULT_TEMPLATES) {
    run('INSERT INTO whatsapp_templates(name,wa_name,category,purpose,language,body,meta_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', name, slug(name), category, purpose, 'en', body, 'LOCAL_DRAFT', nowIso(), nowIso());
  }
}
function templateWarnings(body) {
  const w = []; const p = paramsOf(body);
  const bad_ = p.filter((x) => !PLACEHOLDERS.includes(x)); if (bad_.length) w.push(`Unknown placeholders: ${bad_.map((x) => '{' + x + '}').join(', ')}`);
  if (/^\s*\{\w+\}/.test(body) || /\{\w+\}[\s.!?]*$/.test(body)) w.push('WhatsApp usually rejects templates that start or end with a variable. Add text before/after it.');
  if (body.length > 1024) w.push('Template body is longer than 1024 characters.');
  return w;
}
const shapeTpl = (t) => ({ ...t, params: paramsOf(t.body), meta_body: metaBody(t.body), warnings: templateWarnings(t.body), usable: t.meta_status === 'APPROVED' });
const getTemplate = (id) => { const t = get('SELECT * FROM whatsapp_templates WHERE id=?', id); return t ? shapeTpl(t) : null; };

// ---------------- consent & eligibility ----------------
export function eligibility(c, category) {
  if (c.status === 'Archived') return 'archived';
  const num = c.whatsapp; if (!num) return 'no_whatsapp_number';
  if (get('SELECT 1 x FROM suppression_list WHERE phone=? OR customer_id=?', num, c.id)) return 'suppressed_opted_out';
  const last = c.marketing_consent ?? get("SELECT status FROM customer_consent WHERE customer_id=? AND channel='whatsapp' AND type='marketing' ORDER BY id DESC LIMIT 1", c.id)?.status;
  if (last === 'opted_out') return 'suppressed_opted_out';
  if (category === 'MARKETING' && last !== 'opted_in') return 'no_marketing_consent';
  return null;
}

// ---------------- segmentation ----------------
export function builtinSegments() {
  const s = allSettings();
  return [
    { key: 'all', name: 'All customers', rules: {} },
    { key: 'recent', name: `Recently active (last ${s.recent_active_days} days)`, rules: { bought_within_days: s.recent_active_days } },
    { key: 'frequent', name: `Frequent buyers (${s.frequent_orders}+ orders in ${s.frequent_window_days} days)`, rules: { min_orders_in_window: { count: s.frequent_orders, days: s.frequent_window_days } } },
    { key: 'high_value', name: 'High-value customers', rules: { min_spend: s.high_value_spend } },
    ...s.inactivity_periods.map((d) => ({ key: `inactive_${d}`, name: `Not purchased in ${d} days`, rules: { min_orders: 1, not_bought_within_days: d } })),
    { key: 'lapsed', name: 'Repeat customers who stopped buying', rules: { min_orders: 2, not_bought_within_days: s.inactive_days } },
    { key: 'balance', name: 'Customers with outstanding balances', rules: { has_balance: true } },
    { key: 'new', name: `New customers (last ${s.new_customer_days} days)`, rules: { registered_within_days: s.new_customer_days } },
  ];
}
function resolveRules(def) {
  if (!def) throw bad('Choose a customer segment');
  if (def.key === 'product') { if (!def.product_id) throw bad('Choose a product for this segment'); return { rules: { product_id: Number(def.product_id), min_orders: 1 }, name: `Purchased ${get('SELECT name FROM products WHERE id=?', def.product_id)?.name || 'product'}` }; }
  if (def.key === 'saved') { const s = get('SELECT * FROM saved_segments WHERE id=?', def.id); if (!s) throw notFound('Saved segment'); return { rules: safeJson(s.rules, {}), name: s.name }; }
  if (def.key === 'custom') return { rules: def.rules || {}, name: 'Custom segment' };
  const b = builtinSegments().find((x) => x.key === def.key); if (!b) throw bad('Unknown segment');
  return { rules: b.rules, name: b.name };
}
function applyRules(rows, rules) {
  const s = allSettings(); const today = todayStr(s.timezone);
  let out = rows;
  const f = (fn) => { out = out.filter(fn); };
  if (rules.min_orders != null) f((c) => c.total_orders >= rules.min_orders);
  if (rules.max_orders != null) f((c) => c.total_orders <= rules.max_orders);
  if (rules.min_spend != null) f((c) => c.total_spent >= rules.min_spend);
  if (rules.max_spend != null) f((c) => c.total_spent <= rules.max_spend);
  if (rules.bought_within_days != null) f((c) => c.last_purchase && diffDays(c.last_purchase, today) <= rules.bought_within_days);
  if (rules.not_bought_within_days != null) f((c) => c.last_purchase && diffDays(c.last_purchase, today) >= rules.not_bought_within_days);
  if (rules.registered_within_days != null) f((c) => diffDays(c.registered_on, today) <= rules.registered_within_days);
  if (rules.has_balance) f((c) => c.outstanding > 0);
  if (rules.category) { const cats = [].concat(rules.category); f((c) => cats.includes(c.category)); }
  if (rules.location) f((c) => (c.location || '').toLowerCase().includes(String(rules.location).toLowerCase()));
  if (rules.status) f((c) => c.status === rules.status);
  if (rules.lifecycle) f((c) => c.lifecycle === rules.lifecycle);
  if (rules.tag) f((c) => (c.tags || '').split(',').includes(rules.tag));
  if (rules.min_orders_in_window) {
    const { count, days } = rules.min_orders_in_window;
    const m = new Map(all(`SELECT customer_id id, COUNT(*) n FROM orders WHERE status NOT IN ('Draft','Cancelled','Returned') AND order_date>=? GROUP BY customer_id`, addDays(today, -days)).map((r) => [r.id, r.n]));
    f((c) => (m.get(c.id) || 0) >= count);
  }
  if (rules.product_id) {
    const set = new Set(all(`SELECT DISTINCT o.customer_id id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=? AND o.status NOT IN ('Draft','Cancelled','Returned')`, rules.product_id).map((r) => r.id));
    f((c) => set.has(c.id));
  }
  return out;
}
export function evalSegment(def, category = 'MARKETING') {
  const { rules, name } = resolveRules(def);
  const rows = applyRules(all(`SELECT * FROM (${customerSelect()}) WHERE status<>'Archived'`), rules);
  const excluded = {}; const eligible = [];
  for (const c of rows) { const why = eligibility(c, category); if (why) excluded[why] = (excluded[why] || 0) + 1; else eligible.push(c); }
  return { name, rules, targeted: rows.length, eligible, excluded };
}

// ---------------- variables & rendering ----------------
function varsFor(c, params = {}, orderId = null) {
  const s = allSettings();
  const ord = orderId ? get('SELECT number FROM orders WHERE id=? AND customer_id=?', orderId, c.id)
    : (get("SELECT number FROM v_orders_fin WHERE customer_id=? AND balance>0 ORDER BY id DESC LIMIT 1", c.id) || get("SELECT number FROM orders WHERE customer_id=? AND status NOT IN ('Draft','Cancelled') ORDER BY id DESC LIMIT 1", c.id));
  const lastProd = get(`SELECT COALESCE(p.name,i.description) n FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.id=i.product_id WHERE o.customer_id=? AND o.status NOT IN ('Draft','Cancelled','Returned') ORDER BY o.order_date DESC, i.id DESC LIMIT 1`, c.id);
  return {
    customer_name: c.name, order_number: ord?.number || '', product_name: params.product_name || lastProd?.n || '',
    last_purchase: c.last_purchase || '', discount: params.discount || '', offer_expiry: params.offer_expiry || '', business_name: s.business_name,
  };
}
function buildMessage(tpl, customer, params, orderId) {
  const vars = varsFor(customer, params, orderId);
  const missing = tpl.params.filter((k) => !vars[k]);
  return { vars, missing, text: render(tpl.body, vars), values: tpl.params.map((k) => String(vars[k] ?? '').replace(/\s*\n+\s*/g, ' ')) };
}

async function sendTemplateMessage(phone, tpl, values) {
  const c = config.wa();
  const payload = { messaging_product: 'whatsapp', to: phoneDigits(phone), type: 'template', template: { name: tpl.wa_name, language: { code: tpl.language } } };
  if (values.length) payload.template.components = [{ type: 'body', parameters: values.map((v) => ({ type: 'text', text: v })) }];
  const r = await graph('POST', `${c.phoneNumberId}/messages`, payload);
  return r.messages?.[0]?.id;
}

// ---------------- sending a single message (order confirmations, reminders, replies) ----------------
async function sendOne({ customer_id, template_id, params = {}, order_id = null }, user) {
  const c = all(`SELECT * FROM (${customerSelect()}) WHERE id=?`, customer_id)[0]; if (!c) throw notFound('Customer');
  const tpl = getTemplate(template_id); if (!tpl) throw notFound('Template');
  if (!waStatus().can_send) throw bad('WhatsApp is not configured on this server');
  if (!tpl.usable) throw bad(`Template "${tpl.name}" is not approved by WhatsApp yet (status: ${tpl.meta_status})`);
  const why = eligibility(c, tpl.category); if (why) throw bad(`Cannot message this customer: ${why.replaceAll('_', ' ')}`);
  const m = buildMessage(tpl, c, params, order_id);
  if (m.missing.length) throw bad(`Missing values for: ${m.missing.map((x) => '{' + x + '}').join(', ')}`);
  const id = run("INSERT INTO whatsapp_messages(customer_id,phone,direction,kind,template_id,body,status,created_at) VALUES (?,?,'out','template',?,?,'queued',?)", c.id, c.whatsapp, tpl.id, m.text, nowIso()).lastInsertRowid;
  try {
    const wamid = await sendTemplateMessage(c.whatsapp, tpl, m.values);
    run("UPDATE whatsapp_messages SET status='sent', wamid=?, sent_at=? WHERE id=?", wamid, nowIso(), id);
  } catch (e) { run("UPDATE whatsapp_messages SET status='failed', error=? WHERE id=?", e.message.slice(0, 300), id); throw e; }
  audit(user, 'send_template', 'whatsapp', c.id, null, { template: tpl.name });
  return get('SELECT * FROM whatsapp_messages WHERE id=?', id);
}

async function sendOwnerAlert(text) {
  const st = allSettings();
  if (!st.owner_whatsapp || !st.owner_alert_template || !waStatus().can_send) return;
  const tpl = get('SELECT * FROM whatsapp_templates WHERE id=?', st.owner_alert_template);
  if (!tpl || tpl.meta_status !== 'APPROVED') return;
  await sendTemplateMessage(normPhone(st.owner_whatsapp, st.default_country_code), shapeTpl(tpl), [text.replace(/\s+/g, ' ')]);
}
setOwnerWhatsAppSender(sendOwnerAlert);

// ---------------- campaign engine ----------------
const rank = { queued: 0, sent: 1, delivered: 2, read: 3 };
function campaignStats(id) {
  const s = get(`SELECT COUNT(*) total, COUNT(sent_at) sent, COUNT(delivered_at) delivered, COUNT(read_at) read,
      COUNT(CASE WHEN status='failed' THEN 1 END) failed, COUNT(CASE WHEN status='skipped' THEN 1 END) skipped, COUNT(CASE WHEN status='queued' THEN 1 END) queued
    FROM whatsapp_messages WHERE campaign_id=? AND direction='out'`, id);
  const replies = get("SELECT COUNT(*) c, COUNT(DISTINCT customer_id) people FROM whatsapp_messages WHERE reply_to_campaign_id=? AND direction='in'", id);
  const attr = get(`SELECT COUNT(*) orders, COALESCE(SUM(f.revenue_base),0) revenue FROM campaign_attributions a JOIN v_orders_fin f ON f.id=a.order_id WHERE a.campaign_id=? AND f.status NOT IN ('Draft','Cancelled','Returned')`, id);
  return { ...s, replies: replies.c, repliers: replies.people, attributed_orders: attr.orders, attributed_revenue: attr.revenue };
}
const shapeCampaign = (c) => ({ ...c, segment: safeJson(c.segment, {}), params: safeJson(c.params, {}), excluded: safeJson(c.excluded, {}), stats: campaignStats(c.id) });

function startCampaign(c) {
  const tpl = getTemplate(c.template_id); const params = safeJson(c.params, {});
  const seg = evalSegment(safeJson(c.segment), tpl.category);
  const excluded = { ...seg.excluded };
  tx(() => {
    for (const cust of seg.eligible) {
      const m = buildMessage(tpl, cust, params);
      if (m.missing.length) { excluded.missing_values = (excluded.missing_values || 0) + 1; continue; }
      run("INSERT INTO whatsapp_messages(campaign_id,customer_id,phone,direction,kind,template_id,body,status,created_at) VALUES (?,?,?,'out','template',?,?,'queued',?)", c.id, cust.id, cust.whatsapp, tpl.id, m.text, nowIso());
    }
    const queued = get("SELECT COUNT(*) n FROM whatsapp_messages WHERE campaign_id=? AND status='queued'", c.id).n;
    run("UPDATE whatsapp_campaigns SET status='sending', started_at=?, targeted=?, eligible=?, excluded=? WHERE id=?", nowIso(), seg.targeted, queued, JSON.stringify(excluded), c.id);
  });
}

let working = false;
export async function processCampaigns() {
  if (working) return; working = true;
  try {
    for (const c of all("SELECT * FROM whatsapp_campaigns WHERE status='scheduled' AND scheduled_at<=?", nowIso())) {
      if (!waStatus().can_send) { run("UPDATE whatsapp_campaigns SET status='failed', error='WhatsApp is not configured on the server' WHERE id=?", c.id); continue; }
      try { startCampaign(c); } catch (e) { run("UPDATE whatsapp_campaigns SET status='failed', error=? WHERE id=?", e.message, c.id); }
    }
    for (const c of all("SELECT * FROM whatsapp_campaigns WHERE status='sending'")) {
      const tpl = getTemplate(c.template_id);
      const batch = all("SELECT m.*, (SELECT status FROM customers WHERE id=m.customer_id) cstatus FROM whatsapp_messages m WHERE campaign_id=? AND status='queued' ORDER BY id LIMIT 25", c.id);
      for (const m of batch) {
        // consent is re-verified immediately before every send: opt-outs received mid-campaign are honoured
        const cust = all(`SELECT * FROM (${customerSelect()}) WHERE id=?`, m.customer_id)[0];
        const why = cust ? eligibility(cust, tpl.category) : 'customer_deleted';
        if (why) { run("UPDATE whatsapp_messages SET status='skipped', error=? WHERE id=?", why, m.id); continue; }
        try {
          const vals = buildMessage(tpl, cust, safeJson(c.params, {})).values;
          const wamid = await sendTemplateMessage(m.phone, tpl, vals);
          run("UPDATE whatsapp_messages SET status='sent', wamid=?, sent_at=? WHERE id=?", wamid, nowIso(), m.id);
        } catch (e) {
          run("UPDATE whatsapp_messages SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), m.id);
          if (e.waCode === 190 || /access token/i.test(e.message)) { run("UPDATE whatsapp_campaigns SET status='failed', error=? WHERE id=?", e.message, c.id); break; }
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      const left = get("SELECT COUNT(*) n FROM whatsapp_messages WHERE campaign_id=? AND status='queued'", c.id).n;
      const cur = get('SELECT status FROM whatsapp_campaigns WHERE id=?', c.id).status;
      if (!left && cur === 'sending') {
        run("UPDATE whatsapp_campaigns SET status='completed', completed_at=? WHERE id=?", nowIso(), c.id);
        const s = campaignStats(c.id);
        notify({ type: 'campaign_completed', title: `Campaign "${c.name}" completed`, body: `${s.sent} sent, ${s.failed} failed, ${s.skipped} skipped.`, link: `#/marketing?campaign=${c.id}`, entity_type: 'campaign', entity_id: c.id, dedupe_key: `campaign_done:${c.id}` });
      }
    }
  } finally { working = false; }
}

// ---------------- attribution ----------------
on('order.created', (o) => {
  const days = Number(allSettings().attribution_days) || 7;
  const m = get(`SELECT id, campaign_id FROM whatsapp_messages WHERE customer_id=? AND campaign_id IS NOT NULL AND direction='out' AND sent_at IS NOT NULL AND sent_at>=? AND status IN ('sent','delivered','read')
    ORDER BY sent_at DESC LIMIT 1`, o.customer_id, new Date(Date.now() - days * 864e5).toISOString());
  if (m) run('INSERT OR IGNORE INTO campaign_attributions(campaign_id,order_id,customer_id,message_id,created_at) VALUES (?,?,?,?,?)', m.campaign_id, o.id, o.customer_id, m.id, nowIso());
});

// ---------------- webhook ----------------
function verifySignature(raw_, sig) {
  const secret = config.wa().appSecret; if (!secret || !sig) return false;
  const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(raw_).digest('hex');
  return exp.length === sig.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig));
}
function customerByPhone(phone) {
  const d = phoneDigits(phone);
  return get("SELECT id, name, whatsapp, phone FROM customers WHERE REPLACE(whatsapp,'+','')=? OR REPLACE(phone,'+','')=? OR REPLACE(COALESCE(phone2,''),'+','')=? ORDER BY (REPLACE(whatsapp,'+','')=?) DESC LIMIT 1", d, d, d, d);
}
async function handleInbound(m) {
  const st = allSettings();
  const cust = customerByPhone(m.from);
  const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || `[${m.type}]`;
  if (m.id && get('SELECT 1 x FROM whatsapp_messages WHERE wamid=?', m.id)) return;
  const since = new Date(Date.now() - (Number(st.attribution_days) || 7) * 864e5).toISOString();
  const camp = cust ? get("SELECT campaign_id FROM whatsapp_messages WHERE customer_id=? AND campaign_id IS NOT NULL AND direction='out' AND sent_at>=? ORDER BY sent_at DESC LIMIT 1", cust.id, since) : null;
  run("INSERT INTO whatsapp_messages(customer_id,phone,direction,kind,body,wamid,status,reply_to_campaign_id,created_at) VALUES (?,?,'in','text',?,?,'received',?,?)",
    cust?.id ?? null, '+' + phoneDigits(m.from), text.slice(0, 1000), m.id ?? null, camp?.campaign_id ?? null, m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : nowIso());
  const word = text.trim().toUpperCase();
  if (cust && st.wa_optout_keywords.map((k) => k.toUpperCase()).includes(word)) {
    recordConsent(cust.id, 'opted_out', 'Customer replied "' + text.trim().slice(0, 30) + '" on WhatsApp', m.id || null, null);
    notify({ type: 'unusual_transaction', severity: 'info', title: `${cust.name} opted out of WhatsApp messages`, body: 'Added to the suppression list. No further promotional messages will be sent.', link: `#/customers?open=${cust.id}`, entity_type: 'customer', entity_id: cust.id });
    graph('POST', `${config.wa().phoneNumberId}/messages`, { messaging_product: 'whatsapp', to: phoneDigits(m.from), type: 'text', text: { body: `You have been unsubscribed from ${st.business_name} messages. Reply START to subscribe again.` } }).catch(() => {});
  } else if (cust && st.wa_optin_keywords.map((k) => k.toUpperCase()).includes(word)) {
    recordConsent(cust.id, 'opted_in', 'Customer replied "' + text.trim().slice(0, 30) + '" on WhatsApp', m.id || null, null);
  }
}
function handleStatus(s) {
  const row = get('SELECT id, status FROM whatsapp_messages WHERE wamid=?', s.id); if (!row) return;
  const ts = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : nowIso();
  if (s.status === 'failed') { run("UPDATE whatsapp_messages SET status='failed', error=? WHERE id=?", (s.errors?.[0]?.title || s.errors?.[0]?.message || 'Delivery failed').slice(0, 300), row.id); return; }
  if (!(s.status in rank)) return;
  const sets = []; const p = [];
  if (rank[s.status] > (rank[row.status] ?? -1)) { sets.push('status=?'); p.push(s.status); }
  if (s.status === 'sent') sets.push('sent_at=COALESCE(sent_at,?)'), p.push(ts);
  if (s.status === 'delivered') sets.push('sent_at=COALESCE(sent_at,?)', 'delivered_at=COALESCE(delivered_at,?)'), p.push(ts, ts);
  if (s.status === 'read') sets.push('sent_at=COALESCE(sent_at,?)', 'delivered_at=COALESCE(delivered_at,?)', 'read_at=COALESCE(read_at,?)'), p.push(ts, ts, ts);
  if (sets.length) run(`UPDATE whatsapp_messages SET ${sets.join(',')} WHERE id=?`, ...p, row.id);
}
route('GET', '/webhooks/whatsapp', { perm: 'public' }, (ctx) => {
  const c = config.wa();
  if (ctx.query['hub.mode'] === 'subscribe' && c.verifyToken && ctx.query['hub.verify_token'] === c.verifyToken) return raw(String(ctx.query['hub.challenge'] || ''), 'text/plain');
  return reply(403, { error: 'Verification failed' });
});
route('POST', '/webhooks/whatsapp', { perm: 'public', raw: true }, async (ctx) => {
  if (!config.wa().appSecret) return reply(503, { error: 'WHATSAPP_APP_SECRET is not set, so webhook signatures cannot be verified' });
  if (!verifySignature(ctx.rawBody, ctx.req.headers['x-hub-signature-256'])) return reply(401, { error: 'Invalid signature' });
  const body = safeJson(ctx.rawBody.toString('utf8'), {});
  for (const e of body.entry || []) for (const ch of e.changes || []) {
    const v = ch.value || {};
    for (const s of v.statuses || []) { try { handleStatus(s); } catch (err) { log.warn('wa status', err.message); } }
    for (const m of v.messages || []) { try { await handleInbound(m); } catch (err) { log.warn('wa inbound', err.message); } }
  }
  return { ok: true };
});

// ---------------- API routes ----------------
const R = { perm: 'marketing:read' }; const W = { perm: 'marketing:write' };
GET('/api/whatsapp/status', R, () => waStatus());
POST('/api/whatsapp/test', W, async () => {
  const c = config.wa();
  if (!c.token || !c.phoneNumberId) throw bad('Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID first (see docs/WHATSAPP_SETUP.md)');
  try {
    const r = await graph('GET', `${c.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
    setSettings({ wa_last_test: { ok: true, at: nowIso(), display_phone_number: r.display_phone_number, verified_name: r.verified_name, quality_rating: r.quality_rating } });
  } catch (e) { setSettings({ wa_last_test: { ok: false, at: nowIso(), error: e.message } }); }
  return waStatus();
});

GET('/api/whatsapp/placeholders', R, () => ({ placeholders: PLACEHOLDERS, samples: { ...SAMPLE, business_name: allSettings().business_name } }));
GET('/api/whatsapp/templates', R, () => all('SELECT * FROM whatsapp_templates ORDER BY category, name').map(shapeTpl));
function tplInput(b, cur) {
  const body = str(b.body ?? cur?.body, 'Message body', { required: true, max: 1024 });
  const bad_ = paramsOf(body).filter((x) => !PLACEHOLDERS.includes(x)); if (bad_.length) throw bad(`Unknown placeholder(s): ${bad_.map((x) => '{' + x + '}').join(', ')}. Allowed: ${PLACEHOLDERS.map((x) => '{' + x + '}').join(' ')}`);
  const name = str(b.name ?? cur?.name, 'Name', { required: true, max: 80 });
  return { name, body, category: oneOf(b.category ?? cur?.category, 'Category', ['MARKETING', 'UTILITY'], { def: 'MARKETING' }), language: str(b.language ?? cur?.language ?? 'en', 'Language', { max: 10 }) || 'en', purpose: str(b.purpose ?? cur?.purpose ?? 'custom', 'Purpose', { max: 40 }) };
}
POST('/api/whatsapp/templates', W, (ctx) => {
  const v = tplInput(ctx.body); const wa = slug(ctx.body.wa_name || v.name);
  if (get('SELECT 1 x FROM whatsapp_templates WHERE name=? OR wa_name=?', v.name, wa)) throw conflict('A template with this name already exists');
  const id = run('INSERT INTO whatsapp_templates(name,wa_name,category,purpose,language,body,meta_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', v.name, wa, v.category, v.purpose, v.language, v.body, 'LOCAL_DRAFT', nowIso(), nowIso()).lastInsertRowid;
  audit(ctx.user, 'create', 'wa_template', id, null, v); return getTemplate(id);
});
PUT('/api/whatsapp/templates/:id', W, (ctx) => {
  const cur = get('SELECT * FROM whatsapp_templates WHERE id=?', ctx.params.id); if (!cur) throw notFound('Template');
  if (['APPROVED', 'PENDING'].includes(cur.meta_status) && (ctx.body.body !== undefined && ctx.body.body !== cur.body)) throw bad('Approved or pending templates cannot be edited. Duplicate it, edit the copy and submit that.');
  const v = tplInput(ctx.body, cur);
  run('UPDATE whatsapp_templates SET name=?,category=?,purpose=?,language=?,body=?,updated_at=? WHERE id=?', v.name, v.category, v.purpose, v.language, v.body, nowIso(), cur.id);
  audit(ctx.user, 'update', 'wa_template', cur.id, { body: cur.body }, v); return getTemplate(cur.id);
});
POST('/api/whatsapp/templates/:id/duplicate', W, (ctx) => {
  const cur = get('SELECT * FROM whatsapp_templates WHERE id=?', ctx.params.id); if (!cur) throw notFound('Template');
  let n = 2; while (get('SELECT 1 x FROM whatsapp_templates WHERE name=?', `${cur.name} (v${n})`)) n++;
  const name = `${cur.name} (v${n})`;
  const id = run("INSERT INTO whatsapp_templates(name,wa_name,category,purpose,language,body,meta_status,created_at,updated_at) VALUES (?,?,?,?,?,?,'LOCAL_DRAFT',?,?)", name, slug(name), cur.category, cur.purpose, cur.language, cur.body, nowIso(), nowIso()).lastInsertRowid;
  return getTemplate(id);
});
DELETE('/api/whatsapp/templates/:id', W, (ctx) => {
  if (get('SELECT 1 x FROM whatsapp_campaigns WHERE template_id=? LIMIT 1', ctx.params.id)) throw bad('This template is used by a campaign and cannot be deleted');
  run('DELETE FROM whatsapp_templates WHERE id=?', ctx.params.id); audit(ctx.user, 'delete', 'wa_template', ctx.params.id); return { ok: true };
});
POST('/api/whatsapp/templates/:id/submit', W, async (ctx) => {
  const t = getTemplate(ctx.params.id); if (!t) throw notFound('Template');
  if (!waStatus().can_manage_templates) throw bad('Set WHATSAPP_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID to submit templates to Meta');
  if (t.warnings.length) throw bad('Fix the template first: ' + t.warnings.join(' '));
  if (['PENDING', 'APPROVED'].includes(t.meta_status)) throw bad('This template was already submitted');
  const st = allSettings();
  const example = t.params.map((k) => (k === 'business_name' ? st.business_name : SAMPLE[k]));
  const comp = { type: 'BODY', text: t.meta_body }; if (example.length) comp.example = { body_text: [example] };
  const r = await graph('POST', `${config.wa().wabaId}/message_templates`, { name: t.wa_name, language: t.language, category: t.category, components: [comp] });
  run('UPDATE whatsapp_templates SET meta_id=?, meta_status=?, meta_reason=NULL, updated_at=? WHERE id=?', r.id ?? null, r.status || 'PENDING', nowIso(), t.id);
  audit(ctx.user, 'submit', 'wa_template', t.id, null, { status: r.status }); return getTemplate(t.id);
});
POST('/api/whatsapp/templates/sync', W, async () => {
  if (!waStatus().can_manage_templates) throw bad('Set WHATSAPP_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID first');
  const r = await graph('GET', `${config.wa().wabaId}/message_templates?fields=name,status,language,rejected_reason,id&limit=200`);
  let updated = 0;
  for (const m of r.data || []) {
    const row = get('SELECT * FROM whatsapp_templates WHERE wa_name=? AND language=?', m.name, m.language);
    if (row && (row.meta_status !== m.status || row.meta_id !== m.id)) { run('UPDATE whatsapp_templates SET meta_status=?, meta_id=?, meta_reason=?, updated_at=? WHERE id=?', m.status, m.id, m.rejected_reason && m.rejected_reason !== 'NONE' ? m.rejected_reason : null, nowIso(), row.id); updated++; }
  }
  return { updated };
});
POST('/api/whatsapp/templates/:id/preview', R, (ctx) => {
  const t = getTemplate(ctx.params.id); if (!t) throw notFound('Template');
  const st = allSettings(); const vars = { ...SAMPLE, business_name: st.business_name, ...(ctx.body.vars || {}) };
  return { text: render(t.body, vars), params: t.params };
});

GET('/api/whatsapp/segments', R, () => {
  const rows = all(`SELECT * FROM (${customerSelect()}) WHERE status<>'Archived'`);
  const mk = (key, name, rules, extra = {}) => { const sel = applyRules(rows, rules); const el = sel.filter((c) => !eligibility(c, 'MARKETING')).length; return { key, name, targeted: sel.length, eligible_marketing: el, ...extra }; };
  return {
    builtin: builtinSegments().map((s) => mk(s.key, s.name, s.rules)),
    saved: all('SELECT * FROM saved_segments ORDER BY name').map((s) => mk('saved', s.name, safeJson(s.rules, {}), { id: s.id, rules: safeJson(s.rules, {}) })),
    categories: allSettings().customer_categories, locations: all("SELECT DISTINCT location FROM customers WHERE location<>'' ORDER BY location").map((r) => r.location),
  };
});
POST('/api/whatsapp/segments/preview', R, (ctx) => {
  const seg = evalSegment(ctx.body.segment, oneOf(ctx.body.category, 'Category', ['MARKETING', 'UTILITY'], { def: 'MARKETING' }));
  return { name: seg.name, targeted: seg.targeted, eligible: seg.eligible.length, excluded: seg.excluded, sample: seg.eligible.slice(0, 20).map((c) => ({ id: c.id, name: c.name, whatsapp: c.whatsapp, last_purchase: c.last_purchase, total_spent: c.total_spent })) };
});
POST('/api/whatsapp/segments', W, (ctx) => {
  const name = str(ctx.body.name, 'Name', { required: true, max: 80 });
  if (get('SELECT 1 x FROM saved_segments WHERE name=?', name)) throw conflict('A saved segment with this name exists');
  const id = run('INSERT INTO saved_segments(name,rules,created_at) VALUES (?,?,?)', name, JSON.stringify(ctx.body.rules || {}), nowIso()).lastInsertRowid; return { id };
});
DELETE('/api/whatsapp/segments/:id', W, (ctx) => { run('DELETE FROM saved_segments WHERE id=?', ctx.params.id); return { ok: true }; });

function campaignInput(b) {
  const tpl = getTemplate(Number(b.template_id)); if (!tpl) throw bad('Choose a message template');
  resolveRules(b.segment);
  return { name: str(b.name, 'Campaign name', { required: true, max: 120 }), tpl, params: { discount: str(b.params?.discount, 'Discount', { max: 60 }), offer_expiry: str(b.params?.offer_expiry, 'Offer expiry', { max: 60 }), product_name: str(b.params?.product_name, 'Product', { max: 100 }) } };
}
GET('/api/whatsapp/campaigns', R, () => all('SELECT c.*, t.name AS template_name FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id=c.template_id ORDER BY c.id DESC').map(shapeCampaign));
GET('/api/whatsapp/campaigns/:id', R, (ctx) => {
  const c = get('SELECT c.*, t.name AS template_name, t.body AS template_body FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id=c.template_id WHERE c.id=?', ctx.params.id); if (!c) throw notFound('Campaign');
  const limit = Math.min(Number(ctx.query.limit) || 100, 500); const offset = Number(ctx.query.offset) || 0;
  return { ...shapeCampaign(c), messages: all(`SELECT m.id, m.status, m.error, m.sent_at, m.delivered_at, m.read_at, m.body, m.phone, cu.name AS customer_name FROM whatsapp_messages m LEFT JOIN customers cu ON cu.id=m.customer_id WHERE m.campaign_id=? AND m.direction='out' ORDER BY m.id LIMIT ? OFFSET ?`, c.id, limit, offset) };
});
POST('/api/whatsapp/campaigns', W, (ctx) => {
  const v = campaignInput(ctx.body);
  const id = run("INSERT INTO whatsapp_campaigns(name,segment,template_id,params,status,created_by,created_at) VALUES (?,?,?,?,'draft',?,?)", v.name, JSON.stringify(ctx.body.segment), v.tpl.id, JSON.stringify(v.params), ctx.user.id, nowIso()).lastInsertRowid;
  audit(ctx.user, 'create', 'campaign', id, null, { name: v.name }); return shapeCampaign(get('SELECT * FROM whatsapp_campaigns WHERE id=?', id));
});
PUT('/api/whatsapp/campaigns/:id', W, (ctx) => {
  const c = get('SELECT * FROM whatsapp_campaigns WHERE id=?', ctx.params.id); if (!c) throw notFound('Campaign');
  if (!['draft', 'scheduled'].includes(c.status)) throw bad('Only draft or scheduled campaigns can be edited');
  const v = campaignInput(ctx.body);
  run("UPDATE whatsapp_campaigns SET name=?, segment=?, template_id=?, params=?, status='draft', scheduled_at=NULL WHERE id=?", v.name, JSON.stringify(ctx.body.segment), v.tpl.id, JSON.stringify(v.params), c.id);
  return shapeCampaign(get('SELECT * FROM whatsapp_campaigns WHERE id=?', c.id));
});
POST('/api/whatsapp/campaigns/:id/preview', R, (ctx) => {
  const c = get('SELECT * FROM whatsapp_campaigns WHERE id=?', ctx.params.id); if (!c) throw notFound('Campaign');
  const tpl = getTemplate(c.template_id); const params = safeJson(c.params, {});
  const seg = evalSegment(safeJson(c.segment), tpl.category);
  const msgs = seg.eligible.map((cu) => ({ cu, m: buildMessage(tpl, cu, params) }));
  const ok = msgs.filter((x) => !x.m.missing.length);
  return {
    targeted: seg.targeted, eligible: ok.length, excluded: { ...seg.excluded, ...(msgs.length - ok.length ? { missing_values: msgs.length - ok.length } : {}) },
    template: { name: tpl.name, category: tpl.category, status: tpl.meta_status, usable: tpl.usable },
    samples: ok.slice(0, 5).map((x) => ({ customer: x.cu.name, phone: x.cu.whatsapp, text: x.m.text })),
    problems: msgs.filter((x) => x.m.missing.length).slice(0, 5).map((x) => ({ customer: x.cu.name, missing: x.m.missing })),
    send_blockers: [!waStatus().can_send && 'WhatsApp credentials are not configured on the server', !tpl.usable && `Template is not approved by WhatsApp (status: ${tpl.meta_status})`, !ok.length && 'No eligible recipients'].filter(Boolean),
  };
});
POST('/api/whatsapp/campaigns/:id/send', W, (ctx) => {
  const c = get('SELECT * FROM whatsapp_campaigns WHERE id=?', ctx.params.id); if (!c) throw notFound('Campaign');
  if (!['draft', 'scheduled'].includes(c.status)) throw bad(`Campaign is already ${c.status}`);
  const tpl = getTemplate(c.template_id);
  if (!waStatus().can_send) throw bad('WhatsApp is not configured on this server. Add the credentials (docs/WHATSAPP_SETUP.md) before sending.');
  if (!tpl.usable) throw bad(`Template "${tpl.name}" must be approved by WhatsApp first (status: ${tpl.meta_status}). Submit it and sync its status in the Templates tab.`);
  let at = nowIso();
  if (ctx.body.scheduled_at) { const t = Date.parse(ctx.body.scheduled_at); if (Number.isNaN(t)) throw bad('Invalid schedule time'); if (t < Date.now() - 60000) throw bad('Schedule time is in the past'); at = new Date(t).toISOString(); }
  run("UPDATE whatsapp_campaigns SET status='scheduled', scheduled_at=? WHERE id=?", at, c.id);
  audit(ctx.user, 'schedule', 'campaign', c.id, null, { at });
  setImmediate(() => processCampaigns().catch((e) => log.error('campaign', e)));
  return shapeCampaign(get('SELECT * FROM whatsapp_campaigns WHERE id=?', c.id));
});
POST('/api/whatsapp/campaigns/:id/cancel', W, (ctx) => {
  const c = get('SELECT * FROM whatsapp_campaigns WHERE id=?', ctx.params.id); if (!c) throw notFound('Campaign');
  if (!['draft', 'scheduled', 'sending'].includes(c.status)) throw bad(`A ${c.status} campaign cannot be cancelled`);
  tx(() => {
    run("UPDATE whatsapp_messages SET status='skipped', error='campaign cancelled' WHERE campaign_id=? AND status='queued'", c.id);
    run("UPDATE whatsapp_campaigns SET status='cancelled', completed_at=? WHERE id=?", nowIso(), c.id);
    audit(ctx.user, 'cancel', 'campaign', c.id);
  });
  return shapeCampaign(get('SELECT * FROM whatsapp_campaigns WHERE id=?', c.id));
});
DELETE('/api/whatsapp/campaigns/:id', W, (ctx) => {
  const c = get('SELECT * FROM whatsapp_campaigns WHERE id=?', ctx.params.id); if (!c) throw notFound('Campaign');
  if (!['draft', 'cancelled', 'failed'].includes(c.status)) throw bad('Only draft, cancelled or failed campaigns can be deleted');
  run('DELETE FROM whatsapp_campaigns WHERE id=?', c.id); return { ok: true };
});

POST('/api/whatsapp/send-template', { perm: ['marketing:write', 'payments:write', 'orders:write'] }, async (ctx) => {
  return sendOne({ customer_id: Number(ctx.body.customer_id), template_id: Number(ctx.body.template_id), params: ctx.body.params || {}, order_id: ctx.body.order_id ? Number(ctx.body.order_id) : null }, ctx.user);
});
POST('/api/whatsapp/send-text', W, async (ctx) => {
  const c = all(`SELECT * FROM (${customerSelect()}) WHERE id=?`, Number(ctx.body.customer_id))[0]; if (!c) throw notFound('Customer');
  const text = str(ctx.body.text, 'Message', { required: true, max: 1000 });
  if (!waStatus().can_send) throw bad('WhatsApp is not configured on this server');
  const why = eligibility(c, 'UTILITY'); if (why) throw bad(`Cannot message this customer: ${why.replaceAll('_', ' ')}`);
  const lastIn = get("SELECT created_at FROM whatsapp_messages WHERE customer_id=? AND direction='in' ORDER BY id DESC LIMIT 1", c.id)?.created_at;
  if (!lastIn || Date.now() - Date.parse(lastIn) > 24 * 3600e3) throw bad('The 24-hour customer service window is closed. WhatsApp only allows approved templates until the customer messages you again.');
  const id = run("INSERT INTO whatsapp_messages(customer_id,phone,direction,kind,body,status,created_at) VALUES (?,?,'out','text',?,'queued',?)", c.id, c.whatsapp, text, nowIso()).lastInsertRowid;
  try {
    const r = await graph('POST', `${config.wa().phoneNumberId}/messages`, { messaging_product: 'whatsapp', to: phoneDigits(c.whatsapp), type: 'text', text: { body: text } });
    run("UPDATE whatsapp_messages SET status='sent', wamid=?, sent_at=? WHERE id=?", r.messages?.[0]?.id ?? null, nowIso(), id);
  } catch (e) { run("UPDATE whatsapp_messages SET status='failed', error=? WHERE id=?", e.message.slice(0, 300), id); throw e; }
  return get('SELECT * FROM whatsapp_messages WHERE id=?', id);
});

GET('/api/whatsapp/consents', R, (ctx) => {
  const rows = all(`SELECT * FROM (${customerSelect()}) WHERE status<>'Archived'`);
  const out = rows.map((c) => ({ id: c.id, name: c.name, whatsapp: c.whatsapp, consent: c.marketing_consent || 'none', suppressed: !!get('SELECT 1 x FROM suppression_list WHERE phone=? OR customer_id=?', c.whatsapp || '', c.id) }));
  const filt = ctx.query.status ? out.filter((x) => x.consent === ctx.query.status) : out;
  return { counts: { opted_in: out.filter((x) => x.consent === 'opted_in').length, opted_out: out.filter((x) => x.consent === 'opted_out').length, none: out.filter((x) => x.consent === 'none').length }, rows: filt.slice(0, 500) };
});
POST('/api/whatsapp/consents/bulk', W, (ctx) => {
  if (ctx.body.confirm !== true) throw bad('You must confirm that these customers gave their consent');
  const source = str(ctx.body.source, 'Consent source', { required: true, max: 200 });
  const ids = (ctx.body.customer_ids || []).map(Number).filter(Boolean); if (!ids.length) throw bad('Choose customers');
  tx(() => ids.forEach((id) => { if (getCustomer(id)) recordConsent(id, 'opted_in', source, str(ctx.body.evidence, 'Evidence', { max: 300 }), ctx.user); }));
  return { updated: ids.length };
});
GET('/api/whatsapp/suppression', R, () => all('SELECT s.*, c.name AS customer_name FROM suppression_list s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC'));
POST('/api/whatsapp/suppression', W, (ctx) => {
  const phone = normPhone(str(ctx.body.phone, 'Phone', { required: true }), allSettings().default_country_code);
  const cust = get('SELECT id FROM customers WHERE whatsapp=? OR phone=?', phone, phone);
  run('INSERT INTO suppression_list(customer_id,phone,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(phone) DO UPDATE SET reason=excluded.reason', cust?.id ?? null, phone, str(ctx.body.reason, 'Reason', { max: 200 }) || 'Added manually', nowIso());
  if (cust) run("INSERT INTO customer_consent(customer_id,status,source,created_at,created_by) VALUES (?, 'opted_out', ?, ?, ?)", cust.id, 'Added to suppression list', nowIso(), ctx.user.id);
  audit(ctx.user, 'suppress', 'whatsapp', phone); return { ok: true };
});
GET('/api/whatsapp/messages', R, (ctx) => {
  const limit = Math.min(Number(ctx.query.limit) || 100, 500);
  return all(`SELECT m.id, m.direction, m.kind, m.status, m.body, m.error, m.created_at, m.campaign_id, c.name AS customer_name, m.customer_id FROM whatsapp_messages m LEFT JOIN customers c ON c.id=m.customer_id ORDER BY m.id DESC LIMIT ?`, limit);
});
