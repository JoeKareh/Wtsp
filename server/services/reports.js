import { GET, raw } from '../http.js';
import { all, get, allSettings, recognizedSql, recDateSql } from '../db.js';
import { bad, notFound, date, resolveRange, todayStr, nowIso, diffDays, escLike } from '../util.js';
import { hasPerm } from '../perms.js';
import { toCsv, toXlsx, toPdf } from '../export.js';
import { customerSelect } from './customers.js';
import { inventoryInsights } from './inventory.js';
import { fxSnapshot } from './finance.js';

const T = (key, label, type = 'text') => ({ key, label, type });
const VALID = "status NOT IN ('Draft','Cancelled','Returned')";
const OPENS = "('Pending','Confirmed','Processing','Ready','Out for delivery')";

function salesBy(group, r) {
  const rec = recognizedSql('o'); const rd = recDateSql('o');
  const rows = all(`SELECT ${group} AS period, COUNT(*) orders, SUM(revenue_base) revenue, SUM(cost_base) cost, SUM(revenue_base-cost_base) profit, SUM(due_base) total_due
    FROM v_orders_fin o WHERE ${rec} AND ${rd} BETWEEN ? AND ? GROUP BY period ORDER BY period`, r.from, r.to);
  const tot = rows.reduce((a, x) => ({ orders: a.orders + x.orders, revenue: a.revenue + x.revenue, cost: a.cost + x.cost, profit: a.profit + x.profit }), { orders: 0, revenue: 0, cost: 0, profit: 0 });
  return {
    columns: [T('period', 'Period'), T('orders', 'Orders', 'int'), T('revenue', 'Revenue', 'money'), T('cost', 'Direct costs', 'money'), T('profit', 'Gross profit', 'money'), T('margin', 'Margin', 'pct'), T('aov', 'Avg order value', 'money')],
    rows: rows.map((x) => ({ ...x, margin: x.revenue ? (x.profit / x.revenue) * 100 : null, aov: x.orders ? Math.round(x.revenue / x.orders) : 0 })),
    summary: [{ label: 'Total orders', value: tot.orders, type: 'int' }, { label: 'Total revenue', value: tot.revenue, type: 'money' }, { label: 'Direct costs', value: tot.cost, type: 'money' }, { label: 'Gross profit', value: tot.profit, type: 'money' }],
    finance: ['cost', 'profit', 'margin'],
  };
}
const orderCols = [T('number', 'Order'), T('order_date', 'Date', 'date'), T('customer_name', 'Customer'), T('customer_phone', 'Phone'), T('status', 'Status'), T('payment_status', 'Payment'), T('currency', 'Cur.'), T('total', 'Total (order cur.)', 'money'), T('paid', 'Paid', 'money'), T('balance', 'Balance', 'money'), T('expected_date', 'Expected'), T('delivery_date', 'Delivered')];

