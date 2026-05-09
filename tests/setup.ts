import { afterAll, beforeAll, beforeEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import type { RateLimitStatus } from '../src/rate-limiter.js';

process.env.API_SECRET = 'admin-secret';
process.env.DB_PATH = resolve(process.cwd(), 'data/test-mail.db');

let initDb: () => Database.Database;
let getDb: () => Database.Database;
let registerAllProviders: () => void;
let rateLimiter: { reset(): void; getCreateStatus(provider: string): RateLimitStatus };

beforeAll(async () => {
  ({ initDb, getDb } = await import('../src/db.js'));
  ({ registerAllProviders } = await import('../src/providers/index.js'));
  ({ rateLimiter } = await import('../src/rate-limiter.js'));

  if (existsSync(process.env.DB_PATH!)) unlinkSync(process.env.DB_PATH!);
  initDb();
});

beforeEach(() => {
  const db = getDb();
  for (const table of [
    'inboxes',
    'blocks',
    'provider_stats',
    'provider_config',
    'outlook_accounts',
    'yyds_accounts',
    'yyds_domain_cache',
    'imap_accounts',
    'settings',
    'api_keys',
    'fail_log',
    'block_rules',
    'activity_log',
    'template_providers',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  registerAllProviders();
  rateLimiter.reset();
});

afterAll(() => {
  try { getDb().close(); } catch (error) {
    console.warn('Failed to close test database', error);
  }
  if (process.env.DB_PATH && existsSync(process.env.DB_PATH)) {
    unlinkSync(process.env.DB_PATH);
  }
  for (const suffix of ['-wal', '-shm']) {
    const path = `${process.env.DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
});
