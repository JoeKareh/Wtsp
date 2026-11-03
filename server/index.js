import { config } from './config.js';
import { buildServer, log } from './app.js';

const server = buildServer();
server.listen(config.port, config.host, () => {
  log.info(`BizControl running at ${config.baseUrl}  (database: ${config.dbPath})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log.info('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
