// "Get started in 10 minutes": a checklist driven by real data (a step is done because the data exists, not because a box was ticked).
import { html, mount, $, $$, state, get, post, put, fail, toast } from '../core.js';
import { importDialog } from './import.js';

const TYPES = [['retail', 'Retail shop'], ['food', 'Food & restaurant'], ['services', 'Services'], ['wholesale', 'Wholesale'], ['other', 'Other']];
const STEPS = {
  business: { title: 'Tell us about your business', body: () => html`<p class="muted">We set up sensible categories for you.</p><div class="toolbar">${TYPES.map(([k, l]) => html`<button class="btn" data-bt="${k}">${l}</button>`)}</div>` },
  currency: { title: 'Check your currency and country', body: () => html`<p class="muted">Prices and reports use your main currency. You can add more later.</p><a class="btn" href="#/settings">Open settings</a>`, skip: true },
  import: { title: 'Import your customers', body: () => html`<p class="muted">Bring your customer list from Excel or another tool. We show you exactly which rows need fixing before anything is saved.</p><div class="toolbar"><button class="btn primary" data-imp="customers">Import customers</button><button class="btn" data-imp="products">Import products</button></div>`, skip: true },
  first_order: { title: 'Create your first order', body: () => html`<p class="muted">Pick a customer, add items, done. Your numbers start building immediately.</p><a class="btn primary" href="#/orders">Go to orders</a>` },
  whatsapp: { title: 'Connect WhatsApp', body: () => html`<p class="muted">Messaging a customer in one tap already works. Connect the official WhatsApp API only if you want automatic or bulk messages.</p><a class="btn" href="#/whatsapp-setup">Set up WhatsApp</a>`, skip: true },
};
export const onbHtml = (o, compact) => html`<div class="card onb"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">Get started in 10 minutes</h2><span class="badge info">${o.done} / ${o.total}</span><span class="grow"></span>${compact ? html`<a class="btn sm" href="#/get-started">Open</a><button class="btn sm ghost" data-hide>Hide this</button>` : ''}</div>
  <div class="bar" style="margin:10px 0"><span style="width:${Math.round((o.done / o.total) * 100)}%"></span></div>
  <ol class="steps">${o.steps.map((s) => html`<li class="${s.done ? 'done' : ''}"><span class="tick">${s.done ? '✓' : ''}</span><div class="grow"><b>${STEPS[s.key].title}</b>${!compact && !s.done ? html`<div style="margin-top:8px">${STEPS[s.key].body()}${STEPS[s.key].skip ? html`<div style="margin-top:8px"><button class="btn sm ghost" data-skip="${s.key}">Skip for now</button></div>` : ''}</div>` : ''}</div></li>`)}</ol></div>`;

export async function wireOnb(root, refresh) {
  root.addEventListener('click', async (e) => {
    try {
      const bt = e.target.closest('[data-bt]'); if (bt) { await post('/api/onboarding/business-type', { type: bt.dataset.bt }); toast('Done', 'success'); return refresh(); }
      const sk = e.target.closest('[data-skip]'); if (sk) { await put('/api/onboarding', { skip: sk.dataset.skip }); return refresh(); }
      const im = e.target.closest('[data-imp]'); if (im) return importDialog(im.dataset.imp, refresh);
      if (e.target.closest('[data-hide]')) { await put('/api/onboarding', { dismissed: true }); return refresh(); }
    } catch (er) { fail(er); }
  });
}
export default async function (view) {
  const draw = async () => { const o = await get('/api/onboarding'); mount(view, html`<div class="page-head"><div class="grow"><h1>Get started</h1><p>Five short steps. Skip anything you do not need.</p></div></div>${onbHtml(o, false)}${o.complete ? html`<p class="alert good">All set! <a href="#/dashboard">Go to your dashboard</a></p>` : ''}`); };
  await draw(); wireOnb(view, draw);
}
export async function dashboardCard(host) {
  if (!host || state.boot?.settings.is_demo || !state.user.permissions.includes('settings:write')) return;
  try { const o = await get('/api/onboarding'); if (o.complete || o.dismissed) return; const draw = async () => { const x = await get('/api/onboarding'); host.innerHTML = x.complete ? '' : onbHtml(x, true).toString(); }; host.innerHTML = onbHtml(o, true).toString(); wireOnb(host, draw); } catch { /* not available (single-business mode) */ }
}
void $; void $$;
