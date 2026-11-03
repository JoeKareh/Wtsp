// "Ask your business": questions in plain language, answered from this workspace's own figures.
import { html, mount, $, $$, get, post, fail } from '../core.js';

export default async function (view) {
  let st; try { st = await get('/api/ai/status'); } catch (e) { return fail(e); }
  const on = st.enabled && st.included;
  mount(view, html`<div class="page-head"><div class="grow"><h1>Ask your business</h1><p>Ask a question in your own words. The assistant looks at your figures (it can only read, never change anything).</p></div></div>
    ${!st.enabled ? html`<div class="alert warn">The AI assistant is not switched on yet.</div>` : !st.included ? html`<div class="alert warn">The AI assistant is not included in your plan. <a href="#/billing">See plans</a></div>` : ''}
    <div class="card"><form id="af"><div class="field"><label>How can we help?</label><input name="q" maxlength="500" placeholder="Who owes me money?" autocomplete="off" ${on ? '' : 'disabled'}></div>
      <div class="toolbar">${st.examples.map((x) => html`<button type="button" class="btn sm ghost" data-ex>${x}</button>`)}</div>
      <button class="btn primary" ${on ? '' : 'disabled'}>Ask</button> <span class="small muted" id="cr">${st.credits_left != null ? st.credits_left + ' questions left this month' : ''}</span>
      <p class="small muted" style="margin-top:8px">To answer, summary figures and customer names (never phone numbers or emails) are sent to an AI service. Check important numbers before acting.</p></form></div>
    <div id="ans"></div>`);
  const f = $('#af', view);
  $$('[data-ex]', view).forEach((b) => b.addEventListener('click', () => { if (!on) return; f.q.value = b.textContent; f.requestSubmit(); }));
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); const q = f.q.value.trim(); if (!q) return; const btn = $('button.primary', f); btn.disabled = true; mount($('#ans', view), html`<div class="card loading">Thinking…</div>`);
    try {
      const r = await post('/api/ai/ask', { question: q });
      mount($('#ans', view), html`<div class="card"><div class="small muted">${q}</div><div style="white-space:pre-wrap;margin-top:8px;font-size:15px" dir="auto">${r.answer}</div></div>`);
      if (r.credits_left != null) $('#cr', view).textContent = r.credits_left + ' questions left this month';
    } catch (er) { $('#ans', view).innerHTML = ''; fail(er); } finally { btn.disabled = false; }
  });
}
