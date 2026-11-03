import { html, mount, $, get, post, qs, debounce, fail, esc, raw, badge, baseMoney } from './core.js';

/** Customer search by phone/name with inline "create new" fallback. Calls onPick(customerOrNew). */
export function customerPicker(root, { onPick, initial } = {}) {
  root.innerHTML = `<div class="field"><label>Customer * <span class="muted">(search by phone number or name)</span></label>
    <input type="search" id="cp-q" placeholder="e.g. 71 123 456 or Sara" autocomplete="off"><div id="cp-res" class="small" style="margin-top:6px"></div></div><div id="cp-chosen"></div>`;
  const q = $('#cp-q', root); const res = $('#cp-res', root); const chosen = $('#cp-chosen', root);
  const choose = (c) => { chosen.innerHTML = `<div class="alert good" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(c.name)}</b> <span>${esc(c.phone)}</span>${c.outstanding ? `<span class="badge warn">owes ${esc(baseMoney(c.outstanding))}</span>` : ''}<button type="button" class="btn sm ghost" id="cp-change" style="margin-left:auto">Change</button></div>`; q.closest('.field').hidden = true; res.innerHTML = ''; $('#cp-change', chosen).onclick = () => { chosen.innerHTML = ''; q.closest('.field').hidden = false; onPick(null); q.focus(); }; onPick({ id: c.id, name: c.name, phone: c.phone }); };
  const search = debounce(async () => {
    const v = q.value.trim(); if (v.length < 2) { res.innerHTML = ''; return; }
    try {
      const r = await get('/api/customers' + qs({ q: v, limit: 6 }));
      const looksPhone = v.replace(/\D/g, '').length >= 6;
      res.innerHTML = r.rows.map((c, i) => `<button type="button" class="btn sm" data-i="${i}" style="margin:0 6px 6px 0">${esc(c.name)} · ${esc(c.phone)}</button>`).join('') +
        `<button type="button" class="btn sm primary" data-new style="margin-bottom:6px">+ New customer${looksPhone ? ' with this number' : ''}</button>`;
      res.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.new !== undefined) newForm(v, looksPhone); else choose(r.rows[Number(b.dataset.i)]);
      };
    } catch (e) { fail(e); }
  });
  q.addEventListener('input', search);
  function newForm(v, isPhone) {
    res.innerHTML = `<div class="frow"><div class="field"><label>Name *</label><input id="nc-name" value="${isPhone ? '' : esc(v)}" required></div><div class="field"><label>Phone *</label><input id="nc-phone" value="${isPhone ? esc(v) : ''}" inputmode="tel" required></div></div>
      <button type="button" class="btn primary sm" id="nc-save">Save customer</button>`;
    $('#nc-save', res).onclick = async () => {
      try { const c = await post('/api/customers', { name: $('#nc-name', res).value, phone: $('#nc-phone', res).value, status: 'Potential' }); choose(c); }
      catch (e) { if (e.details?.duplicate) { fail(e); const d = e.details.duplicate; choose({ id: d.id, name: d.name, phone: d.phone }); } else fail(e); }
    };
  }
  if (initial) choose(initial);
}
