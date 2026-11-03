// Rule-based sales intelligence. Every recommendation is derived from records in the database.
import { GET, POST, PUT } from '../http.js';
import { all, get, run, allSettings, recognizedSql, recDateSql } from '../db.js';
import { bad, notFound, todayStr, addDays, diffDays, nowIso, oneOf, date, safeJson } from '../util.js';
import { customerSelect } from './customers.js';
import { inventoryInsights } from './inventory.js';
import { periodFinancials } from './finance.js';
import { config } from '../config.js';

const VALID = "status NOT IN ('Draft','Cancelled','Returned')";

export function productWindow(from, to) {
  const rec = recognizedSql('o'); const rd = recDateSql('o');
  return all(`SELECT i.product_id id, COALESCE(p.name,i.description) name, SUM(i.qty) units, SUM(CAST(ROUND(i.line_total*1.0/o.fx_rate) AS INTEGER)) revenue, SUM(CAST(ROUND(i.line_cost*1.0/o.fx_rate) AS INTEGER)) cost
    FROM order_items i JOIN v_orders_fin o ON o.id=i.order_id LEFT JOIN products p ON p.id=i.product_id WHERE ${rec} AND ${rd} BETWEEN ? AND ? AND i.product_id IS NOT NULL GROUP BY i.product_id`, from, to)
    .map((x) => ({ ...x, profit: x.revenue - x.cost, margin: x.revenue ? ((x.revenue - x.cost) / x.revenue) * 100 : null }));
}

