import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createTestDatabasePath, assertTestPath } from './helpers/test-storage.js';
import type Database from 'better-sqlite3';
import type { RateLimitStatus } from '../src/rate-limiter.js';

process.env.API_SECRET = 'admin-secret';
// Setup runs before the suite's static imports. Each suite gets a new file,
// so a cached SQLite handle can never refer to a file another suite unlinks.
process.env.DB_PATH = createTestDatabasePath();

let initDb: () => Database.Database;
let getDb: () => Database.Database;
let registerAllProviders: () => void;
let rateLimiter: { reset(): void; getCreateStatus(provider: string): RateLimitStatus };
let resetTokenCache: () => void;
let resetRenewalAttempts: () => void;

beforeAll(async () => {
  ({ initDb, getDb } = await import('../src/db.js'));
  ({ registerAllProviders } = await import('../src/providers/index.js'));
  ({ rateLimiter } = await import('../src/rate-limiter.js'));
  ({ resetTokenCache } = await import('../src/providers/outlook.js'));
  ({ resetRenewalAttempts } = await import('../src/providers/icloud-pool.js'));

  assertTestPath(process.env.DB_PATH!);
  initDb();
});

beforeEach(() => {
  const db = getDb();
  for (const table of [
    'batch_jobs',
    'creation_recoveries',
    'imap_ambiguous_leases',
    'inboxes',
    'blocks',
    'provider_stats',
    'provider_config',
    'dispatch_rules',
    'outlook_accounts',
    'outlook_oauth_sessions',
    'outlook_credential_checkpoints',
    'yyds_accounts',
    'yyds_domain_cache',
    'imap_accounts',
    'icloud_accounts',
    'icloud_addresses',
    'icloud_auth_sessions',
    'settings',
    'api_keys',
    'fail_log',
    'service_stats',
    'block_rules',
    'activity_log',
    'template_providers',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  registerAllProviders();
  rateLimiter.reset();
  resetTokenCache();
  resetRenewalAttempts();
});

afterAll(() => {
  getDb().close();
  // The reporter cleans up only a wholly successful run. A failing test or
  // hook keeps the DB, WAL, backups and auth files together for inspection.
});
