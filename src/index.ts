import 'dotenv/config';
import { serve } from '@hono/node-server';
import { assertValidConfig, config } from './config.js';
import { DEFAULT_SETTINGS, backupDb, getDb, getSetting, initDb } from './db.js';
import { registerAllProviders } from './providers/index.js';
import { cleanupExpired, createApp } from './app.js';
import { createLogger } from './logger.js';
import { errorMessage, logIgnoredError } from './errors.js';

const log = createLogger('server');
const backupLog = createLogger('backup');

let backupTimer: NodeJS.Timeout | undefined;

function scheduleBackup(): void {
  const hours = Math.max(1, parseInt(getSetting('backup_interval_hours', DEFAULT_SETTINGS.backup_interval_hours), 10) || 6);
  backupTimer = setTimeout(async () => {
    try {
      if (getSetting('backup_enabled', DEFAULT_SETTINGS.backup_enabled) !== '0') {
        const backup = await backupDb();
        backupLog.info('database backup complete', { filename: backup.filename, size: backup.size });
      } else {
        backupLog.info('automatic backup skipped');
      }
    } catch (e) {
      backupLog.error('database backup failed', { error: errorMessage(e) });
    } finally {
      scheduleBackup();
    }
  }, hours * 60 * 60 * 1000);
}

async function main() {
  assertValidConfig(config);
  initDb();
  registerAllProviders();

  void cleanupExpired();
  const cleanupInterval = setInterval(() => void cleanupExpired(), 60 * 60 * 1000);
  scheduleBackup();

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
    if (backupTimer) clearTimeout(backupTimer);
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
