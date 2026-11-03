// RFC 4180 CSV parsing (quotes, escaped quotes, CRLF, BOM, auto-detected , ; or tab delimiter) and header alias mapping (English + Arabic).
export function parseCsv(text) {
  let s = String(text || '').replace(/^﻿/, ''); if (!s.trim()) return [];
  const first = s.split(/\r?\n/, 1)[0]; const delim = [[',', 0], [';', 0], ['\t', 0]].map(([d]) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
const norm = (h) => String(h).trim().toLowerCase().replace(/[\s_\-]+/g, ' ');
/** Map CSV rows (first row = headers) to objects using alias lists. Returns { records:[{rowNumber, ...fields}], unknown:[headers] }. */
export function mapRows(rows, aliases) {
  if (!rows.length) return { records: [], unknown: [], missing: Object.keys(aliases) };
  const head = rows[0].map(norm); const idx = {}; const used = new Set();
  for (const [field, names] of Object.entries(aliases)) { const i = head.findIndex((h) => names.map(norm).includes(h)); if (i >= 0) { idx[field] = i; used.add(i); } }
  const records = rows.slice(1).map((r, k) => { const o = { rowNumber: k + 2 }; for (const [f, i] of Object.entries(idx)) o[f] = (r[i] ?? '').trim(); return o; });
  return { records, unknown: rows[0].filter((_, i) => !used.has(i)), missing: Object.keys(aliases).filter((f) => !(f in idx)) };
}
const AR_DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
/** "$1,250.50" / "١٢٣٫٥" / "12,5" -> number (or null). */
export function parseNumber(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  let s = String(v).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]).replace(/٫/g, '.').replace(/٬/g, ',').replace(/[^\d.,\-]/g, '');
  if (/,\d{1,2}$/.test(s) && !/\./.test(s)) s = s.replace(',', '.'); else s = s.replace(/,/g, '');
  if (!/\d/.test(s)) return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
export const toCsvText = (rows, headers) => '﻿' + [headers, ...rows.map((r) => headers.map((h) => r[h]))].map((l) => l.map((x) => { let v = String(x ?? ''); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\r\n') + '\r\n';