export function generateRecommendations() {
  const st = allSettings(); const today = todayStr(st.timezone); const cur = st.base_currency;
  const money = (c) => `${cur} ${Math.round(c / 100).toLocaleString('en-US')}`;
  const recs = [];
  const add = (r) => recs.push({ priority: 2, data: null, benefit: null, benefit_basis: null, link: null, ...r });

  const last30 = { from: addDays(today, -29), to: today }; const prev30 = { from: addDays(today, -59), to: addDays(today, -30) };
  const f30 = periodFinancials(last30.from, last30.to); const fp = periodFinancials(prev30.from, prev30.to);
  const cust = all(`SELECT * FROM (${customerSelect()})`);

  // ---------- CUSTOMER RETENTION ----------
  const inactive = cust.filter((c) => c.lifecycle === 'Inactive');
  if (inactive.length) {
    const avgSpend = inactive.reduce((a, c) => a + c.avg_order_value, 0) / inactive.length;
    const eligible = inactive.filter((c) => c.whatsapp && c.marketing_consent === 'opted_in').length;
    const est = Math.round(inactive.length * Number(st.reactivation_rate_estimate) * avgSpend);
    add({
      rkey: 'retention:inactive', category: 'Customer retention', kind: 'reactivation', priority: inactive.length >= 5 ? 1 : 2,
      title: `${inactive.length} customers have stopped buying`,
      detected: `${inactive.length} customers who bought before have not purchased in over ${st.inactive_days} days.`,
      data: { count: inactive.length, avg_order_value: Math.round(avgSpend), whatsapp_marketing_reachable: eligible, top: inactive.sort((a, b) => b.total_spent - a.total_spent).slice(0, 5).map((c) => ({ name: c.name, last_purchase: c.last_purchase, total_spent: c.total_spent })) },
      why: 'Winning back an existing customer is usually cheaper than finding a new one, and these customers already know your products.',
      action: eligible ? `Send a reactivation message to the ${eligible} of ${inactive.length} who agreed to WhatsApp marketing (use the "Customer reactivation" template with a small incentive). For the rest, call them or collect consent at the next contact.` : 'None of these customers has recorded WhatsApp marketing consent. Ask for consent on the next contact before running a campaign.',
      benefit: `≈ ${money(est)} (estimate)`, benefit_basis: `Assumes ${(st.reactivation_rate_estimate * 100).toFixed(0)}% of these customers return and place one order at their average order value (${money(Math.round(avgSpend))}). Change the rate in Settings.`,
      link: '#/marketing?segment=lapsed',
    });
  }
  const slowing = [];
  for (const c of cust.filter((x) => x.total_orders >= 3 && x.lifecycle !== 'Inactive')) {
    const ds = all("SELECT DISTINCT order_date d FROM orders WHERE customer_id=? AND " + VALID + " ORDER BY d", c.id).map((r) => r.d);
    const avg = diffDays(ds[0], ds[ds.length - 1]) / (ds.length - 1);
    if (avg > 0 && c.days_since_purchase > avg * 2 && c.days_since_purchase > 14) slowing.push({ name: c.name, avg_days_between_orders: Math.round(avg), days_since_last: c.days_since_purchase });
  }
  if (slowing.length) add({
    rkey: 'retention:slowing', category: 'Customer retention', kind: 'frequency_drop', priority: 2,
    title: `${slowing.length} regular customers are ordering less often`, detected: `${slowing.length} customers with 3+ orders are now overdue by more than twice their usual interval between orders.`,
    data: { customers: slowing.slice(0, 8) }, why: 'A slowing buying rhythm is the earliest sign a customer is drifting away, and it is cheapest to react before they go inactive.',
    action: 'Contact them personally or send a "we miss you" / personalised recommendation message based on what they bought before.', benefit: 'Prevents customers becoming inactive (not quantified)', benefit_basis: 'No monetary estimate: it depends on how many respond.', link: '#/customers?lifecycle=At risk',
  });

  // ---------- PRODUCT PERFORMANCE ----------
  const pa = productWindow(last30.from, last30.to); const pb = new Map(productWindow(prev30.from, prev30.to).map((p) => [p.id, p]));
  for (const p of pa.slice().sort((a, b) => b.units - a.units).slice(0, 1)) add({
    rkey: `product:best:${p.id}`, category: 'Product performance', kind: 'best_seller', priority: 3, title: `Best seller: ${p.name}`,
    detected: `${p.name} sold ${p.units} units (${money(p.revenue)}) in the last 30 days, more than any other product.`, data: { units: p.units, revenue: p.revenue, profit: p.profit, margin: p.margin },
    why: 'Your best seller drives revenue; running out of it, or discounting it needlessly, costs the most.', action: 'Keep it well stocked and feature it in campaigns and recommendations to customers who have not bought it.', link: `#/products?id=${p.id}`,
  });
  for (const p of pa) {
    const q = pb.get(p.id);
    if (q && q.units >= 5 && p.units < q.units * 0.7) add({
      rkey: `product:decline:${p.id}`, category: 'Product performance', kind: 'declining', priority: 2, title: `Sales of ${p.name} are declining`,
      detected: `${p.name}: ${p.units} units in the last 30 days vs ${q.units} in the previous 30 (${(((p.units - q.units) / q.units) * 100).toFixed(0)}%).`, data: { units: p.units, previous_units: q.units, revenue: p.revenue, previous_revenue: q.revenue },
      why: 'A falling product can mean lost customers, stock-outs, pricing issues or a competitor.', action: 'Check for stock-outs in the period, review the price, and consider a targeted offer to past buyers.',
      benefit: `≈ ${money(Math.max(0, q.revenue - p.revenue))} (estimate)`, benefit_basis: 'Revenue regained if sales returned to the previous 30-day level.', link: `#/orders?product_id=${p.id}`,
    });
  }
  const sorted = pa.filter((p) => p.margin != null).sort((a, b) => b.margin - a.margin);
  const medianUnits = pa.length ? pa.map((p) => p.units).sort((a, b) => a - b)[Math.floor(pa.length / 2)] : 0;
  for (const p of sorted.filter((x) => x.margin >= 40 && x.units <= medianUnits).slice(0, 2)) add({
    rkey: `product:promote:${p.id}`, category: 'Product performance', kind: 'promote', priority: 2, title: `Promote ${p.name} (high margin, modest sales)`,
    detected: `${p.name} earns a ${p.margin.toFixed(0)}% margin but sold only ${p.units} units in 30 days (median product: ${medianUnits}).`, data: { margin: p.margin, units: p.units, profit: p.profit },
    why: 'Each extra sale of a high-margin product adds more profit than a sale of a low-margin one.', action: 'Feature it in your next WhatsApp campaign, bundle it with best sellers, or offer it to customers who bought related products.',
    benefit: `≈ ${money(Math.round(p.profit * 0.5))} extra profit (estimate)`, benefit_basis: 'Assumes a 50% increase in units at the current margin.', link: '#/marketing',
  });
  for (const p of pa.filter((x) => x.margin != null && x.margin < 15 && x.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 3)) add({
    rkey: `finance:lowmargin:${p.id}`, category: 'Financial', kind: 'low_margin', priority: 1, title: `${p.name} sells well but earns little profit`,
    detected: `${p.name} generated ${money(p.revenue)} revenue but only ${money(p.profit)} profit (${p.margin.toFixed(1)}% margin) in the last 30 days.`, data: { revenue: p.revenue, profit: p.profit, margin: p.margin },
    why: 'Revenue without margin keeps you busy but does not grow the business, and small cost increases can turn it into a loss.', action: 'Review its supplier cost, raise the selling price, or reduce discounts on this product.',
    benefit: `≈ ${money(Math.round(p.revenue * 0.05))} (estimate)`, benefit_basis: 'A 5% price increase with unchanged volume.', link: `#/products?id=${p.id}`,
  });

  // ---------- SALES PERFORMANCE ----------
  if (fp.revenue > 0) {
    const ch = ((f30.revenue - fp.revenue) / fp.revenue) * 100;
    if (Math.abs(ch) >= 10) add({
      rkey: 'sales:trend', category: 'Sales performance', kind: ch < 0 ? 'sales_drop' : 'sales_growth', priority: ch < 0 ? 1 : 3,
      title: ch < 0 ? `Revenue fell ${Math.abs(ch).toFixed(0)}% vs the previous 30 days` : `Revenue grew ${ch.toFixed(0)}% vs the previous 30 days`,
      detected: `Last 30 days: ${money(f30.revenue)} (${f30.recognized_orders} orders). Previous 30 days: ${money(fp.revenue)} (${fp.recognized_orders} orders).`, data: { current: f30.revenue, previous: fp.revenue, change_pct: ch },
      why: ch < 0 ? 'A sustained fall in sales needs a cause: fewer customers, smaller orders, stock-outs or seasonality.' : 'Understanding what worked lets you repeat it.',
      action: ch < 0 ? 'Compare orders per customer and average order value below, check for stock-outs, and re-engage inactive customers.' : 'Identify which products or customer groups drove the growth and keep them in stock.', link: '#/analytics',
      benefit: ch < 0 ? `≈ ${money(fp.revenue - f30.revenue)} (estimate)` : null, benefit_basis: ch < 0 ? 'Revenue recovered if sales returned to the previous 30-day level.' : null,
    });
    const aov = f30.recognized_orders ? f30.revenue / f30.recognized_orders : 0; const aovP = fp.recognized_orders ? fp.revenue / fp.recognized_orders : 0;
    if (aov && aovP && Math.abs((aov - aovP) / aovP) >= 0.1) add({
      rkey: 'sales:aov', category: 'Sales performance', kind: 'aov_change', priority: 3, title: `Average order value ${aov > aovP ? 'rose' : 'fell'} ${Math.abs(((aov - aovP) / aovP) * 100).toFixed(0)}%`,
      detected: `Average order value: ${money(Math.round(aov))} now vs ${money(Math.round(aovP))} in the previous 30 days.`, data: { current: Math.round(aov), previous: Math.round(aovP) },
      why: 'Order value is a lever you control with bundles, minimum-order delivery offers and upselling.', action: aov < aovP ? 'Offer bundles or free delivery above a minimum order value.' : 'Keep the offers/products that raised the basket size.',
      benefit: `≈ ${money(Math.round(aov * 0.05 * f30.recognized_orders))} (estimate)`, benefit_basis: 'A 5% rise in average order value at the current order count.', link: '#/analytics',
    });
  }
  const days = all(`SELECT CAST(strftime('%w', ${recDateSql('o')}) AS INTEGER) wd, SUM(revenue_base) rev, COUNT(*) n FROM v_orders_fin o WHERE ${recognizedSql('o')} AND ${recDateSql('o')} BETWEEN ? AND ? GROUP BY wd`, addDays(today, -89), today);
  if (days.reduce((a, d) => a + d.n, 0) >= 20 && days.length >= 4) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const best = days.reduce((a, b) => (b.rev > a.rev ? b : a)); const worst = days.reduce((a, b) => (b.rev < a.rev ? b : a));
    add({
      rkey: 'sales:peakdays', category: 'Sales performance', kind: 'peak_days', priority: 3, title: `${names[best.wd]} is your strongest sales day`, detected: `Over the last 90 days ${names[best.wd]} produced ${money(best.rev)} (${best.n} orders) while ${names[worst.wd]} produced only ${money(worst.rev)} (${worst.n} orders).`,
      data: { best: names[best.wd], worst: names[worst.wd], by_day: days.map((d) => ({ day: names[d.wd], revenue: d.rev, orders: d.n })) },
      why: 'Knowing your rhythm lets you stock, staff and send promotions at the right moment.', action: `Make sure stock and delivery capacity are ready for ${names[best.wd]}, and schedule offers on ${names[worst.wd]} to lift the slow day.`, link: '#/analytics',
    });
  }
  const daily = all(`SELECT ${recDateSql('o')} d, SUM(revenue_base) v FROM v_orders_fin o WHERE ${recognizedSql('o')} AND ${recDateSql('o')} BETWEEN ? AND ? GROUP BY d`, addDays(today, -89), today);
  if (daily.length >= 20) {
    const map = new Map(daily.map((x) => [x.d, x.v])); const hist = []; const recent = [];
    for (let i = 0; i < 90; i++) { const d = addDays(today, -i); (i < 7 ? recent : hist).push(map.get(d) || 0); }
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length; const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
    const r7 = recent.reduce((a, b) => a + b, 0) / 7;
    if (sd > 0 && Math.abs(r7 - mean) / sd >= 1.5 && mean > 0) add({
      rkey: 'sales:unusual', category: 'Sales performance', kind: 'unusual', priority: r7 < mean ? 1 : 3, title: `Sales this week are unusually ${r7 < mean ? 'low' : 'high'}`,
      detected: `Average daily revenue over the last 7 days is ${money(Math.round(r7))} compared with a typical ${money(Math.round(mean))} (±${money(Math.round(sd))}) over the previous 83 days.`, data: { last7_avg: Math.round(r7), baseline_avg: Math.round(mean), std_dev: Math.round(sd) },
      why: 'A shift this large is unlikely to be random.', action: r7 < mean ? 'Check for stock-outs, delayed orders awaiting delivery (revenue is recognised on delivery) or fewer new orders.' : 'Check whether a promotion or a large one-off order caused it.', link: '#/analytics',
    });
  }
  const groups = all(`SELECT COALESCE(NULLIF(c.category,''),'Uncategorised') g, SUM(o.revenue_base) rev FROM v_orders_fin o JOIN customers c ON c.id=o.customer_id WHERE ${recognizedSql('o')} AND ${recDateSql('o')} BETWEEN ? AND ? GROUP BY g ORDER BY rev DESC`, addDays(today, -89), today);
  const totalG = groups.reduce((a, g) => a + g.rev, 0);
  if (groups.length > 1 && totalG && groups[0].g !== 'Uncategorised' && groups[0].rev / totalG >= 0.5) add({
    rkey: 'sales:group', category: 'Sales performance', kind: 'customer_group', priority: 3, title: `"${groups[0].g}" customers generate ${((groups[0].rev / totalG) * 100).toFixed(0)}% of revenue`,
    detected: `In the last 90 days the "${groups[0].g}" group produced ${money(groups[0].rev)} of ${money(totalG)}.`, data: { groups: groups.slice(0, 5) },
    why: 'Revenue concentrated in one group is both an opportunity and a risk.', action: 'Protect this group with loyalty offers and good service, and test promotions to grow the other groups.', link: '#/customers',
  });

  // ---------- INVENTORY ----------
  const inv = inventoryInsights();
  for (const p of inv.filter((x) => x.shortage_risk).sort((a, b) => a.days_cover - b.days_cover).slice(0, 5)) {
    const need = Math.max(1, Math.ceil(p.daily_demand * (Number(st.lead_time_days) + 14) - p.quantity));   // negative stock (oversold) is added to the order
    const out = p.quantity <= 0;
    add({
      rkey: `inventory:replenish:${p.id}`, category: 'Inventory', kind: 'replenish', priority: 1,
      title: out ? `${p.name} is out of stock but still selling` : `Reorder ${p.name}: about ${p.days_cover} days of stock left`,
      detected: out ? `${p.quantity < 0 ? `Oversold by ${-p.quantity} units (orders exceed recorded stock)` : 'Zero units in stock'}; ${p.sold_30d} sold in the last 30 days (≈${p.daily_demand.toFixed(1)}/day). Supplier lead time is ${st.lead_time_days} days.`
        : `${p.quantity} in stock; ${p.sold_30d} sold in the last 30 days (≈${p.daily_demand.toFixed(1)}/day). That is ${p.days_cover} days of cover vs a ${st.lead_time_days}-day supplier lead time.`,
      data: { quantity: p.quantity, sold_30d: p.sold_30d, days_cover: p.days_cover, suggested_order: need },
      why: 'Running out loses sales and can send customers to competitors.', action: `Order about ${need} units (covers ${out && p.quantity < 0 ? 'the oversold quantity, ' : ''}lead time plus 14 days at the recent sales rate).${p.supplier ? ' Supplier: ' + p.supplier + '.' : ''}${out && p.quantity < 0 ? ' Also check the stock count: negative stock usually means a delivery was not recorded.' : ''}`,
      benefit: `≈ ${money(Math.round(p.daily_demand * p.price * Math.max(0, Number(st.lead_time_days) - p.days_cover)))} sales protected (estimate)`, benefit_basis: 'Sales that would be lost during the days stock would be missing, at the current price and demand.', link: `#/products?id=${p.id}`,
    });
  }
  const slow = inv.filter((x) => x.slow_moving);
  if (slow.length) {
    const tied = slow.reduce((a, p) => a + Math.round(p.quantity * p.cost), 0);
    add({
      rkey: 'inventory:slow', category: 'Inventory', kind: 'slow_stock', priority: 2, title: `${slow.length} products have not sold in ${st.slow_moving_days}+ days`,
      detected: `${slow.length} products in stock with no sales in ${st.slow_moving_days} days, holding about ${money(tied)} at cost (mixed currencies not converted).`, data: { products: slow.slice(0, 8).map((p) => ({ name: p.name, quantity: p.quantity, last_sale: p.last_sale })) },
      why: 'Money tied up in stock that is not selling cannot be used for products that do.', action: 'Discount or bundle these items, promote them to customers who bought similar products, and avoid reordering.', benefit: `Up to ≈ ${money(tied)} cash released (estimate)`, benefit_basis: 'Sell-through at cost; actual recovery depends on discounting.', link: '#/products',
    });
  }
  const excess = inv.filter((p) => p.max_stock != null && p.quantity > p.max_stock);
  if (excess.length) add({
    rkey: 'inventory:excess', category: 'Inventory', kind: 'excess', priority: 3, title: `${excess.length} products are above their maximum stock level`, detected: excess.slice(0, 5).map((p) => `${p.name}: ${p.quantity} (max ${p.max_stock})`).join('; '),
    data: { products: excess.map((p) => ({ name: p.name, quantity: p.quantity, max: p.max_stock })) }, why: 'Overstock raises storage and spoilage risk.', action: 'Pause reordering and run a promotion on these products.', link: '#/products?stock=high',
  });

  // ---------- FINANCIAL ----------
  if (fp.revenue > 0 && f30.revenue > 0 && fp.gross_margin_pct != null && f30.gross_margin_pct != null && fp.gross_margin_pct - f30.gross_margin_pct >= 3) add({
    rkey: 'finance:margin', category: 'Financial', kind: 'margin_decline', priority: 1, title: `Gross margin dropped from ${fp.gross_margin_pct.toFixed(1)}% to ${f30.gross_margin_pct.toFixed(1)}%`,
    detected: `Direct costs are taking a larger share of revenue: ${((f30.direct_costs / f30.revenue) * 100).toFixed(1)}% now vs ${((fp.direct_costs / fp.revenue) * 100).toFixed(1)}% in the previous 30 days.`, data: { margin_now: f30.gross_margin_pct, margin_before: fp.gross_margin_pct },
    why: 'Higher supplier costs or heavier discounting reduce profit even when sales look healthy.', action: 'Review supplier prices, discounts given, and the lowest-margin products (see the other financial recommendations).',
    benefit: `≈ ${money(Math.round(f30.revenue * ((fp.gross_margin_pct - f30.gross_margin_pct) / 100)))} per 30 days (estimate)`, benefit_basis: 'Restoring the previous margin on current revenue.', link: '#/analytics',
  });
  const ex = (a, b) => all('SELECT category c, SUM(CAST(ROUND(amount*1.0/fx_rate) AS INTEGER)) v FROM expenses WHERE paid_at BETWEEN ? AND ? GROUP BY category', a, b);
  const exP = new Map(ex(prev30.from, prev30.to).map((x) => [x.c, x.v]));
  for (const e of ex(last30.from, last30.to)) {
    const p = exP.get(e.c) || 0;
    if (p > 0 && e.v > p * 1.25 && e.v - p > 5000) add({
      rkey: `finance:expense:${e.c}`, category: 'Financial', kind: 'cost_increase', priority: 2, title: `${e.c} expenses rose ${(((e.v - p) / p) * 100).toFixed(0)}%`, detected: `${e.c}: ${money(e.v)} in the last 30 days vs ${money(p)} in the previous 30.`, data: { current: e.v, previous: p },
      why: 'Rising operating costs reduce net profit unless sales grow with them.', action: 'Check the individual expenses in this category for one-off items or price rises.', benefit: `≈ ${money(e.v - p)} per month (estimate)`, benefit_basis: 'The increase, if it is avoidable.', link: '#/expenses',
    });
  }
  const debtors = all(`SELECT c.id, c.name, SUM(f.balance_base) bal, MIN(f.order_date) oldest FROM v_orders_fin f JOIN customers c ON c.id=f.customer_id WHERE f.balance>0 AND f.status NOT IN ('Draft','Cancelled','Returned') GROUP BY c.id ORDER BY bal DESC`);
  const totalDebt = debtors.reduce((a, d) => a + d.bal, 0);
  const bigDebt = debtors.filter((d) => d.bal >= totalDebt * 0.15 && diffDays(d.oldest, today) >= Number(st.unpaid_alert_days)).slice(0, 5);
  if (bigDebt.length) add({
    rkey: 'finance:debtors', category: 'Financial', kind: 'receivables', priority: 1, title: `${bigDebt.length} customers hold ${money(bigDebt.reduce((a, d) => a + d.bal, 0))} of unpaid balances`,
    detected: bigDebt.map((d) => `${d.name}: ${money(d.bal)} (oldest order ${d.oldest})`).join('; ') + `. Total receivables: ${money(totalDebt)}.`, data: { customers: bigDebt }, why: 'Unpaid orders are sales you have not been paid for; they strain cash even though profit looks fine.',
    action: 'Send payment reminders (WhatsApp "Payment reminder" template) or call these customers; consider requiring a deposit for repeat late payers.', benefit: `≈ ${money(bigDebt.reduce((a, d) => a + d.bal, 0))} cash collected (estimate)`, benefit_basis: 'If all listed balances are collected.', link: '#/payments?tab=receivables',
  });

  return recs;
}

