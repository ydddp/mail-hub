import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import { config } from './config.js';
import { hashApiKey, encryptApiKey } from './crypto.js';
import { createLogger } from './logger.js';
import { errorMessage } from './errors.js';

const log = createLogger('db');

let db: Database.Database;

export const DEFAULT_SETTINGS = {
  backup_enabled: '1',
  backup_interval_hours: '6',
  backup_max_count: '5',
  retention_activity_days: '30',
  retention_faillog_days: '7',
  retention_inbox_days: '7',
  proxy_url: '',
} as const;

export type BackupInfo = {
  filename: string;
  size: number;
  createdAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inboxes (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  address TEXT NOT NULL,
  auth_data TEXT NOT NULL,
  api_base TEXT,
  target_service TEXT,
  owner_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  domain TEXT NOT NULL,
  provider TEXT,
  blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT,
  UNIQUE(service, domain)
);

CREATE TABLE IF NOT EXISTS provider_stats (
  provider TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provider_config (
  provider TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outlook_accounts (
  email TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  token_status TEXT DEFAULT '',
  token_renewed_at TEXT,
  assigned_inbox_id TEXT,
  group_name TEXT DEFAULT '未分组',
  account_type TEXT NOT NULL DEFAULT 'short',
  last_checked_at TEXT,
  used_services TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS yyds_accounts (
  api_key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'active',
  supports_wildcard INTEGER,
  inbox_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  daily_calls INTEGER DEFAULT 0,
  daily_reset_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS yyds_domain_cache (
  domain TEXT PRIMARY KEY,
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  call_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS block_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL DEFAULT '*',
  provider TEXT NOT NULL DEFAULT '*',
  threshold INTEGER NOT NULL DEFAULT 3,
  window_hours INTEGER NOT NULL DEFAULT 24,
  scope TEXT NOT NULL DEFAULT 'per_service',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  provider TEXT NOT NULL,
  domain TEXT NOT NULL,
  reported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'blue',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_providers (
  name TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imap_accounts (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  user TEXT NOT NULL,
  password TEXT NOT NULL,
  domain TEXT NOT NULL,
  tls INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDb(): Database.Database {
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(SCHEMA);

  const migrations = [
    `ALTER TABLE outlook_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'short'`,
    `ALTER TABLE outlook_accounts ADD COLUMN last_checked_at TEXT`,
    `ALTER TABLE outlook_accounts ADD COLUMN used_services TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE block_rules ADD COLUMN scope TEXT NOT NULL DEFAULT 'per_service'`,
    `ALTER TABLE yyds_accounts ADD COLUMN daily_calls INTEGER DEFAULT 0`,
    `ALTER TABLE yyds_accounts ADD COLUMN daily_reset_at TEXT`,
    `ALTER TABLE provider_config ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE inboxes ADD COLUMN owner_key TEXT`,
    `ALTER TABLE block_rules ADD COLUMN domain_level INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE api_keys ADD COLUMN key_encrypted TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE api_keys ADD COLUMN daily_limit INTEGER`,
    `ALTER TABLE api_keys ADD COLUMN daily_calls INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE api_keys ADD COLUMN daily_reset_at TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) {
      const message = errorMessage(e);
      if (!message.includes('duplicate column')) log.warn('migration failed', { error: message });
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inboxes_status ON inboxes(status);
    CREATE INDEX IF NOT EXISTS idx_inboxes_owner ON inboxes(owner_key);
    CREATE INDEX IF NOT EXISTS idx_inboxes_service ON inboxes(target_service);
    CREATE INDEX IF NOT EXISTS idx_inboxes_expires ON inboxes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_fail_log_reported ON fail_log(reported_at);
    CREATE INDEX IF NOT EXISTS idx_fail_log_service ON fail_log(service, domain);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_outlook_assigned ON outlook_accounts(assigned_inbox_id);
    CREATE INDEX IF NOT EXISTS idx_outlook_status ON outlook_accounts(token_status);
  `);

  if (config.apiSecret) {
    const unmigrated = allRows<{ key: string }>(db, `SELECT key FROM api_keys WHERE key LIKE 'mk_%'`);
    for (const { key: plainKey } of unmigrated) {
      const hashed = hashApiKey(plainKey);
      const encrypted = encryptApiKey(plainKey, config.apiSecret);
      db.prepare(`UPDATE api_keys SET key = ?, key_encrypted = ? WHERE key = ?`).run(hashed, encrypted, plainKey);
      db.prepare(`UPDATE inboxes SET owner_key = ? WHERE owner_key = ?`).run(hashed, plainKey);
    }
    if (unmigrated.length > 0) {
      log.info('migrated API keys to hash storage', { count: unmigrated.length });
    }
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function getRow<T>(database: Database.Database, sql: string, ...params: unknown[]): T | undefined {
  return database.prepare(sql).get(...params) as T | undefined;
}

export function allRows<T>(database: Database.Database, sql: string, ...params: unknown[]): T[] {
  return database.prepare(sql).all(...params) as T[];
}

export function getSetting(key: string, defaultValue = ''): string {
  const row = getRow<{ value: string }>(getDb(), `SELECT value FROM settings WHERE key = ?`, key);
  return row?.value ?? defaultValue;
}

export function buildSetClause(body: Record<string, unknown>, fieldMap: Record<string, (v: unknown) => unknown>): { setClause: string; params: unknown[] } | null {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [field, mapper] of Object.entries(fieldMap)) {
    if (body[field] !== undefined) {
      clauses.push(`${field} = ?`);
      params.push(mapper(body[field]));
    }
  }
  if (clauses.length === 0) return null;
  return { setClause: clauses.join(', '), params };
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function backupDir(): string {
  return join(dirname(config.dbPath), 'backups');
}

function backupPath(filename: string): string {
  if (filename !== basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid backup filename');
  }
  if (!/^mail-[0-9TZ-]+\.db$/.test(filename)) {
    throw new Error('Invalid backup filename');
  }
  return join(backupDir(), filename);
}

function backupInfo(filename: string): BackupInfo {
  const st = statSync(join(backupDir(), filename));
  return {
    filename,
    size: st.size,
    createdAt: st.birthtime.toISOString(),
  };
}

export async function backupDb(): Promise<BackupInfo> {
  const dir = backupDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `mail-${timestamp}.db`;
  await getDb().backup(join(dir, filename));
  pruneBackups();
  return backupInfo(filename);
}

export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((filename) => /^mail-[0-9TZ-]+\.db$/.test(filename))
    .map(backupInfo)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteBackup(filename: string): void {
  unlinkSync(backupPath(filename));
}

function pruneBackups(): void {
  const maxCount = Math.max(1, parseInt(getSetting('backup_max_count', DEFAULT_SETTINGS.backup_max_count), 10) || 5);
  const backups = listBackups();
  for (const backup of backups.slice(maxCount)) {
    try {
      deleteBackup(backup.filename);
    } catch (e) {
      log.warn('failed to prune backup', { filename: backup.filename, error: errorMessage(e) });
    }
  }
}

export function logActivity(type: string, text: string): void {
  db.prepare(`INSERT INTO activity_log (type, text) VALUES (?, ?)`).run(type, text);
}
