import { html, raw, mount, $, $$, state, can, get, post, qs, fdt, badge, toast, fail, esc } from '../core.js';

export default async function (view, q) {
  q.f ||= 'unread';
  mount(view, html`<div class="page-head"><div class="grow"><h1>Notifications</h1><p>Alerts about orders, payments, stock, sales targets and customers. Alerts for an ongoing issue (like low stock) appear once and clear themselves when it is fixed.</p></div><button class="btn" id="chk">↻ Check now</button><button class="btn" id="all">Mark all read</button></div>
    <div class="toolbar"><div class="seg" id="seg">${[['unread', 'Unread'], ['all', 'All'], ['critical', 'Critical'], ['warning', 'Warnings']].map(([k, l]) => html`<button data-f="${k}" class="${q.f === k ? 'on' : ''}">${l}</button>`)}</div></div><div class="card flush" id="list"></div>`);
  const load = async () => {
    $$('#seg button', view).forEach((b) => b.classList.toggle('on', b.dataset.f === q.f));
    const r = await get('/api/notifications' + qs({ unread: q.f === 'unread' ? 1 : '', severity: ['critical', 'warning'].includes(q.f) ? q.f : '', limit: 200 })).catch(fail); if (!r) return;
    mount($('#list', view), r.rows.length ? html`${r.rows.map((n) => html`<div class="notif ${n.read_at ? '' : 'unread'}"><span class="dot ${n.severity}" title="${n.severity}"></span><div style="flex:1;min-width:0"><div style="display:flex;gap:8px;flex-wrap:wrap"><b>${n.title}</b>${n.resolved_at ? html`<span class="badge good">resolved</span>` : ''}<span class="muted small">${r.types[n.type] || n.type} · ${fdt(n.created_at)}</span></div>${n.body ? html`<div class="muted">${n.body}</div>` : ''}${n.link ? html`<a href="${n.link}" class="small">Open →</a>` : ''}</div>
      <div class="nowrap">${n.read_at ? '' : html`<button class="btn sm ghost" data-read="${n.id}">Mark read</button>`}<button class="btn sm ghost" data-dis="${n.id}" title="Hide">✕</button></div></div>`)}` : html`<div class="empty"><b>${q.f === 'unread' ? 'You are all caught up 🎉' : 'No notifications'}</b>New alerts will appear here.</div>`);
  };
  $('#seg', view).onclick = (e) => { if (e.target.dataset.f) { q.f = e.target.dataset.f; load(); } };
  $('#chk', view).onclick = async () => { try { await post('/api/notifications/run-checks'); toast('Checks complete', 'success'); load(); window.dispatchEvent(new Event('notifications-changed')); } catch (e) { fail(e); } };
  $('#all', view).onclick = async () => { await post('/api/notifications/read-all'); load(); window.dispatchEvent(new Event('notifications-changed')); };
  view.addEventListener('click', async (e) => { const r = e.target.closest('[data-read]'); const d = e.target.closest('[data-dis]'); if (r) await post(`/api/notifications/${r.dataset.read}/read`); if (d) await post(`/api/notifications/${d.dataset.dis}/dismiss`); if (r || d) { load(); window.dispatchEvent(new Event('notifications-changed')); } });
  await load();
}
