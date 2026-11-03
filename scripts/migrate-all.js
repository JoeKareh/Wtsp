// Run pending migrations on EVERY workspace now (instead of lazily on first request). Safe to repeat. Failed workspaces are listed, others are unaffected.
import { cAll, control } from '../server/control.js';
import { withTenant, conn, closeTenant, clearTenantFailure } from '../server/db.js';
import { config } from '../server/config.js';
if (!config.saas) { console.log('Single-business mode: the database migrates when the app starts.'); process.exit(0); }
control(); let ok = 0; const failed = [];
for (const t of cAll("SELECT id, subdomain FROM tenants WHERE purged_at IS NULL AND status<>'deleted' ORDER BY id")) {
  try { clearTenantFailure(t.id); withTenant(t.id, () => conn(), t); ok++; } catch (e) { failed.push(`${t.subdomain} (${t.id}): ${e.message}`); } finally { closeTenant(t.id); }
}
console.log(`Migrated ${ok} workspaces.`); if (failed.length) { console.error(`FAILED (${failed.length}):\n  ` + failed.join('\n  ')); process.exit(2); }
