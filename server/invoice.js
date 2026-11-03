// Branded, bilingual (English/Arabic) invoice & receipt PDF for platform subscription payments.
import { PdfDoc } from './pdf.js';
import { baseDirection } from './arabic.js';

const L = {
  en: { invoice: 'Invoice', receipt: 'Payment receipt', number: 'Invoice no.', date: 'Date', billTo: 'Billed to', from: 'From', description: 'Description', period: 'Period', amount: 'Amount', subtotal: 'Subtotal', tax: 'Tax', total: 'Total', paid: 'PAID', method: 'Payment method', reference: 'Reference', thanks: 'Thank you for your business.', mor: 'Payment processed by Paddle, our merchant of record. Paddle issues the tax invoice for this payment.', taxid: 'Tax ID', manual: { bank_transfer: 'Bank transfer', whish: 'Whish Money', omt: 'OMT', cash: 'Cash', other: 'Other', card: 'Card' } },
  ar: { invoice: 'فاتورة', receipt: 'إيصال دفع', number: 'رقم الفاتورة', date: 'التاريخ', billTo: 'فاتورة إلى', from: 'من', description: 'الوصف', period: 'الفترة', amount: 'المبلغ', subtotal: 'المجموع الفرعي', tax: 'الضريبة', total: 'الإجمالي', paid: 'مدفوعة', method: 'طريقة الدفع', reference: 'المرجع', thanks: 'شكرًا لتعاملكم معنا.', mor: 'تمت معالجة الدفع عبر Paddle بصفتها التاجر المسجّل. تصدر Paddle الفاتورة الضريبية لهذه الدفعة.', taxid: 'الرقم الضريبي', manual: { bank_transfer: 'حوالة مصرفية', whish: 'ويش موني', omt: 'OMT', cash: 'نقدًا', other: 'أخرى', card: 'بطاقة' } },
};
export const fmtMoney = (c, cur) => `${(c / 100).toLocaleString('en-US', { minimumFractionDigits: cur === 'LBP' ? 0 : 2, maximumFractionDigits: cur === 'LBP' ? 0 : 2 })} ${cur}`;

