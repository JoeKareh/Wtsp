// Assembles the application: database, routes, background jobs.
import './db.js';
import './auth.js';
import './services/customers.js';
import './services/inventory.js';
import './services/orders.js';
import './services/payments.js';
import './services/expenses.js';
import './services/finance.js';
import './services/analytics.js';
import './services/notifications.js';
import './services/whatsapp.js';
import './services/recommendations.js';
import './services/reports.js';
import './services/settings.js';
import { createServer } from './http.js';
import { ensureRoles } from './auth.js';
import { ensureDefaultTemplates } from './services/whatsapp.js';
import { startJobs } from './jobs.js';
import { log } from './log.js';

export function buildServer({ jobs = true } = {}) {
  ensureRoles();
  ensureDefaultTemplates();
  const server = createServer();
  if (jobs) startJobs();
  return server;
}
export { log };