export const REPORTS = {
  daily_sales: { name: 'Daily sales', perm: 'orders:read', run: (r) => salesBy(recDateSql('o'), r) },
  monthly_sales: { name: 'Monthly sales', perm: 'orders:read', run: (r) => salesBy(`substr(${recDateSql('o')},1,7)`, r) },
  yearly_sales: { name: 'Yearly sales', perm: 'orders:read', run: (r) => salesBy(`substr(${recDateSql('o')},1,4)`, r) },
  orders: {
    name: 'Orders', perm: 'orders:read', filters: ['status', 'payment_status'],
    run: (r, q) => {
      const w = ['f.order_date BETWEEN ? AND ?']; const p = [r.from, r.to];
      if (q.status) { w.push('f.status=?'); p.push(q.status); } if (q.payment_status) { w.push('f.payment_status=?'); p.push(q.payment_status); }
      const rows = all(`SELECT f.*, c.name customer_name FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id WHERE ${w.join(' AND ')} ORDER BY f.order_date, f.id`, ...p);
      return { columns: orderCols, rows, summary: [{ label: 'Orders', value: rows.length, type: 'int' }, { label: 'Total due (reporting cur.)', value: rows.reduce((a, x) => a + x.due_base, 0), type: 'money' }, { label: 'Outstanding (reporting cur.)', value: rows.reduce((a, x) => a + Math.max(x.balance_base, 0), 0), type: 'money' }] };
    },
  },
  pending_orders: {
    name: 'Pending orders', perm: 'orders:read', noRange: true,
    run: () => {
      const today = todayStr(allSettings().timezone);
      const rows = all(`SELECT f.*, c.name customer_name, CASE WHEN f.expected_date < ? THEN CAST(julianday(?)-julianday(f.expected_date) AS INTEGER) ELSE 0 END days_late FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id WHERE f.status IN ${OPENS} ORDER BY f.expected_date IS NULL, f.expected_date`, today, today);
      return { columns: [...orderCols, T('days_late', 'Days late', 'int')], rows, summary: [{ label: 'Open orders', value: rows.length, type: 'int' }, { label: 'Overdue', value: rows.filter((x) => x.days_late > 0).length, type: 'int' }] };
    },
  },
  customer_balances: {
    name: 'Customer balances', perm: 'payments:read', noRange: true,
    run: () => {
      const rows = all(`SELECT c.name, c.phone, COUNT(*) open_orders, SUM(f.balance_base) balance, MIN(f.order_date) oldest FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id WHERE f.balance>0 AND ${VALID.replace('status', 'f.status')} GROUP BY c.id ORDER BY balance DESC`);
      return { columns: [T('name', 'Customer'), T('phone', 'Phone'), T('open_orders', 'Open orders', 'int'), T('balance', 'Outstanding', 'money'), T('oldest', 'Oldest unpaid order', 'date')], rows, summary: [{ label: 'Total outstanding', value: rows.reduce((a, x) => a + x.balance, 0), type: 'money' }] };
    },
  },
  payments: {
    name: 'Payments', perm: 'payments:read',
    run: (r) => {
      const rows = all(`SELECT p.code, p.paid_at, c.name customer, p.type, p.method, p.currency, p.amount, p.fx_rate, CAST(ROUND(p.amount*1.0/p.fx_rate) AS INTEGER) base, p.reference, p.voided,
        (SELECT group_concat(o.number, ' ') FROM payment_allocations a JOIN orders o ON o.id=a.order_id WHERE a.payment_id=p.id) orders
        FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.paid_at BETWEEN ? AND ? ORDER BY p.paid_at, p.id`, r.from, r.to).map((x) => ({ ...x, status: x.voided ? 'VOIDED' : '', fx: x.fx_rate }));
      const live = rows.filter((x) => !x.voided);
      return { columns: [T('code', 'Payment'), T('paid_at', 'Date', 'date'), T('customer', 'Customer'), T('type', 'Type'), T('method', 'Method'), T('currency', 'Cur.'), T('amount', 'Amount', 'money'), T('fx', 'Rate/base', 'number'), T('base', 'In reporting cur.', 'money'), T('orders', 'Orders'), T('reference', 'Reference'), T('status', 'Status')], rows,
        summary: [{ label: 'Collected (reporting cur.)', value: live.filter((x) => x.type === 'payment').reduce((a, x) => a + x.base, 0), type: 'money' }, { label: 'Refunded (reporting cur.)', value: live.filter((x) => x.type === 'refund').reduce((a, x) => a + x.base, 0), type: 'money' }] };
    },
  },
  expenses: {
    name: 'Expenses', perm: 'expenses:read',
    run: (r) => {
      const rows = all(`SELECT code, paid_at, category, description, method, currency, amount, fx_rate fx, CAST(ROUND(amount*1.0/fx_rate) AS INTEGER) base FROM expenses WHERE paid_at BETWEEN ? AND ? ORDER BY paid_at, id`, r.from, r.to);
      return { columns: [T('code', 'Expense'), T('paid_at', 'Date', 'date'), T('category', 'Category'), T('description', 'Description'), T('method', 'Method'), T('currency', 'Cur.'), T('amount', 'Amount', 'money'), T('fx', 'Rate/base', 'number'), T('base', 'In reporting cur.', 'money')], rows, summary: [{ label: 'Total expenses (reporting cur.)', value: rows.reduce((a, x) => a + x.base, 0), type: 'money' }] };
    },
  },
  product_profitability: {
    name: 'Product profitability', perm: 'orders:read', needsFinance: true,
    run: (r) => {
      const rec = recognizedSql('o'); const rd = recDateSql('o');
      const rows = all(`SELECT COALESCE(p.name,i.description) name, p.sku, SUM(i.qty) units, SUM(CAST(ROUND(i.line_total*1.0/o.fx_rate) AS INTEGER)) revenue, SUM(CAST(ROUND(i.line_cost*1.0/o.fx_rate) AS INTEGER)) cost
        FROM order_items i JOIN v_orders_fin o ON o.id=i.order_id LEFT JOIN products p ON p.id=i.product_id WHERE ${rec} AND ${rd} BETWEEN ? AND ? GROUP BY COALESCE(i.product_id,'d'||i.description) ORDER BY revenue DESC`, r.from, r.to)
        .map((x) => ({ ...x, profit: x.revenue - x.cost, margin: x.revenue ? ((x.revenue - x.cost) / x.revenue) * 100 : null }));
      return { columns: [T('name', 'Product'), T('sku', 'SKU'), T('units', 'Units sold', 'number'), T('revenue', 'Revenue', 'money'), T('cost', 'Cost', 'money'), T('profit', 'Profit', 'money'), T('margin', 'Margin', 'pct')], rows, notes: ['Product revenue is line revenue before order-level discounts, so totals can be slightly higher than the sales reports.'], summary: [{ label: 'Total profit', value: rows.reduce((a, x) => a + x.profit, 0), type: 'money' }] };
    },
  },
  inventory: {
    name: 'Inventory', perm: 'products:read', noRange: true,
    run: () => {
      const rows = inventoryInsights().map((p) => ({ ...p, state: { out: 'Out of stock', low: 'Low', high: 'High', ok: 'OK' }[p.stock_state], cover: p.days_cover }));
      return { columns: [T('code', 'ID'), T('name', 'Product'), T('sku', 'SKU'), T('category', 'Category'), T('quantity', 'In stock', 'number'), T('min_stock', 'Min', 'number'), T('max_stock', 'Max', 'number'), T('state', 'Status'), T('sold_30d', 'Sold 30d', 'number'), T('cover', 'Days cover', 'int'), T('cost', 'Unit cost', 'money'), T('price', 'Price', 'money'), T('currency', 'Cur.')], rows, finance: ['cost'] };
    },
  },
  customer_activity: {
    name: 'Customer activity', perm: 'customers:read', noRange: true,
    run: () => {
      const rows = all(`SELECT * FROM (${customerSelect()}) ORDER BY total_spent DESC`).map((c) => ({ ...c, loyal: c.is_loyal ? 'Yes' : '', consent: c.marketing_consent || 'none' }));
      return { columns: [T('code', 'ID'), T('name', 'Customer'), T('phone', 'Phone'), T('category', 'Category'), T('status', 'Status'), T('lifecycle', 'Lifecycle'), T('loyal', 'Loyal'), T('total_orders', 'Orders', 'int'), T('total_spent', 'Total spent', 'money'), T('total_paid', 'Paid', 'money'), T('outstanding', 'Outstanding', 'money'), T('last_purchase', 'Last purchase', 'date'), T('days_since_purchase', 'Days since', 'int'), T('consent', 'WhatsApp consent')], rows };
    },
  },
  campaign_performance: {
    name: 'WhatsApp campaign performance', perm: 'marketing:read',
    run: (r) => {
      const rows = all(`SELECT c.id, c.name, c.status, substr(c.created_at,1,10) created, c.targeted, c.eligible,
          (SELECT COUNT(sent_at) FROM whatsapp_messages WHERE campaign_id=c.id AND direction='out') sent,
          (SELECT COUNT(delivered_at) FROM whatsapp_messages WHERE campaign_id=c.id AND direction='out') delivered,
          (SELECT COUNT(read_at) FROM whatsapp_messages WHERE campaign_id=c.id AND direction='out') read,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE campaign_id=c.id AND status='failed') failed,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE reply_to_campaign_id=c.id AND direction='in') replies,
          (SELECT COUNT(*) FROM campaign_attributions WHERE campaign_id=c.id) orders,
          (SELECT COALESCE(SUM(f.revenue_base),0) FROM campaign_attributions a JOIN v_orders_fin f ON f.id=a.order_id WHERE a.campaign_id=c.id AND f.status NOT IN ('Draft','Cancelled','Returned')) revenue
        FROM whatsapp_campaigns c WHERE substr(c.created_at,1,10) BETWEEN ? AND ? ORDER BY c.id`, r.from, r.to);
      return { columns: [T('name', 'Campaign'), T('created', 'Created', 'date'), T('status', 'Status'), T('targeted', 'Targeted', 'int'), T('eligible', 'Eligible', 'int'), T('sent', 'Sent', 'int'), T('delivered', 'Delivered', 'int'), T('read', 'Read', 'int'), T('failed', 'Failed', 'int'), T('replies', 'Replies', 'int'), T('orders', 'Attributed orders', 'int'), T('revenue', 'Attributed revenue', 'money')], rows };
    },
  },
};

