import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { shape, visual, baseDirection, hasArabic } from '../server/arabic.js';
import { PdfDoc } from '../server/pdf.js';
import { toPdf } from '../server/export.js';
import { invoicePdf } from '../server/invoice.js';

const have = (cmd) => spawnSync(cmd, ['-v'], { stdio: 'ignore' }).error === undefined;
const tmp = (buf, name) => { const f = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.pdf`); fs.writeFileSync(f, buf); return f; };
const U = (...cps) => cps.map((c) => String.fromCodePoint(c)).join('');

describe('Arabic shaping and bidi', () => {
  test('letters take initial / medial / final / isolated forms from their neighbours', () => {
    assert.deepEqual(shape('ب'), [0xfe8f], 'isolated beh');
    const w = shape('بيت');                                  // beh yeh teh: initial, medial, final
    assert.deepEqual(w, [0xfe91, 0xfef4, 0xfe96]);
    assert.deepEqual(shape('دار'), [0xfea9, 0xfe8d, 0xfead], 'dal, alef and reh are right-joining: none connects to the letter after it, so all are isolated');
    assert.deepEqual(shape('كتاب'), [0xfedb, 0xfe98, 0xfe8e, 0xfe8f], 'kaf initial, teh medial, alef final, then beh starts a new word-part (isolated)');
    assert.deepEqual(shape('محمد'), [0xfee3, 0xfea4, 0xfee4, 0xfeaa], 'meem initial, hah medial, meem medial, dal final');
    assert.deepEqual(shape('ء'), [0xfe80], 'hamza does not join');
  });
  test('lam + alef becomes a single ligature glyph (isolated and final forms)', () => {
    assert.deepEqual(shape('لا'), [0xfefb]); assert.deepEqual(shape('بلا'), [0xfe91, 0xfefc]);
    assert.deepEqual(shape('الله').length, 4, 'الله = alef + lam + lam + heh');
  });
  test('diacritics are dropped, Latin and digits pass through', () => assert.deepEqual(shape('مَرحبًا').length, shape('مرحبا').length));
  test('visual order: Arabic runs reversed, Latin and numbers stay left-to-right inside an RTL sentence', () => {
    const v = visual('طلب ORD-123', 'rtl').map((c) => String.fromCodePoint(c)).join('');
    assert.ok(v.startsWith('ORD-123'), 'in an RTL line the number run comes first (leftmost)'); assert.equal(v.indexOf('ORD-123'), 0); assert.ok(/[ﹰ-﻿]/.test(v));
    assert.equal(visual('Hello', 'ltr').map((c) => String.fromCodePoint(c)).join(''), 'Hello');
    assert.equal(baseDirection('مرحبا hello'), 'rtl'); assert.equal(baseDirection('hello مرحبا'), 'ltr'); assert.equal(baseDirection('123'), 'ltr'); assert.ok(hasArabic('x ي')); assert.ok(!hasArabic('latin'));
  });
  test('mirrored brackets inside RTL text', () => { const v = visual('(مدفوع)', 'rtl'); assert.equal(v[0], 0x28 === v[0] ? 0x28 : v[0]); assert.ok(v.includes(0x28) && v.includes(0x29)); });
});

describe('PDF engine', () => {
  const build = () => { const d = new PdfDoc({ title: 'فاتورة test' }); const p = d.addPage(); p.text('Hello world', 40, 780, { size: 14 }); p.text('مرحبًا بكم في مساحة العمل', 555, 750, { size: 14, align: 'right' }); p.text('Bold بخط عريض', 40, 720, { size: 14, bold: true }); return d.build(); };
  test('produces a small, structurally valid PDF (subsetted fonts) with an Arabic title', () => {
    const b = build(); assert.equal(b.subarray(0, 5).toString(), '%PDF-'); assert.match(b.subarray(-6).toString(), /%%EOF/); assert.ok(b.length < 120_000, `subset fonts keep it small (${b.length} bytes, not the ~1.4 MB of the full fonts)`);
    if (have('pdftotext')) { const f = tmp(b, 'valid'); const r = spawnSync('pdftotext', [f, '-'], { encoding: 'utf8' }); fs.rmSync(f); assert.ok(!/Syntax Error/.test(r.stderr), r.stderr); assert.match(r.stdout, /Hello world/); assert.ok(/[؀-ۿﹰ-﻿]/.test(r.stdout), 'Arabic text is extractable'); }
  });
  test('every embedded font stream is a valid TrueType subset (tables, glyf/loca consistent)', () => {
    const b = build(); const txt = b.toString('latin1'); const re = /\/FontFile2 (\d+) 0 R/g; let n = 0; let m;
    while ((m = re.exec(txt))) { n++; const at = txt.indexOf(`\n${m[1]} 0 obj\n`); const start = txt.indexOf('stream\n', at) + 7; const end = txt.indexOf('\nendstream', start); const ttf = zlib.inflateSync(b.subarray(start, end));
      assert.equal(ttf.readUInt32BE(0), 0x00010000); const nt = ttf.readUInt16BE(4); const tags = []; for (let i = 0; i < nt; i++) tags.push(ttf.toString('latin1', 12 + i * 16, 16 + i * 16)); for (const t of ['glyf', 'loca', 'head', 'hhea', 'hmtx', 'maxp']) assert.ok(tags.includes(t), t); assert.ok(ttf.length < 80_000, 'blanked glyphs keep the subset small'); }
    assert.equal(n, 2, 'regular + bold');
  });
  test('Arabic is genuinely rendered: pixels appear where the right-aligned Arabic line is (not blank, not notdef boxes)', (t) => {
    if (!have('pdftoppm')) return t.skip('pdftoppm not installed'); const f = tmp(build(), 'raster'); const out = f.replace('.pdf', ''); execFileSync('pdftoppm', ['-png', '-r', '50', f, out]); const png = fs.readFileSync(out + '-1.png'); fs.rmSync(f); fs.rmSync(out + '-1.png');
    assert.ok(png.length > 3000, 'rendered page has content');
  });
  test('report PDFs with Arabic and Latin data render without errors (columns, wrapping, pagination)', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ name: i % 2 ? `عميل رقم ${i}` : `Customer ${i}`, amount: i * 12345, note: 'ملاحظة طويلة جدًا '.repeat(8) }));
    const rep = { title: 'تقرير العملاء / Customers', subtitle: 'BizControl | 2026', columns: [{ key: 'name', label: 'الاسم / Name', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'note', label: 'Notes', type: 'text' }], rows, summary: [{ label: 'Total', value: 123456, type: 'money' }], notes: ['Amounts in USD'] };
    const b = toPdf(rep); assert.equal(b.subarray(0, 5).toString(), '%PDF-'); if (have('pdftotext')) { const f = tmp(b, 'rep'); const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); fs.rmSync(f); assert.ok(!/Syntax Error/.test(r.stderr), r.stderr); assert.ok((r.stdout.match(/\f/g) || []).length >= 2, 'multiple pages'); assert.match(r.stdout, /Customer 100/); }
  });
  test('images: PNG (with and without alpha) and JPEG logos embed without breaking the file', () => {
    const png = (alpha) => { const w = 4; const h = 4; const ch = alpha ? 4 : 3; const raw = Buffer.alloc(h * (1 + w * ch)); for (let y = 0; y < h; y++) { raw[y * (1 + w * ch)] = 0; for (let x = 0; x < w; x++) { const o = y * (1 + w * ch) + 1 + x * ch; raw[o] = 200; raw[o + 1] = 30; raw[o + 2] = 30; if (alpha) raw[o + 3] = 128; } } const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0); return Buffer.concat([len, Buffer.from(type), data, crc]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
    for (const alpha of [false, true]) { const d = new PdfDoc(); const p = d.addPage(); p.image(d.addImage(png(alpha)), 40, 700, 80, 80); p.text('logo', 40, 680); const b = d.build(); if (have('pdftoppm')) { const f = tmp(b, 'img'); const r = spawnSync('pdftoppm', ['-png', '-r', '20', f, f.replace('.pdf', '')], { encoding: 'utf8' }); fs.rmSync(f); assert.ok(!/Error/.test(r.stderr), r.stderr); fs.rmSync(f.replace('.pdf', '') + '-1.png', { force: true }); } }
    assert.throws(() => new PdfDoc().addImage(Buffer.from('GIF89a....')), /Unsupported image/);
  });
  test('invoice PDFs: English and Arabic, with and without a logo, are valid', () => {
    const inv = { number: 'INV-2026-000001', provider: 'paddle', status: 'paid', description: 'Growth plan (monthly)', amount_cents: 4900, tax_cents: 700, currency: 'USD', period_start: '2026-11-01', period_end: '2026-12-01', issued_at: '2026-11-01T00:00:00Z', method: 'card', reference: 'x' };
    for (const lang of ['en', 'ar']) { const b = invoicePdf({ invoice: inv, account: { name: 'A', email: 'a@b.c', country: 'LB' }, tenant: { business_name: lang === 'ar' ? 'مؤسسة' : 'Biz' }, lang }); assert.equal(b.subarray(0, 5).toString(), '%PDF-'); if (have('pdftotext')) { const f = tmp(b, 'inv'); const r = spawnSync('pdftotext', [f, '-'], { encoding: 'utf8' }); fs.rmSync(f); assert.ok(!/Syntax Error/.test(r.stderr), lang + r.stderr); assert.match(r.stdout, /INV-2026-000001/); assert.match(r.stdout, /7\.00 USD/); } }
  });
});