export function invoicePdf({ invoice, account, tenant, lang = 'en', logo = null }) {
  const t = L[lang] || L.en; const rtl = lang === 'ar'; const W = 595.28; const H = 841.89; const M = 44;
  const doc = new PdfDoc({ size: [W, H], title: `${t.invoice} ${invoice.number}` }); const p = doc.addPage();
  const edge = rtl ? W - M : M; const al = rtl ? 'right' : 'left'; const T = (s, y, o = {}) => p.text(s, edge, y, { align: al, ...o });
  const seller = { name: process.env.PLATFORM_LEGAL_NAME || process.env.PLATFORM_NAME || 'BizControl', address: process.env.PLATFORM_ADDRESS || '', taxId: process.env.PLATFORM_TAX_ID || '' };
  p.rect(0, H - 90, W, 90, { fill: '#1f3a5f' });
  if (logo) { try { const im = doc.addImage(logo); const h = 42; const w = Math.min(120, (im.w / im.h) * h); p.image(im, rtl ? W - M - w : M, H - 66, w, h); } catch { /* unsupported logo: skip */ } } else p.text(seller.name, edge, H - 52, { size: 20, bold: true, color: '#ffffff', align: al });
  p.text(invoice.status === 'paid' ? t.receipt : t.invoice, rtl ? M : W - M, H - 52, { size: 20, bold: true, color: '#ffffff', align: rtl ? 'left' : 'right' });
  let y = H - 125;
  const kv = (label, value, yy) => { p.text(label, rtl ? W - M : M, yy, { size: 9, color: '#666666', align: al }); p.text(value, rtl ? W - M - 110 : M + 110, yy, { size: 10, align: al, maxWidth: 220 }); };
  kv(t.number, invoice.number, y); kv(t.date, String(invoice.issued_at).slice(0, 10), y - 16);
  if (invoice.status === 'paid') { p.rect(rtl ? M : W - M - 78, y - 20, 78, 28, { stroke: '#0f7b4f', lineWidth: 1.5 }); p.text(t.paid, (rtl ? M : W - M - 78) + 39, y - 11, { size: 13, bold: true, color: '#0f7b4f', align: 'center' }); }
  y -= 56; T(t.from, y, { size: 9, color: '#666666' }); T(seller.name, y - 15, { size: 11, bold: true }); let yy = y - 30; if (seller.address) { T(seller.address, yy, { size: 9, maxWidth: 250 }); yy -= 13; } if (seller.taxId) { T(`${t.taxid}: ${seller.taxId}`, yy, { size: 9 }); yy -= 13; }
  const bx = rtl ? M : W / 2 + 10; const ba = rtl ? 'left' : 'left'; void ba;
  p.text(t.billTo, W / 2 + 10, y, { size: 9, color: '#666666', align: rtl ? 'right' : 'left', ...(rtl ? { } : {}) }); void bx;
  const bill = [tenant.business_name, account.name, account.email, account.country].filter(Boolean); bill.forEach((s, i) => p.text(s, rtl ? W / 2 - 10 : W / 2 + 10, y - 15 - i * 13, { size: i === 0 ? 11 : 9, bold: i === 0, align: rtl ? 'right' : 'left', maxWidth: 240 }));
  y = Math.min(yy, y - 15 - bill.length * 13) - 24;
  // line table
  p.rect(M, y - 6, W - 2 * M, 22, { fill: '#eef2f7' });
  const c = rtl ? { desc: W - M - 6, per: W / 2 + 40, amt: M + 6 } : { desc: M + 6, per: W / 2 + 10, amt: W - M - 6 };
  p.text(t.description, c.desc, y, { size: 9, bold: true, align: rtl ? 'right' : 'left' }); p.text(t.period, c.per, y, { size: 9, bold: true, align: rtl ? 'right' : 'left' }); p.text(t.amount, c.amt, y, { size: 9, bold: true, align: rtl ? 'left' : 'right' });
  y -= 24; const subtotal = invoice.amount_cents - (invoice.tax_cents || 0);
  p.text(invoice.description, c.desc, y, { size: 10, align: rtl ? 'right' : 'left', maxWidth: 230 }); p.text(invoice.period_start ? `${invoice.period_start} → ${invoice.period_end || ''}` : '', c.per, y, { size: 9, align: rtl ? 'right' : 'left', maxWidth: 140 }); p.text(fmtMoney(subtotal, invoice.currency), c.amt, y, { size: 10, align: rtl ? 'left' : 'right' });
  y -= 20; p.line(M, y, W - M, y, { color: '#dddddd' }); y -= 22;
  const tot = (label, val, bold = false) => { p.text(label, rtl ? M + 150 : W - M - 150, y, { size: bold ? 12 : 10, bold, align: rtl ? 'left' : 'right' }); p.text(val, rtl ? M : W - M, y, { size: bold ? 12 : 10, bold, align: rtl ? 'left' : 'right' }); y -= bold ? 20 : 16; };
  tot(t.subtotal, fmtMoney(subtotal, invoice.currency)); if (invoice.tax_cents) tot(t.tax, fmtMoney(invoice.tax_cents, invoice.currency)); tot(t.total, fmtMoney(invoice.amount_cents, invoice.currency), true);
  y -= 14; if (invoice.method) { kv(t.method, t.manual[invoice.method] || invoice.method, y); y -= 16; } if (invoice.reference) { kv(t.reference, invoice.reference, y); y -= 16; }
  if (invoice.provider === 'paddle') p.text(t.mor, edge, 120, { size: 8, color: '#666666', align: al, maxWidth: W - 2 * M });
  p.text(t.thanks, edge, 90, { size: 10, color: '#444444', align: al });
  return doc.build();
}
