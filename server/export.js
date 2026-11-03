// Dependency-free CSV, XLSX (OOXML + zip) and PDF writers.
import zlib from 'node:zlib';

/**
 * report = { title, subtitle, columns:[{key,label,type}], rows:[{...}], summary:[{label,value,type}], notes:[string] }
 * Money values are integer minor units; exporters convert them to major units.
 */
const major = (v) => (v == null ? null : v / 100);
const cell = (col, v) => {
  if (v == null || v === '') return '';
  switch (col.type) {
    case 'money': return (v / 100).toFixed(2);
    case 'pct': return Number(v).toFixed(1) + '%';
    case 'number': return String(Math.round(v * 1000) / 1000);
    default: return String(v);
  }
};

export function toCsv(rep) {
  const esc = (s) => { s = String(s ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [[rep.title], [rep.subtitle], [], rep.columns.map((c) => c.label), ...rep.rows.map((r) => rep.columns.map((c) => cell(c, r[c.key])))];
  if (rep.summary?.length) { lines.push([]); for (const s of rep.summary) lines.push([s.label, cell({ type: s.type }, s.value)]); }
  for (const n of rep.notes || []) lines.push([n]);
  return '﻿' + lines.map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
}

// ---------------- XLSX ----------------
const xml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function zip(files) {
  const parts = []; const central = []; let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name); const raw = Buffer.from(data); const comp = zlib.deflateRawSync(raw); const crc = zlib.crc32(raw) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, nameBuf, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += h.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export function toXlsx(rep) {
  // style ids: 0 normal, 1 header, 2 money, 3 integer, 4 percent, 5 title, 6 bold
  const rows = [];
  const S = (r, c, v, s = 0) => (v === '' || v == null ? '' : typeof v === 'number' ? `<c r="${colName(c)}${r}" s="${s}"><v>${v}</v></c>` : `<c r="${colName(c)}${r}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
  let r = 1;
  rows.push(`<row r="${r}">${S(r, 0, rep.title, 5)}</row>`); r++;
  rows.push(`<row r="${r}">${S(r, 0, rep.subtitle)}</row>`); r += 2;
  rows.push(`<row r="${r}">${rep.columns.map((c, i) => S(r, i, c.label, 1)).join('')}</row>`); const hdr = r; r++;
  for (const row of rep.rows) {
    rows.push(`<row r="${r}">${rep.columns.map((c, i) => {
      const v = row[c.key];
      if (v == null || v === '') return '';
      if (c.type === 'money') return S(r, i, major(v), 2);
      if (c.type === 'int') return S(r, i, Number(v), 3);
      if (c.type === 'pct') return S(r, i, Number(v) / 100, 4);
      if (c.type === 'number') return S(r, i, Number(v), 0);
      return S(r, i, String(v));
    }).join('')}</row>`); r++;
  }
  if (rep.summary?.length) {
    r++;
    for (const s of rep.summary) { rows.push(`<row r="${r}">${S(r, 0, s.label, 6)}${s.type === 'money' ? S(r, 1, major(s.value), 2) : s.type === 'pct' ? S(r, 1, Number(s.value) / 100, 4) : typeof s.value === 'number' ? S(r, 1, s.value, s.type === 'int' ? 3 : 0) : S(r, 1, s.value)}</row>`); r++; }
  }
  for (const n of rep.notes || []) { r++; rows.push(`<row r="${r}">${S(r, 0, n)}</row>`); }
  const widths = rep.columns.map((c) => Math.min(48, Math.max(c.label.length + 2, ...rep.rows.slice(0, 200).map((x) => String(x[c.key] ?? '').length + 2), 10)));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${hdr}" topLeftCell="A${hdr + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`;
  const name = xml(rep.title.slice(0, 31).replace(/[\[\]*?:\/\\]/g, ' '));
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

// ---------------- PDF ----------------
const win = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, (c) => '\\' + c);
export function toPdf(rep) {
  const W = 842; const H = 595; const M = 30; const FS = 8; const LH = 12;
  const cw = (t) => FS * 0.52 * t; // approx. char width
  const textCols = rep.columns.map((c) => Math.min(40, Math.max(c.label.length, ...rep.rows.slice(0, 100).map((r) => cell(c, r[c.key]).length), 6)));
  const total = textCols.reduce((a, b) => a + b, 0);
  const avail = W - 2 * M; const scale = Math.min(1, avail / (cw(total) + rep.columns.length * 8));
  const widths = textCols.map((n) => cw(n) * scale + 8 * scale); // pt
  const xs = []; let x = M; for (const w of widths) { xs.push(x); x += w; }
  const fit = (s, w) => { const max = Math.max(1, Math.floor((w - 4) / (FS * 0.52))); s = String(s); return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '.' : s; };
  const pages = []; let ops = []; let y = H - M;
  const text = (t, px, py, bold = false, size = FS) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${px.toFixed(1)} ${py.toFixed(1)} Td (${win(t)}) Tj ET`);
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = H - M; };
  const header = () => {
    ops.push('0.12 0.23 0.37 rg'); ops.push(`${M} ${y - 3} ${avail} ${LH + 2} re f`); ops.push('1 1 1 rg');
    rep.columns.forEach((c, i) => text(fit(c.label, widths[i]), xs[i] + 2, y, true));
    ops.push('0 0 0 rg'); y -= LH + 4;
  };
  text(rep.title, M, y, true, 14); y -= 18; text(rep.subtitle, M, y, false, 9); y -= 16; header();
  let n = 0;
  for (const row of rep.rows) {
    if (y < M + 20) { newPage(); header(); }
    if (n++ % 2) { ops.push('0.95 0.96 0.98 rg'); ops.push(`${M} ${y - 3} ${avail} ${LH} re f`); ops.push('0 0 0 rg'); }
    rep.columns.forEach((c, i) => {
      const v = cell(c, row[c.key]); const right = ['money', 'int', 'pct', 'number'].includes(c.type);
      const t = fit(v, widths[i]); text(t, right ? xs[i] + widths[i] - 4 - t.length * FS * 0.52 : xs[i] + 2, y);
    });
    y -= LH;
  }
  if (!rep.rows.length) { text('No data for the selected period.', M, y); y -= LH; }
  if (rep.summary?.length) {
    y -= 8; for (const s of rep.summary) { if (y < M + 20) { newPage(); } text(s.label, M, y, true); text(cell({ type: s.type }, s.value), M + 220, y); y -= LH; }
  }
  for (const nt of rep.notes || []) { if (y < M + 20) newPage(); text(nt, M, y - 4, false, 7); y -= 10; }
  pages.push(ops);
  const objs = []; // 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs
  const add = (s) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('PLACEHOLDER'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((p, i) => {
    const foot = `BT /F1 7 Tf ${W - M - 60} 14 Td (Page ${i + 1} of ${pages.length}) Tj ET`;
    const stream = [...p, foot].join('\n');
    const cid = objs.length + 2;
    const pid = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`);
    add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(`${pid} 0 R`);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  const out = [Buffer.from('%PDF-1.4\n')]; const offs = []; let pos = out[0].length;
  objs.forEach((o, i) => { offs.push(pos); const b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'); out.push(b); pos += b.length; });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`; for (const o of offs) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  out.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(out);
}
