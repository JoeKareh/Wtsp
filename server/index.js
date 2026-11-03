import { config } from './config.js';
import { buildServer, log } from './app.js';
import { initSentry } from './sentry.js';
import { shutdown } from './shutdown.js';

if (initSentry()) log.info('Sentry error reporting enabled');
const server = buildServer();
server.listen(config.port, config.host, () => {
  log.info(`BizControl running at ${config.baseUrl}  (${config.saas ? 'hosted mode, domain ' + config.appDomain : 'database: ' + config.dbPath})`);
});

// Graceful shutdown: stop being "ready" (so the proxy stops sending traffic), finish in-flight requests and jobs, close databases cleanly.
let stopping = false;
async function stop(sig) {
  if (stopping) return; stopping = true; shutdown.draining = true; log.info(`${sig} received: draining`);
  const hard = setTimeout(() => { log.warn('forced exit after timeout'); process.exit(1); }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 25_000)); hard.unref();
  await new Promise((r) => setTimeout(r, Number(process.env.SHUTDOWN_GRACE_MS || 1500)));   // let the load balancer notice /readyz = 503
  const closed = new Promise((r) => server.close(r)); server.closeIdleConnections?.();
  try { const jobs = await import('./jobs.js'); jobs.stopJobs(); const left = await jobs.drainJobs(10_000); if (left) log.warn(`${left} jobs still running at shutdown`); } catch (e) { log.error('job drain failed', e); }
  await Promise.race([closed, new Promise((r) => setTimeout(r, 8000))]);
  try { (await import('./db.js')).closeAllTenants(); (await import('./control.js')).closeControl(); } catch (e) { log.error('close failed', e); }
  log.info('stopped cleanly'); process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e instanceof Error ? e : new Error(String(e))));
process.on('uncaughtException', (e) => { log.error('uncaughtException', e); setTimeout(() => process.exit(1), 500); });