export function refreshRecommendations() {
  const recs = generateRecommendations(); const keys = new Set(recs.map((r) => r.rkey)); const today = todayStr(allSettings().timezone);
  for (const r of recs) {
    const ex = get('SELECT * FROM recommendations WHERE rkey=?', r.rkey);
    const vals = [r.category, r.kind, r.priority, r.title, r.detected, JSON.stringify(r.data), r.why, r.action, r.benefit, r.benefit_basis, r.link, nowIso()];
    if (!ex) run("INSERT INTO recommendations(category,kind,priority,title,detected,data,why,action,benefit,benefit_basis,link,updated_at,rkey,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'rules')", ...vals, r.rkey, nowIso());
    else {
      let status = ex.status;
      if (['completed', 'ignored'].includes(status) && Date.now() - Date.parse(ex.updated_at) > 30 * 864e5) status = 'new';       // may resurface after 30 days
      if (status === 'scheduled' && ex.scheduled_for && ex.scheduled_for <= today) status = 'new';
      run('UPDATE recommendations SET category=?,kind=?,priority=?,title=?,detected=?,data=?,why=?,action=?,benefit=?,benefit_basis=?,link=?, status=?, updated_at=CASE WHEN status=? THEN ? ELSE updated_at END WHERE id=?',
        r.category, r.kind, r.priority, r.title, r.detected, JSON.stringify(r.data), r.why, r.action, r.benefit, r.benefit_basis, r.link, status, status, nowIso(), ex.id);
    }
  }
  // drop stale untouched rule-based recommendations whose condition no longer holds
  for (const x of all("SELECT id, rkey FROM recommendations WHERE source='rules' AND status='new'")) if (!keys.has(x.rkey)) run('DELETE FROM recommendations WHERE id=?', x.id);
  return recs.length;
}

