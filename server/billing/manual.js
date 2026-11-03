// ManualBilling: bank transfer / Whish Money transfer / OMT / cash. The super-admin records the payment; same lapse rules as card billing.
import { cGet, tenantRow, planByCode, paudit } from '../control.js';
import { activate, issueInvoice, emailReceipt, addMonthsISO, today, PREPAID_MONTHS, prepaidQuote } from './core.js';
import { HttpError, bad, int, oneOf, str, date } from '../util.js';

export const METHODS = ['bank_transfer', 'whish', 'omt', 'cash', 'other'];
export const manual = {
  name: 'manual',
  /** Record a payment received outside any gateway and extend the paid-through date. */
  recordPayment(tenantId, b, actor) {
    const t = tenantRow(tenantId); if (!t) throw new HttpError(404, 'Tenant not found'); if (['deleted'].includes(t.status) || t.purged_at) throw bad('This workspace is deleted');
    const months = int(b.months, 'Months', { required: true, min: 1, max: 36 }); const amount = int(b.amount_cents, 'Amount', { required: true, min: 1 });
    const plan = b.plan ? planByCode(b.plan) : (t.plan_id ? cGet('SELECT * FROM plans WHERE id=?', t.plan_id) : null); if (!plan) throw bad('Choose a plan');
    const method = oneOf(b.method, 'Method', METHODS); const reference = str(b.reference, 'Reference', { required: true, max: 100 }); const currency = str(b.currency || 'USD', 'Currency', { max: 3 }).toUpperCase();
    const paidAt = date(b.paid_at, 'Paid on') || today();
    const start = t.paid_through && t.paid_through >= paidAt && t.status === 'active' ? t.paid_through : paidAt; const end = addMonthsISO(start, months);
    const { invoice, created } = issueInvoice({ tenantId, provider: 'manual', providerRef: `${tenantId}:${reference.toLowerCase()}`, description: `${plan.name} plan: ${months} month${months > 1 ? 's' : ''} (prepaid)`, amountCents: amount, taxCents: int(b.tax_cents, 'Tax', { min: 0 }), currency, periodStart: start, periodEnd: end, method, reference });
    if (!created) throw new HttpError(409, `A payment with reference "${reference}" was already recorded for this workspace (${invoice.number}).`);
    activate(tenantId, { planId: plan.id, interval: months >= 12 ? 'year' : 'month', paidThrough: end, actor, detail: `manual payment ${invoice.number}: +${months} month(s)` });
    paudit(actor, 'manual_payment', tenantId, { invoice: invoice.number, amount, currency, method, reference, months, paid_through: end });
    emailReceipt(invoice); return { invoice, paid_through: end };
  },
  quotes: (plan) => PREPAID_MONTHS.map((m) => prepaidQuote(plan, m)),
};
