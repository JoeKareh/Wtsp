// WhatsApp setup. Click-to-chat needs nothing. The official API (automatic + bulk messages) needs the customer's own Meta credentials.
import { html, mount, $, $$, get, post, put, del, fail, toast, confirmDialog } from '../core.js';

export default async function (view) {
  let S;
  const copy = (txt) => navigator.clipboard.writeText(txt).then(() => toast('Copied', 'success'), () => toast('Select and copy it manually', 'error'));
  const shot = (txt) => html`<div class="shot">📷 ${txt}</div>`;
  const draw = () => {
    const st = S.status; const c = S.credentials;
    mount(view, html`<div class="page-head"><div class="grow"><h1>WhatsApp setup</h1><p>Two ways to use WhatsApp. Start with the first – it works right now.</p></div></div>
      <div class="card"><h2>1. Message customers in one tap <span class="badge good">works on every plan</span></h2><p class="muted">Use the <b>💬 Chat on WhatsApp</b> button on a customer, order, receivable or supplier. WhatsApp opens with a ready message you can edit, and you press send. No setup, no approval.</p></div>
      <div class="card"><h2>2. Automatic & bulk messages (official WhatsApp API) <span class="badge ${st.connection === 'connected' ? 'good' : st.connection === 'failed' ? 'bad' : ''}">${st.connection === 'connected' ? 'Connected' : st.connection === 'failed' ? 'Connection problem' : st.connection === 'untested' ? 'Saved – not tested' : 'Not connected'}</span></h2>
        <p class="muted">Needs your own <b>Meta Business</b> account and a phone number approved for the WhatsApp Business Platform. This is optional and available on the Growth and Business plans.</p>
        <details><summary><b>Step by step – where to find each value</b></summary><ol class="small" style="line-height:1.9">
          <li>Go to <b>developers.facebook.com</b> → My Apps → create an app of type <b>Business</b> → add the <b>WhatsApp</b> product.</li>
          <li>Open <b>WhatsApp → API Setup</b>. Copy the <b>Phone number ID</b> and the <b>WhatsApp Business Account ID</b>.${shot('Screenshot: Meta → WhatsApp → API Setup (add yours here)')}</li>
          <li>Create a permanent <b>access token</b> (Business Settings → System users → generate token with <i>whatsapp_business_messaging</i> and <i>whatsapp_business_management</i>).${shot('Screenshot: System user token (add yours here)')}</li>
          <li>Open <b>App settings → Basic</b> and copy the <b>App secret</b>.</li>
          <li>Open <b>WhatsApp → Configuration → Webhook</b>, paste the <b>Callback URL</b> and <b>Verify token</b> from below, press Verify, and subscribe to <b>messages</b>.${shot('Screenshot: Webhook configuration (add yours here)')}</li></ol></details>
        <h3>Your webhook (paste these into Meta)</h3>
        <div class="field"><label>Callback URL</label><div style="display:flex;gap:6px"><input readonly value="${S.webhook_url}" data-select style="flex:1" dir="ltr"><button class="btn" data-copy="${S.webhook_url}">Copy</button></div></div>
        <div class="field"><label>Verify token</label><div style="display:flex;gap:6px"><input readonly value="${S.verify_token}" data-select style="flex:1" dir="ltr"><button class="btn" data-copy="${S.verify_token}">Copy</button></div></div>
        <h3>Your credentials</h3>
        <form id="cf"><div class="frow"><div class="field"><label>Phone number ID</label><input name="phone_number_id" inputmode="numeric" value="${c.wa_phone_number_id || ''}" dir="ltr"></div><div class="field"><label>Business account ID</label><input name="waba_id" inputmode="numeric" value="${c.wa_waba_id || ''}" dir="ltr"></div></div>
          <div class="frow"><div class="field"><label>Access token</label><input name="token" type="password" autocomplete="off" placeholder="${c.wa_token ? '•••••••• saved – leave empty to keep' : ''}" dir="ltr"></div><div class="field"><label>App secret</label><input name="app_secret" type="password" autocomplete="off" placeholder="${c.wa_app_secret ? '•••••••• saved – leave empty to keep' : ''}" dir="ltr"></div></div>
          <div class="field check"><input type="checkbox" id="biz" ${st.is_on_biz_app ? 'checked' : ''}><label for="biz">This number is also used in the WhatsApp Business app on my phone</label></div>
          <div class="toolbar"><button class="btn primary">Save credentials</button>${c.wa_token ? html`<button class="btn danger" type="button" id="rm">Remove</button>` : ''}</div></form>
        ${st.missing.length ? html`<p class="small muted">Still missing: ${st.missing.join(', ')}.</p>` : ''}
        ${st.can_send ? html`<h3>Test it</h3><div class="toolbar"><input id="to" placeholder="Your phone number" inputmode="tel" dir="ltr" style="max-width:220px"><button class="btn" id="tm">Send me a test message</button><button class="btn" id="ck">Check connection</button></div>
          <p class="small muted">${st.last_test ? (st.last_test.ok ? '✅ Last check passed.' : '⚠ Last check failed: ' + (st.last_test.error || '')) : ''}</p>` : ''}</div>`);
    $$('[data-copy]', view).forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
    $('#cf', view).addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target; const body = {}; for (const k of ['phone_number_id', 'waba_id', 'token', 'app_secret']) if (f[k].value.trim()) body[k] = f[k].value.trim(); try { if (Object.keys(body).length) await put('/api/whatsapp/credentials', body); await put('/api/whatsapp/number-state', { is_on_biz_app: $('#biz', view).checked }); toast('Saved', 'success'); await load(); } catch (er) { fail(er); } });
    $('#rm', view)?.addEventListener('click', async () => { if (await confirmDialog({ title: 'Remove WhatsApp credentials?', message: 'Automatic and bulk messages stop. One-tap chat keeps working.', danger: true, confirmText: 'Remove' })) { await del('/api/whatsapp/credentials').catch(fail); load(); } });
    $('#tm', view)?.addEventListener('click', async () => { try { const r = await post('/api/whatsapp/test-message', { to: $('#to', view).value }); toast('Sent. ' + r.note); } catch (er) { fail(er); } });
    $('#ck', view)?.addEventListener('click', async () => { try { await post('/api/whatsapp/test'); toast('Connection works', 'success'); } catch (er) { fail(er); } load(); });
  };
  const load = async () => { S = await get('/api/whatsapp/setup'); draw(); };
  await load();
}
