import 'dotenv/config';
import { serve } from '@hono/node-server';
import { assertValidConfig, config } from './config.js';
import { getDb, initDb } from './db.js';
import { registerAllProviders } from './providers/index.js';
import { cleanupExpired, createApp } from './app.js';
import { createLogger } from './logger.js';
import { logIgnoredError } from './errors.js';
import { startBackupScheduler, stopBackupScheduler } from './backup-scheduler.js';

const log = createLogger('server');

async function main() {
  assertValidConfig(config);
  initDb();
  registerAllProviders();

  void cleanupExpired();
  const cleanupInterval = setInterval(() => void cleanupExpired(), 60 * 60 * 1000);
  startBackupScheduler();

  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info('Mail Hub started', { host: info.address, port: info.port });
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down');
    clearInterval(cleanupInterval);
    stopBackupScheduler();
    server.close(() => {
      try { getDb().close(); } catch (error) {
        logIgnoredError(log, 'database close failed during shutdown', error);
      }
      log.info('shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('forced exit after timeout');
      process.exit(1);
    }, 10000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log.error('failed to start', { error: String(e) });
  process.exit(1);
});
