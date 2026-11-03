import { all, run, allSettings } from './db.js';
import { runChecks, sendDailyDigest } from './services/notifications.js';
import { processCampaigns } from './services/whatsapp.js';
import { processRecurringExpenses } from './services/expenses.js';
import { refreshAllCustomerStatuses } from './services/customers.js';
import { refreshRecommendations } from './services/recommendations.js';
import { flushOutbox } from './mail.js';
import { nowIso } from './util.js';
import { log } from './log.js';

const timers = [];
const every = (ms, name, fn, { immediate = false, delay = 0 } = {}) => {
  const wrapped = async () => { try { await fn(); } catch (e) { log.error(`job ${name} failed:`, e.stack || e); } };
  if (immediate) setTimeout(wrapped, delay).unref();
  timers.push(setInterval(wrapped, ms).unref());
};

export function startJobs() {
  every(10_000, 'campaigns', processCampaigns);
  every(30_000, 'email', flushOutbox);
  every(5 * 60_000, 'notification-checks', runChecks, { immediate: true, delay: 5000 });
  every(60 * 60_000, 'recurring-expenses', processRecurringExpenses, { immediate: true, delay: 3000 });
  every(60 * 60_000, 'customer-status', refreshAllCustomerStatuses, { immediate: true, delay: 4000 });
  every(10 * 60_000, 'digest', () => sendDailyDigest());
  every(6 * 60 * 60_000, 'recommendations', refreshRecommendations, { immediate: true, delay: 8000 });
  every(60 * 60_000, 'cleanup', () => {
    run('DELETE FROM sessions WHERE expires_at<?', nowIso());
    run('DELETE FROM password_resets WHERE expires_at<?', nowIso());
    run('DELETE FROM idempotency_keys WHERE created_at<?', new Date(Date.now() - 7 * 864e5).toISOString());
  });
}
export const stopJobs = () => timers.forEach(clearInterval);