export function buildReport(key, q, user) {
  const def = REPORTS[key]; if (!def) throw notFound('Report');
  if (!hasPerm(user, 'reports:read') || !hasPerm(user, def.perm)) throw Object.assign(new Error('You do not have permission to view this report'), { status: 403 });
  const finance = hasPerm(user, 'finance:read');
  if (def.needsFinance && !finance) throw Object.assign(new Error('This report contains cost and profit data'), { status: 403 });
  const st = allSettings();
  const r = def.noRange ? { from: null, to: null, label: 'As of today' } : resolveRange({ range: q.range || 'this_month', from: q.from, to: q.to }, st.timezone);
  const body = def.run(r, q);
  let { columns, rows, summary = [] } = body;
  if (!finance) {
    const hide = new Set(body.finance || []);
    columns = columns.filter((c) => !hide.has(c.key)); summary = summary.filter((s) => !/cost|profit/i.test(s.label));
  }
  const fx = fxSnapshot();
  return {
    key, title: def.name, columns, rows, summary, notes: [...(body.notes || []), `Amounts marked "reporting cur." are in ${st.base_currency}, converted at the rate recorded on each transaction. ${fx.rates.map((x) => x.text).join('; ')}.`],
    subtitle: `${st.business_name}  |  ${def.noRange ? 'As of ' + todayStr(st.timezone) : `${r.from} to ${r.to}`}  |  Generated ${nowIso().slice(0, 16).replace('T', ' ')} UTC`,
    range: r, reporting_currency: st.base_currency, no_range: !!def.noRange,
  };
}

GET('/api/reports', { perm: 'reports:read' }, (ctx) => Object.entries(REPORTS).filter(([, d]) => hasPerm(ctx.user, d.perm) && (!d.needsFinance || hasPerm(ctx.user, 'finance:read'))).map(([key, d]) => ({ key, name: d.name, no_range: !!d.noRange, filters: d.filters || [] })));
GET('/api/reports/:key', { perm: 'reports:read' }, (ctx) => {
  const rep = buildReport(ctx.params.key, ctx.query, ctx.user);
  const fmt = ctx.query.format || 'json'; const base = `${rep.key}_${rep.no_range ? todayStr(allSettings().timezone) : rep.range.from + '_' + rep.range.to}`;
  if (fmt === 'csv') return raw(toCsv(rep), 'text/csv; charset=utf-8', base + '.csv');
  if (fmt === 'xlsx') return raw(toXlsx(rep), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base + '.xlsx');
  if (fmt === 'pdf') return raw(toPdf(rep), 'application/pdf', base + '.pdf');
  if (fmt !== 'json') throw bad('Unknown format');
  return { ...rep, rows: rep.rows.slice(0, 2000), truncated: rep.rows.length > 2000, total_rows: rep.rows.length };
});