GET('/api/recommendations', { perm: 'analytics:read' }, (ctx) => {
  if (ctx.query.refresh === '1' || !get('SELECT 1 x FROM recommendations LIMIT 1')) refreshRecommendations();
  const w = []; const p = [];
  if (ctx.query.status) { w.push('status=?'); p.push(ctx.query.status); }
  if (ctx.query.category) { w.push('category=?'); p.push(ctx.query.category); }
  const rows = all(`SELECT * FROM recommendations ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY status='new' DESC, priority, id DESC`, ...p).map((r) => ({ ...r, data: safeJson(r.data) }));
  return { rows, ai_available: Boolean(config.ai().key), counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM recommendations GROUP BY status').map((x) => [x.status, x.n])) };
});
POST('/api/recommendations/refresh', { perm: 'analytics:read' }, () => ({ generated: refreshRecommendations() }));
PUT('/api/recommendations/:id', { perm: 'analytics:read' }, (ctx) => {
  const r = get('SELECT * FROM recommendations WHERE id=?', ctx.params.id); if (!r) throw notFound('Recommendation');
  const status = oneOf(ctx.body.status, 'Status', ['new', 'completed', 'ignored', 'scheduled']);
  const sf = status === 'scheduled' ? date(ctx.body.scheduled_for, 'Scheduled date', { required: true }) : null;
  run('UPDATE recommendations SET status=?, scheduled_for=?, updated_at=? WHERE id=?', status, sf, nowIso(), r.id);
  return { ok: true };
});

POST('/api/recommendations/ai', { perm: 'analytics:read' }, async () => {
  const ai = config.ai(); if (!ai.key) throw bad('AI analysis is not enabled. Set ANTHROPIC_API_KEY in the server environment.');
  const st = allSettings(); const today = todayStr(st.timezone);
  const f30 = periodFinancials(addDays(today, -29), today); const fp = periodFinancials(addDays(today, -59), addDays(today, -30));
  const summary = {
    currency: st.base_currency, last_30_days: f30, previous_30_days: fp,
    top_products_30d: productWindow(addDays(today, -29), today).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    customers: all(`SELECT lifecycle, COUNT(*) n FROM (${customerSelect()}) GROUP BY lifecycle`),
    low_stock: inventoryInsights().filter((p) => p.stock_state !== 'ok' || p.shortage_risk).slice(0, 10).map((p) => ({ name: p.name, quantity: p.quantity, state: p.stock_state, days_cover: p.days_cover })),
    rule_findings: generateRecommendations().map((r) => r.title),
  };
  let res;
  try {
    res = await fetch(`${ai.base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: ai.model, max_tokens: 1200, system: 'You are a careful business analyst for a small retailer. Use ONLY the JSON data provided; never invent numbers. Amounts are in minor units (divide by 100). Give 4-6 prioritised, concrete recommendations. For each: what you see (cite the numbers), why it matters, what to do, and label any benefit as an estimate with its assumption. Be concise.', messages: [{ role: 'user', content: JSON.stringify(summary) }] }) });
  } catch (e) { throw Object.assign(new Error('Could not reach the AI service: ' + e.message), { status: 502 }); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j?.error?.message || `AI service error ${res.status}`), { status: 502 });
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const key = `ai:${today}`;
  run('DELETE FROM recommendations WHERE rkey=?', key);
  run("INSERT INTO recommendations(rkey,category,kind,priority,title,detected,data,why,action,benefit,benefit_basis,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'new','ai',?,?)",
    key, 'AI analysis', 'ai', 2, `AI analysis - ${today}`, text, null, 'Generated by an AI model from aggregated figures only (no customer names or phone numbers were sent).', 'Review the suggestions and verify them against your own knowledge before acting.', 'Estimates, if any, are stated inside the analysis', 'AI output can be wrong.', nowIso(), nowIso());
  return { ok: true };
});
