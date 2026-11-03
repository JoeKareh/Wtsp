// CSV import with a dry-run preview and a row-by-row error report. Nothing is written until the user confirms.
import { html, mount, $, post, fail, toast, modal, idemKey } from '../core.js';

export function importDialog(type, onDone) {
  const label = type === 'customers' ? 'customers' : 'products'; let csv = ''; let checked = null;
  const m = modal({ title: type === 'customers' ? 'Import customers' : 'Import products', size: 'lg', body: html`
    <ol class="small" style="padding-inline-start:18px;line-height:1.8"><li><a href="/api/import/template?type=${type}" download>Download the template</a> and fill it in (or use your own file: we recognise English and Arabic column names).</li>
      <li>Save it as <b>CSV</b> (in Excel: File → Save as → CSV).</li><li>Choose the file below and check it – nothing is saved yet.</li></ol>
    <div class="field"><label>Choose a file (CSV)</label><input type="file" id="imp-file" accept=".csv,.txt,text/csv"></div><div id="imp-out"></div>` });
  m.foot.innerHTML = '<button class="btn" data-no type="button">Close</button><button class="btn" data-check type="button" disabled>Check the file</button><button class="btn primary" data-go type="button" disabled>Import now</button>';
  const out = $('#imp-out', m.body); const bCheck = $('[data-check]', m.foot); const bGo = $('[data-go]', m.foot);
  $('[data-no]', m.foot).onclick = () => m.close();
  $('#imp-file', m.body).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 2_000_000) { out.textContent = 'This file is too large (max about 2 MB). Split it into parts.'; return; } csv = await f.text(); bCheck.disabled = false; bGo.disabled = true; out.textContent = ''; };
  const summary = (r, done) => {
    const rows = r.errors.slice(0, 50);
    mount(out, html`<div class="alert ${r.failed ? 'warn' : 'good'}">${done ? 'Imported' : 'Ready to import'}: <b>${r.ok}</b> ${label} OK${r.failed ? html`, <b>${r.failed}</b> need fixing` : ''} (of ${r.total} rows).${r.ignored_columns?.length ? html` Ignored columns: ${r.ignored_columns.join(', ')}.` : ''}</div>
      ${rows.length ? html`<h3>Rows that need fixing</h3><div class="table-wrap" style="max-height:220px;overflow:auto"><table><thead><tr><th>Row</th><th>Name</th><th>Problem</th></tr></thead><tbody>${rows.map((e) => html`<tr><td>${e.row}</td><td>${e.name}</td><td>${e.error}</td></tr>`)}</tbody></table></div>${r.errors.length > 50 ? html`<p class="small muted">Showing the first 50 of ${r.failed}.</p>` : ''}
        <button class="btn sm" id="dl-err" type="button">Download the error report</button> <span class="small muted">Fix those rows in your file and import again – rows already imported are skipped, so nothing is duplicated.</span>` : ''}`);
    $('#dl-err', out)?.addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.error_report_csv], { type: 'text/csv' })); a.download = `${type}-import-errors.csv`; a.click(); URL.revokeObjectURL(a.href); });
  };
  bCheck.onclick = async () => { bCheck.disabled = true; try { checked = await post('/api/import', { type, csv, dry_run: true }); summary(checked, false); bGo.disabled = checked.ok === 0; } catch (e) { out.textContent = ''; fail(e); } finally { bCheck.disabled = false; } };
  bGo.onclick = async () => { bGo.disabled = true; bCheck.disabled = true; try { const r = await post('/api/import', { type, csv }, { 'Idempotency-Key': idemKey() }); summary(r, true); toast(`${r.ok} ${label} imported`, 'success'); onDone?.(r); } catch (e) { fail(e); bGo.disabled = false; bCheck.disabled = false; } };
}
