// Help center + contact form (goes to the operator with the workspace id, plan and recent server errors attached).
import { html, mount, $, state, post, fail, toast } from '../core.js';
const ARTICLES = [
  ['How do I add my customers quickly?', 'Open Get started → Import customers. Download the template, paste your customers in, save as CSV, and choose the file. We show you which rows need fixing before anything is saved.'],
  ['How do I send a WhatsApp message to a customer?', 'Press 💬 Chat on WhatsApp on a customer, order, unpaid balance or supplier. WhatsApp opens with a ready message. You can edit it and press send. This works on every plan with no setup.'],
  ['How do I send bulk WhatsApp campaigns?', 'Bulk messages use the official WhatsApp Business API. Open WhatsApp setup and follow the steps with your own Meta account. Only message customers who agreed to receive marketing.'],
  ['What happens when my trial ends?', 'Choose a plan in Billing. If you do nothing, the workspace becomes read-only: you can still see and export everything, but not add new records.'],
  ['How do I pay in Lebanon?', 'In Billing choose "Pay by bank transfer / Whish / OMT", pay the amount shown with your reference, and press "I have paid". We activate your plan and email you a PDF receipt. Pay 3, 6 or 12 months at once for a discount.'],
  ['Why was I signed out?', 'Each login works on one device at a time. If you sign in somewhere else, the earlier device is signed out. Staff should each have their own login (Settings → Users).'],
  ['How do I export or delete my data?', 'Billing → Your data lets you download everything (CSV files, or the database). To delete everything, cancel your subscription and tick "delete all my data".'],
  ['How do I switch to Arabic?', 'Use the language menu in the top bar. Each user chooses their own language.'],
];
export default async function (view) {
  mount(view, html`<div class="page-head"><div class="grow"><h1>Help center</h1><p>Answers first, then a person.</p></div></div>
    <div class="card"><h2>Frequently asked questions</h2>${ARTICLES.map(([q, a]) => html`<details><summary><b>${q}</b></summary><p class="muted">${a}</p></details>`)}</div>
    <div class="card"><h2>Contact support</h2><form id="sf" style="max-width:560px"><div class="field"><label>Subject</label><input name="subject" required maxlength="120"></div><div class="field"><label>How can we help?</label><textarea name="message" required rows="6" maxlength="4000" style="width:100%"></textarea></div>
      <button class="btn primary">Send message</button><span class="small muted"> We reply to ${state.user.email}.</span></form></div>`);
  $('#sf', view).onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await post('/api/support', { subject: f.subject.value, message: f.message.value }); toast('Message sent. We will reply by email.', 'success'); f.reset(); } catch (er) { fail(er); } };
}
