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
import './services/clicktochat.js';
import './billing/routes.js';
import './services/account.js';
import './demo.js';
import './platform.js';
import './admin.js';
import { config } from './config.js';
import { createServer } from './http.js';
import { ensureRoles } from './auth.js';
import { ensureDefaultTemplates } from './services/whatsapp.js';
import { onTenantOpen, onMigrationFailure } from './db.js';
import { control, cRun } from './control.js';
import { installPlatform } from './platform.js';
import { adminResolver } from './admin.js';
import { alertOperator } from './platformmail.js';
import { startJobs } from './jobs.js';
import { log } from './log.js';

export function buildServer({ jobs = true } = {}) {
  if (config.saas) {
    control();
    installPlatform({ adminResolver });
    onTenantOpen(() => ensureRoles());       // templates are seeded by provisioning, in the workspace's language
    onMigrationFailure((id, e) => {          // a failed migration disables ONLY that tenant, and alerts the operator
      try { cRun('UPDATE tenants SET disabled_reason=? WHERE id=?', 'migration failed: ' + String(e.message).slice(0, 200), id); } catch { /* ignore */ }
      alertOperator('migration:' + id, `Migration failed for tenant ${id}`, e.stack || e.message);
    });
  } else { ensureRoles(); ensureDefaultTemplates(); }
  const server = createServer();
  if (jobs) startJobs();
  return server;
}
export { log };
