// Minimal PDF engine with embedded, subsetted TrueType fonts (Latin + Arabic with shaping and RTL), JPEG/PNG images. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { visual, baseDirection } from './arabic.js';

const FONT_DIR = path.join(import.meta.dirname, 'fonts');
class TTF {
  constructor(buf) {
    this.buf = buf; const n = buf.readUInt16BE(4); this.tables = {};
    for (let i = 0; i < n; i++) { const o = 12 + i * 16; this.tables[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) }; }
    const head = this.tables.head.off; this.upem = buf.readUInt16BE(head + 18); this.locFmt = buf.readInt16BE(head + 50);
    this.numGlyphs = buf.readUInt16BE(this.tables.maxp.off + 4); this.nHM = buf.readUInt16BE(this.tables.hhea.off + 34);
    this.ascent = buf.readInt16BE(this.tables.hhea.off + 4); this.descent = buf.readInt16BE(this.tables.hhea.off + 6);
    this.cmap = this.readCmap(); this.cache = new Map();
  }
  readCmap() {
    const b = this.buf; const c = this.tables.cmap.off; const n = b.readUInt16BE(c + 2); let best = null;
    for (let i = 0; i < n; i++) { const pid = b.readUInt16BE(c + 4 + i * 8); const eid = b.readUInt16BE(c + 6 + i * 8); const off = c + b.readUInt32BE(c + 8 + i * 8); const fmt = b.readUInt16BE(off); if ((pid === 3 && eid === 10 && fmt === 12) || (!best && ((pid === 3 && eid === 1) || pid === 0) && (fmt === 4 || fmt === 12))) best = { off, fmt }; }
    return best;
  }
  gid(cp) {
    if (this.cache.has(cp)) return this.cache.get(cp); const b = this.buf; const { off, fmt } = this.cmap; let g = 0;
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(off + 6); const endO = off + 14; const startO = endO + segX2 + 2; const deltaO = startO + segX2; const rangeO = deltaO + segX2;
      for (let i = 0; i < segX2; i += 2) { const end = b.readUInt16BE(endO + i); if (cp > end) continue; const start = b.readUInt16BE(startO + i); if (cp < start) break; const ro = b.readUInt16BE(rangeO + i); const delta = b.readInt16BE(deltaO + i); if (ro === 0) g = (cp + delta) & 0xffff; else { const gi = b.readUInt16BE(rangeO + i + ro + (cp - start) * 2); g = gi ? (gi + delta) & 0xffff : 0; } break; }
    } else { const ng = b.readUInt32BE(off + 12); for (let i = 0; i < ng; i++) { const o = off + 16 + i * 12; const s = b.readUInt32BE(o); const e = b.readUInt32BE(o + 4); if (cp >= s && cp <= e) { g = b.readUInt32BE(o + 8) + (cp - s); break; } } }
    this.cache.set(cp, g); return g;
  }
  adv(g) { const h = this.tables.hmtx.off; return this.buf.readUInt16BE(h + 4 * Math.min(g, this.nHM - 1)); }
  loc(g) { const l = this.tables.loca.off; return this.locFmt ? this.buf.readUInt32BE(l + g * 4) : this.buf.readUInt16BE(l + g * 2) * 2; }
  glyphData(g) { const g0 = this.tables.glyf.off + this.loc(g); const g1 = this.tables.glyf.off + this.loc(g + 1); return this.buf.subarray(g0, g1); }
  components(g) { const d = this.glyphData(g); if (d.length < 10 || d.readInt16BE(0) >= 0) return []; const out = []; let o = 10; for (;;) { const fl = d.readUInt16BE(o); out.push(d.readUInt16BE(o + 2)); o += 4 + (fl & 1 ? 4 : 2); if (fl & 8) o += 2; else if (fl & 0x40) o += 4; else if (fl & 0x80) o += 8; if (!(fl & 0x20)) break; } return out; }
  /** Subset by blanking unused glyphs: glyph ids are unchanged, so Identity-H encoding keeps working. */
  subset(used) {
    const keep = new Set([0, ...used]); const todo = [...keep];
    while (todo.length) for (const c of this.components(todo.pop())) if (!keep.has(c)) { keep.add(c); todo.push(c); }   // composite glyphs (dots, hamza) can be nested: follow them all the way down
    const parts = []; const loca = Buffer.alloc((this.numGlyphs + 1) * 4); let pos = 0;
    for (let g = 0; g < this.numGlyphs; g++) { loca.writeUInt32BE(pos, g * 4); if (keep.has(g)) { const d = this.glyphData(g); parts.push(d); pos += d.length; const pad = (4 - (pos % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); pos += pad; } } }
    loca.writeUInt32BE(pos, this.numGlyphs * 4); const glyf = Buffer.concat(parts);
    const copy = (t) => (this.tables[t] ? this.buf.subarray(this.tables[t].off, this.tables[t].off + this.tables[t].len) : null);
    const head = Buffer.from(copy('head')); head.writeInt16BE(1, 50); head.writeUInt32BE(0, 8);
    const out = { glyf, loca, head, hhea: copy('hhea'), maxp: copy('maxp'), hmtx: copy('hmtx'), cvt: copy('cvt '), fpgm: copy('fpgm'), prep: copy('prep') };
    const tags = Object.entries({ 'cvt ': out.cvt, fpgm: out.fpgm, glyf: out.glyf, head: out.head, hhea: out.hhea, hmtx: out.hmtx, loca: out.loca, maxp: out.maxp, prep: out.prep }).filter(([, v]) => v).sort(([a], [b]) => (a < b ? -1 : 1));
    const nt = tags.length; let off = 12 + nt * 16; const dir = Buffer.alloc(off); dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(nt, 4); const sr = 2 ** Math.floor(Math.log2(nt)) * 16; dir.writeUInt16BE(sr, 6); dir.writeUInt16BE(Math.floor(Math.log2(nt)), 8); dir.writeUInt16BE(nt * 16 - sr, 10);
    const bodies = [];
    tags.forEach(([tag, data], i) => { const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]); let sum = 0; for (let k = 0; k < padded.length; k += 4) sum = (sum + padded.readUInt32BE(k)) >>> 0; const o = 12 + i * 16; dir.write(tag, o, 'latin1'); dir.writeUInt32BE(sum, o + 4); dir.writeUInt32BE(off, o + 8); dir.writeUInt32BE(data.length, o + 12); bodies.push(padded); off += padded.length; });
    return Buffer.concat([dir, ...bodies]);
  }
}
const fonts = {};
const loadFont = (name) => (fonts[name] ||= new TTF(fs.readFileSync(path.join(FONT_DIR, name === 'bold' ? 'DejaVuSans-Bold.ttf' : 'DejaVuSans.ttf'))));
const hex4 = (n) => n.toString(16).padStart(4, '0');
// PDF text strings: plain ASCII as a literal, anything else as UTF-16BE hex with a BOM (the spec's way to carry Unicode, e.g. an Arabic document title)
const pdfStr = (s) => (/^[\x20-\x7e]*$/.test(String(s)) ? '(' + String(s).replace(/[\\()]/g, '\\$&') + ')' : '<FEFF' + Buffer.from(String(s), 'utf16le').swap16().toString('hex') + '>');
const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => { if (!c) return '0 0 0'; const m = /^#?([0-9a-f]{6})$/i.exec(c); if (!m) return '0 0 0'; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => num(x / 255)).join(' '); };

export class PdfDoc {
  constructor({ size = [595.28, 841.89], title = '' } = {}) { this.size = size; this.pages = []; this.used = { regular: new Map(), bold: new Map() }; this.images = []; this.title = title; }
  addPage() { const p = new PdfPage(this); this.pages.push(p); return p; }
  /** Encode text for a font: returns { hex, width } and records glyph usage. */
  encode(str, bold, size, dir = 'auto') {
    const f = loadFont(bold ? 'bold' : 'regular'); const used = this.used[bold ? 'bold' : 'regular']; let hex = ''; let w = 0;
    for (const cp of visual(str, dir)) { const g = f.gid(cp) || f.gid(0xfffd) || 0; used.set(g, cp); hex += hex4(g); w += f.adv(g); }
    return { hex, width: (w * size) / f.upem };
  }
  measure(str, size = 10, bold = false) { return this.encode(str, bold, size).width; }
  /** Embed a JPEG or PNG (Buffer or data URL). Returns an image handle for page.image(). */
  addImage(src) {
    const buf = Buffer.isBuffer(src) ? src : Buffer.from(String(src).split(',')[1] || '', 'base64'); let img;
    if (buf[0] === 0xff && buf[1] === 0xd8) {                                                   // JPEG: embed as is
      let o = 2; let w = 0; let h = 0; let comps = 3; while (o < buf.length) { if (buf[o] !== 0xff) { o++; continue; } const m = buf[o + 1]; const len = buf.readUInt16BE(o + 2); if (m >= 0xc0 && m <= 0xc3) { h = buf.readUInt16BE(o + 5); w = buf.readUInt16BE(o + 7); comps = buf[o + 9]; break; } o += 2 + len; }
      img = { w, h, dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`, data: buf };
    } else if (buf.toString('latin1', 1, 4) === 'PNG') {
      const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20); const depth = buf[24]; const ct = buf[25]; const interlace = buf[28]; if (depth !== 8 || interlace) throw new Error('Only 8-bit non-interlaced PNG logos are supported');
      const idat = []; let plte = null; for (let o = 8; o < buf.length;) { const len = buf.readUInt32BE(o); const type = buf.toString('latin1', o + 4, o + 8); if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len)); if (type === 'PLTE') plte = buf.subarray(o + 8, o + 8 + len); o += 12 + len; }
      const raw = zlib.inflateSync(Buffer.concat(idat)); const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct]; const bpp = ch; const stride = w * ch; const px = Buffer.alloc(h * stride); let prev = Buffer.alloc(stride);
      for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))); for (let x = 0; x < stride; x++) { const a = x >= bpp ? line[x - bpp] : 0; const b = prev[x]; const c = x >= bpp ? prev[x - bpp] : 0; let v = line[x]; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } line[x] = v & 255; } line.copy(px, y * stride); prev = line; }
      if (ct === 4 || ct === 6) { const cc = ct === 6 ? 3 : 1; const color = Buffer.alloc(w * h * cc); const alpha = Buffer.alloc(w * h); for (let i = 0; i < w * h; i++) { for (let k = 0; k < cc; k++) color[i * cc + k] = px[i * ch + k]; alpha[i] = px[i * ch + cc]; } img = { w, h, dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${cc === 3 ? 'DeviceRGB' : 'DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(color), smask: { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(alpha) } }; }
      else img = { w, h, dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${ct === 3 ? `[/Indexed /DeviceRGB ${plte.length / 3 - 1} <${plte.toString('hex')}>]` : ct === 0 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(px) };
    } else throw new Error('Unsupported image format (use PNG or JPEG)');
    img.name = 'Im' + (this.images.length + 1); this.images.push(img); return img;
  }
  build() {
    const objs = []; const add = (s) => { objs.push(s); return objs.length; }; const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
    add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); // 2 = pages, filled below
    const fontIds = {};
    for (const key of ['regular', 'bold']) {
      const used = this.used[key]; if (!used.size && key === 'bold' && !this.pages.length) continue; const f = loadFont(key); const sub = zlib.deflateSync(f.subset([...used.keys()]));
      const ff = add(stream(`/Filter /FlateDecode /Length1 ${sub.length}`, sub)); const name = key === 'bold' ? 'DejaVuSans-Bold' : 'DejaVuSans';
      const fd = add(`<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [-1000 -300 2500 1100] /ItalicAngle 0 /Ascent ${Math.round((f.ascent * 1000) / f.upem)} /Descent ${Math.round((f.descent * 1000) / f.upem)} /CapHeight 729 /StemV 80 /FontFile2 ${ff} 0 R >>`);
      const W = [...used.keys()].sort((a, b) => a - b).map((g) => `${g} [${Math.round((f.adv(g) * 1000) / f.upem)}]`).join(' ');
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fd} 0 R /CIDToGIDMap /Identity /DW 600 /W [${W}] >>`);
      const bf = [...used.entries()].map(([g, cp]) => `<${hex4(g)}> <${(cp > 0xffff ? '' : hex4(cp))}>`).filter((x) => !x.endsWith('<>')).join('\n');
      const tu = Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${used.size} beginbfchar\n${bf}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`, 'latin1');
      const tuId = add(stream('', tu)); fontIds[key] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tuId} 0 R >>`);
    }
    const imgIds = this.images.map((im) => { const sm = im.smask ? add(stream(im.smask.dict, im.smask.data)) : null; return add(stream(im.dict + (sm ? ` /SMask ${sm} 0 R` : ''), im.data)); });
    const pageIds = [];
    for (const p of this.pages) {
      const content = add(stream('/Filter /FlateDecode', zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'))));
      const res = `<< /Font << ${Object.entries(fontIds).map(([k, id]) => `/F${k === 'bold' ? 2 : 1} ${id} 0 R`).join(' ')} >> /XObject << ${this.images.map((im, i) => `/${im.name} ${imgIds[i]} 0 R`).join(' ')} >> >>`;
      pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.size[0])} ${num(this.size[1])}] /Resources ${res} /Contents ${content} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const info = add(`<< /Title ${pdfStr(this.title)} /Producer (BizControl) >>`);
    const out = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offs = []; let pos = out[0].length;
    objs.forEach((o, i) => { offs.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]); out.push(b); pos += b.length; });
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`; for (const o of offs) xref += String(o).padStart(10, '0') + ' 00000 n \n';
    out.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(out);
  }
}
class PdfPage {
  constructor(doc) { this.doc = doc; this.ops = []; this.width = doc.size[0]; this.height = doc.size[1]; }
  /** y is the baseline measured from the bottom. align: left|right|center relative to x (for right: x is the right edge). */
  text(str, x, y, { size = 10, bold = false, align = 'left', color = '#000000', dir = 'auto', maxWidth } = {}) {
    let s = String(str ?? ''); if (!s) return 0; let e = this.doc.encode(s, bold, size, dir);
    if (maxWidth && e.width > maxWidth) { while (s.length > 1 && this.doc.measure(s + '…', size, bold) > maxWidth) s = s.slice(0, -1); s += '…'; e = this.doc.encode(s, bold, size, dir); }
    const px = align === 'right' ? x - e.width : align === 'center' ? x - e.width / 2 : x;
    this.ops.push(`BT ${rgb(color)} rg /F${bold ? 2 : 1} ${num(size)} Tf ${num(px)} ${num(y)} Td <${e.hex}> Tj ET`); return e.width;
  }
  rect(x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) { this.ops.push(`${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' + num(lineWidth) + ' w ' : ''}${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`); }
  line(x1, y1, x2, y2, { color = '#cccccc', width = 0.5 } = {}) { this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`); }
  image(img, x, y, w, h) { this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /${img.name} Do Q`); }
}
export { baseDirection };
