// Weekly digest: deterministic numbers (no AI needed), sent to the owner every Monday in the workspace's language.
import { all, get, run, allSettings, currentTenantContext } from '../db.js';
import { recognizedSql, recDateSql } from '../db.js';
import { todayStr, addDays, mondayOf } from '../util.js';
import { periodFinancials } from './finance.js';
import { sendPlatformEmail } from '../platformmail.js';
import { config } from '../config.js';
import { cGet } from '../control.js';

const fmt = (c, cur) => `${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`;
export function buildDigest() {
  const st = allSettings(); const today = todayStr(st.timezone); const cur = st.base_currency;
  const thisWeek = { from: addDays(today, -6), to: today }; const lastWeek = { from: addDays(today, -13), to: addDays(today, -7) };
  const a = periodFinancials(thisWeek.from, thisWeek.to); const b = periodFinancials(lastWeek.from, lastWeek.to);
  const ch = b.revenue ? Math.round(((a.revenue - b.revenue) / b.revenue) * 100) : null;
  const best = all(`SELECT COALESCE(p.name,i.description) n, SUM(i.qty) q FROM order_items i JOIN v_orders_fin o ON o.id=i.order_id LEFT JOIN products p ON p.id=i.product_id WHERE ${recognizedSql('o')} AND ${recDateSql('o')} BETWEEN ? AND ? GROUP BY COALESCE(i.product_id,'d'||i.description) ORDER BY q DESC LIMIT 3`, thisWeek.from, thisWeek.to);
  const overdue = get("SELECT COUNT(*) c, COALESCE(SUM(balance_base),0) s FROM v_orders_fin WHERE balance>0 AND status NOT IN ('Draft','Cancelled','Returned') AND order_date <= ?", addDays(today, -7));
  const low = get("SELECT COUNT(*) c FROM products WHERE status='Active' AND min_stock>0 AND quantity<=min_stock").c;
  const atRisk = get("SELECT COUNT(DISTINCT customer_id) c FROM orders WHERE status NOT IN ('Draft','Cancelled','Returned') AND customer_id NOT IN (SELECT customer_id FROM orders WHERE order_date >= ? AND status NOT IN ('Draft','Cancelled','Returned'))", addDays(today, -Number(st.at_risk_days))).c;
  const en = [`Revenue (last 7 days): ${fmt(a.revenue, cur)}${ch === null ? '' : ` (${ch >= 0 ? '+' : ''}${ch}% vs the week before)`}`, `Orders recognised: ${a.recognized_orders}`, best.length ? `Best sellers: ${best.map((x) => `${x.n} (${x.q})`).join(', ')}` : 'Best sellers: no sales yet', `Unpaid balances older than 7 days: ${overdue.c} orders, ${fmt(overdue.s, cur)}`, `Products low on stock: ${low}`, `Customers at risk of leaving: ${atRisk}`,
    'Suggested actions:', overdue.c ? '1. Send payment reminders (open Payments → Receivables, tap the WhatsApp button).' : '1. Review your best sellers and make sure they are in stock.', atRisk ? '2. Message customers who have not ordered recently.' : '2. Ask happy customers for a referral.', low ? '3. Reorder the products that are low on stock.' : '3. Check pending orders that are close to their delivery date.'];
  const ar = [`الإيرادات (آخر 7 أيام): ${fmt(a.revenue, cur)}${ch === null ? '' : ` (${ch >= 0 ? '+' : ''}${ch}% مقارنة بالأسبوع السابق)`}`, `الطلبات المحتسبة: ${a.recognized_orders}`, best.length ? `الأكثر مبيعًا: ${best.map((x) => `${x.n} (${x.q})`).join('، ')}` : 'الأكثر مبيعًا: لا توجد مبيعات بعد', `أرصدة غير مدفوعة منذ أكثر من 7 أيام: ${overdue.c} طلبات بقيمة ${fmt(overdue.s, cur)}`, `منتجات مخزونها منخفض: ${low}`, `عملاء معرّضون للمغادرة: ${atRisk}`,
    'إجراءات مقترحة:', overdue.c ? '1. أرسل تذكيرات بالدفع (المدفوعات ← الذمم، واضغط زر واتساب).' : '1. راجع الأكثر مبيعًا وتأكد من توفرها.', atRisk ? '2. تواصل مع العملاء الذين لم يطلبوا مؤخرًا.' : '2. اطلب من عملائك الراضين ترشيحك لغيرهم.', low ? '3. أعد طلب المنتجات منخفضة المخزون.' : '3. راجع الطلبات المعلّقة القريبة من موعد التسليم.'];
  return { lines: en, linesAr: ar, revenue: a.revenue, has_activity: a.recognized_orders > 0 || overdue.c > 0 };
}
/** Called daily per tenant; sends once per Monday (tenant time zone) to the owner. */
export function sendWeeklyDigest(force = false) {
  const st = allSettings(); if (!st.weekly_digest && !force) return false;
  const today = todayStr(st.timezone); if (!force && new Date(today + 'T00:00:00Z').getUTCDay() !== 1) return false;
  const key = `digest_week_${mondayOf(today)}`; if (!force && get('SELECT 1 x FROM business_settings WHERE key=?', key)) return false;
  const d = buildDigest(); if (!d.has_activity && !force) return false;
  const t = currentTenantContext().tenant; const acc = cGet('SELECT * FROM accounts WHERE id=?', t.account_id); if (!acc) return false;
  sendPlatformEmail('weekly_digest', acc.email, { business: st.business_name, lines: d.lines, linesAr: d.linesAr, url: config.tenantUrl(t.subdomain) }, st.language || 'en');
  run('INSERT OR IGNORE INTO business_settings(key,value) VALUES (?,?)', key, JSON.stringify(new Date().toISOString()));
  return key;
}
