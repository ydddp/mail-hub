import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import { config } from './config.js';
import { hashApiKey, encryptApiKey } from './crypto.js';
import { createLogger } from './logger.js';
import { errorMessage } from './errors.js';
import { foldAsciiCase } from './mail-address.js';
import { parseTimestamp } from './time.js';

const log = createLogger('db');

let db: Database.Database;

/** SQLite lower() and this funnel both fold ASCII only. Match JS trim in SQL. */
export function canonicalImapAddress(value: string): string {
  const separator = value.indexOf('@');
  const trimmed = separator < 0 ? value.trim()
    : `${value.slice(0, separator).trim()}@${value.slice(separator + 1).trim()}`;
  return foldAsciiCase(trimmed);
}

function imapAddressSql(column: string): string {
  const whitespace = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
  const separator = `instr(${column}, '@')`;
  return `lower(CASE WHEN ${separator} = 0 THEN trim(${column}, ${whitespace})
    ELSE trim(substr(${column}, 1, ${separator} - 1), ${whitespace}) || '@'
      || trim(substr(${column}, ${separator} + 1), ${whitespace}) END)`;
}

export const IMAP_ADDRESS_KEY_SQL = imapAddressSql('address');

export interface ImapLeaseWindow {
  created_at: string;
  closed_at: string | null;
  expires_at: string | null;
}

/** Missing bounds cannot prove separation; equal endpoints allow adjacent reuse. */
export function imapLeasesOverlap(a: ImapLeaseWindow, b: ImapLeaseWindow): boolean {
  const bounds = (lease: ImapLeaseWindow) => {
    const created = parseTimestamp(lease.created_at);
    const ends = [parseTimestamp(lease.closed_at), parseTimestamp(lease.expires_at)].filter(Number.isFinite);
    return [Number.isFinite(created) ? created : -Infinity, ends.length ? Math.min(...ends) : Infinity];
  };
  const [aStart, aEnd] = bounds(a);
  const [bStart, bEnd] = bounds(b);
  return aStart < aEnd && bStart < bEnd && aStart < bEnd && bStart < aEnd;
}

function guardImapAddresses(database: Database.Database): void {
  // Triggers preserve pre-existing duplicates while guarding every subsequent
  // writer atomically. A unique index would prevent startup on legacy data.
  database.exec(`
    CREATE TABLE IF NOT EXISTS imap_ambiguous_leases (inbox_id TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS idx_inboxes_imap_active_address
      ON inboxes(${IMAP_ADDRESS_KEY_SQL}) WHERE provider = 'imap' AND status = 'active';
    CREATE TRIGGER IF NOT EXISTS imap_active_address_insert
    BEFORE INSERT ON inboxes WHEN NEW.provider = 'imap' AND NEW.status = 'active'
    BEGIN
      SELECT RAISE(ABORT, 'IMAP active address conflict') WHERE EXISTS (
        SELECT 1 FROM inboxes WHERE provider = 'imap' AND status = 'active'
          AND ${IMAP_ADDRESS_KEY_SQL} = ${imapAddressSql('NEW.address')}
      );
    END;
    CREATE TRIGGER IF NOT EXISTS imap_active_address_update
    BEFORE UPDATE OF address, provider, status ON inboxes
    WHEN NEW.provider = 'imap' AND NEW.status = 'active'
    BEGIN
      SELECT RAISE(ABORT, 'IMAP active address conflict') WHERE EXISTS (
        SELECT 1 FROM inboxes WHERE provider = 'imap' AND status = 'active' AND id != OLD.id
          AND ${IMAP_ADDRESS_KEY_SQL} = ${imapAddressSql('NEW.address')}
      );
    END;
  `);

  const duplicates = allRows<{ address: string; count: number; inbox_ids: string }>(database, `
    SELECT ${IMAP_ADDRESS_KEY_SQL} AS address, COUNT(*) AS count, json_group_array(id) AS inbox_ids
    FROM (SELECT id, address FROM inboxes WHERE provider = 'imap' AND status = 'active' ORDER BY id)
    GROUP BY ${IMAP_ADDRESS_KEY_SQL} HAVING COUNT(*) > 1 ORDER BY address
  `);
  if (duplicates.length > 0) {
    const groups = duplicates.map(({ address, count, inbox_ids }) => ({ address, count, inboxIds: JSON.parse(inbox_ids) as string[] }));
    const quarantine = database.prepare('INSERT OR IGNORE INTO imap_ambiguous_leases (inbox_id) VALUES (?)');
    database.transaction(() => {
      for (const group of groups) {
        const leases = allRows<ImapLeaseWindow & { id: string }>(database,
          `SELECT id, created_at, closed_at, expires_at FROM inboxes WHERE provider = 'imap' AND status = 'active' AND ${IMAP_ADDRESS_KEY_SQL} = ?`, group.address);
        for (let i = 0; i < leases.length; i++) for (const other of leases.slice(i + 1)) {
          if (imapLeasesOverlap(leases[i], other)) { quarantine.run(leases[i].id); quarantine.run(other.id); }
        }
      }
    })();
    log.warn('ambiguous active IMAP addresses', {
      groupCount: groups.length,
      inboxCount: groups.reduce((count, group) => count + group.count, 0),
      groups,
    });
  }
}

export const DEFAULT_SETTINGS = {
  backup_enabled: '1',
  backup_interval_hours: '6',
  backup_max_count: '5',
  retention_activity_days: '30',
  retention_faillog_days: '7',
  retention_inbox_days: '7',
  proxy_url: '',
  batch_concurrency: '5',
  icloud_pool_enabled: '1',
  icloud_pool_target: '10',
  icloud_pool_interval_minutes: '15',
} as const;

export type BackupInfo = {
  filename: string;
  size: number;
  createdAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS batch_jobs_running_pool ON batch_jobs(pool) WHERE status = 'running';

-- Asset recovery rows are permanent; inbox retention must never cascade here.
CREATE TABLE IF NOT EXISTS creation_recoveries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('attempting','upstream_created','auth_pending','ready','claimed','outcome_unknown')),
  config_snapshot TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  api_base TEXT NOT NULL,
  variables_json TEXT NOT NULL,
  address TEXT NOT NULL,
  auth_data TEXT NOT NULL,
  response_history_json TEXT NOT NULL DEFAULT '[]',
  credential_checkpoint_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  upstream_created_at TEXT,
  requested_inbox_id TEXT,
  claimed_inbox_id TEXT,
  claimed_at TEXT,
  last_status INTEGER,
  operation_id TEXT,
  operation_lease_until TEXT
);
CREATE INDEX IF NOT EXISTS creation_recoveries_phase ON creation_recoveries(phase, created_at);
CREATE TRIGGER IF NOT EXISTS creation_recovery_immutable_snapshot
BEFORE UPDATE OF provider, config_snapshot, config_fingerprint, api_base, variables_json, created_at, expires_at, requested_inbox_id ON creation_recoveries
BEGIN SELECT RAISE(ABORT, 'Creation recovery snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS creation_recovery_permanent_claim
BEFORE UPDATE OF claimed_inbox_id ON creation_recoveries
WHEN OLD.claimed_inbox_id IS NOT NULL AND NEW.claimed_inbox_id IS NOT OLD.claimed_inbox_id
BEGIN SELECT RAISE(ABORT, 'Creation recovery was already claimed'); END;

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
  closed_at TEXT,
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

CREATE TABLE IF NOT EXISTS dispatch_rules (
  service TEXT PRIMARY KEY,
  order_json TEXT NOT NULL,
  others TEXT NOT NULL DEFAULT 'append',
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
  assigned_at TEXT,
  group_name TEXT DEFAULT '未分组',
  account_type TEXT NOT NULL DEFAULT 'short',
  last_checked_at TEXT,
  oauth_last_session_id TEXT,
  oauth_last_error TEXT,
  used_services TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Private append-only token response assets; deliberately no cascading FK.
CREATE TABLE IF NOT EXISTS outlook_credential_checkpoints (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  email TEXT,
  issuing_client_id TEXT NOT NULL,
  origin_refresh_fingerprint TEXT NOT NULL,
  origin_oauth_session_id TEXT,
  source TEXT NOT NULL,
  http_status INTEGER,
  received_at TEXT NOT NULL,
  credentials_json TEXT NOT NULL,
  raw_response TEXT
);

CREATE TABLE IF NOT EXISTS outlook_oauth_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  tenant TEXT NOT NULL,
  preset TEXT NOT NULL DEFAULT 'custom',
  state_hash TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  automation_status TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS service_stats (
  name TEXT PRIMARY KEY,
  inbox_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  first_used_at TEXT,
  last_used_at TEXT
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

CREATE TABLE IF NOT EXISTS icloud_accounts (
  id TEXT PRIMARY KEY,
  apple_id TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'global',
  auth_mode TEXT NOT NULL DEFAULT 'cookie',
  cookies TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  trust_token TEXT NOT NULL DEFAULT '',
  hme_service_url TEXT NOT NULL DEFAULT '',
  pool_cooldown_until TEXT,
  imap_host TEXT NOT NULL DEFAULT 'imap.mail.me.com',
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_user TEXT NOT NULL DEFAULT '',
  imap_password TEXT NOT NULL DEFAULT '',
  imap_tls INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS icloud_addresses (
  hme TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'free',
  assigned_inbox_id TEXT,
  assigned_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  upstream_active INTEGER,
  upstream_checked_at TEXT,
  retire_op_id TEXT,
  retire_started_at INTEGER,
  retire_lease_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_icloud_addresses_free
  ON icloud_addresses (account_id, state);

CREATE TABLE IF NOT EXISTS icloud_auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_mfa',
  error TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDb(): Database.Database {
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  // Created accounts and issued tokens are permanent assets that cannot be
  // re-imported or safely reissued after a lost commit. FULL syncs the WAL on
  // every commit, including private recovery/checkpoint writes. Durability
  // still depends on the underlying storage honoring synchronization calls.
  db.pragma('synchronous = FULL');

  db.exec(SCHEMA);
  // A create may have committed just before the process stopped. Do not replay
  // the write or assume it failed merely because its response was not saved.
  db.prepare(`UPDATE creation_recoveries SET phase = 'outcome_unknown', updated_at = ? WHERE phase = 'attempting'`)
    .run(new Date().toISOString());
  // A process restart cannot safely replay an in-flight refresh-token rotation.
  db.prepare(`UPDATE batch_jobs SET status = 'interrupted', error = 'Server restarted; unfinished accounts were not retried', updated_at = ? WHERE status = 'running'`)
    .run(new Date().toISOString());

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
    `ALTER TABLE outlook_accounts ADD COLUMN api_type TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE outlook_accounts ADD COLUMN oauth_last_session_id TEXT`,
    `ALTER TABLE outlook_accounts ADD COLUMN oauth_last_error TEXT`,
    `ALTER TABLE outlook_oauth_sessions ADD COLUMN preset TEXT NOT NULL DEFAULT 'custom'`,
    // When a lease actually ended. expires_at is only ever the PLANNED end, so
    // an early manual close leaves it in the future; the mailbox view needs the
    // real boundary to tell "arrived during this lease" from "arrived after it
    // was released". NULL on rows closed before this column existed, which
    // callers must read as "end unknown", not "still open".
    `ALTER TABLE inboxes ADD COLUMN closed_at TEXT`,
    // When the account was claimed for its current inbox. The orphan reaper
    // needs it to spare a just-claimed account whose inbox row is milliseconds
    // from being written; icloud_addresses has carried the same column from
    // birth for the same reason.
    `ALTER TABLE outlook_accounts ADD COLUMN assigned_at TEXT`,
    // An authorization code may issue credentials just as its account/session
    // is superseded. Retain those paid credentials separately from the guarded
    // account commit; this sensitive checkpoint is never part of public status.
    `ALTER TABLE outlook_oauth_sessions ADD COLUMN credential_checkpoint TEXT`,
    // Old rows are unknown until a complete successful Apple LIST verifies them.
    `ALTER TABLE icloud_addresses ADD COLUMN upstream_active INTEGER`,
    `ALTER TABLE icloud_addresses ADD COLUMN upstream_checked_at TEXT`,
    // Milliseconds from Date.now(), shared by acquisition and all lease fences.
    // NULL legacy operations are recovered only after a complete Apple LIST.
    `ALTER TABLE icloud_addresses ADD COLUMN retire_op_id TEXT`,
    `ALTER TABLE icloud_addresses ADD COLUMN retire_started_at INTEGER`,
    `ALTER TABLE icloud_addresses ADD COLUMN retire_lease_until INTEGER`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) {
      const message = errorMessage(e);
      if (!message.includes('duplicate column')) log.warn('migration failed', { error: e });
    }
  }

  guardImapAddresses(db);

  removeNullProviderConfigRows(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inboxes_status ON inboxes(status);
    CREATE INDEX IF NOT EXISTS idx_inboxes_provider_address ON inboxes(provider, address);
    CREATE INDEX IF NOT EXISTS idx_inboxes_owner ON inboxes(owner_key);
    CREATE INDEX IF NOT EXISTS idx_inboxes_service ON inboxes(target_service);
    CREATE INDEX IF NOT EXISTS idx_inboxes_expires ON inboxes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_fail_log_reported ON fail_log(reported_at);
    CREATE INDEX IF NOT EXISTS idx_fail_log_service ON fail_log(service, domain);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_outlook_assigned ON outlook_accounts(assigned_inbox_id);
    CREATE INDEX IF NOT EXISTS idx_outlook_status ON outlook_accounts(token_status);
    CREATE INDEX IF NOT EXISTS idx_outlook_oauth_email ON outlook_oauth_sessions(email);
    CREATE INDEX IF NOT EXISTS idx_outlook_oauth_state ON outlook_oauth_sessions(state_hash);
    CREATE INDEX IF NOT EXISTS idx_outlook_oauth_status ON outlook_oauth_sessions(status);
  `);

  seedServiceStats(db);

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

// Seed durable service stats from whatever history is still retained. Runs
// every boot but ON CONFLICT DO NOTHING makes it a no-op for services that
// already have a row — live bumps (bumpServiceCreated/bumpServiceReported)
// own the counters from then on, so purging old inboxes/fail_log rows no
// longer erases a service from the stats.
export function seedServiceStats(database: Database.Database): void {
  database.exec(`
    INSERT INTO service_stats (name, inbox_count, fail_count, first_used_at, last_used_at)
    SELECT i.target_service, COUNT(*),
      (SELECT COUNT(*) FROM fail_log f WHERE f.service = i.target_service),
      MIN(i.created_at), MAX(i.created_at)
    FROM inboxes i
    WHERE i.target_service IS NOT NULL AND i.target_service != ''
    GROUP BY i.target_service
    ON CONFLICT(name) DO NOTHING;

    INSERT INTO service_stats (name, fail_count, first_used_at, last_used_at)
    SELECT f.service, COUNT(*), MIN(f.reported_at), MAX(f.reported_at)
    FROM fail_log f
    WHERE f.service != ''
    GROUP BY f.service
    ON CONFLICT(name) DO NOTHING;
  `);
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

export function bumpServiceCreated(name: string): void {
  const service = typeof name === 'string' ? name.trim() : '';
  if (!service) return;
  getDb().prepare(`
    INSERT INTO service_stats (name, inbox_count, first_used_at, last_used_at)
    VALUES (?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      inbox_count = inbox_count + 1,
      last_used_at = datetime('now')
  `).run(service);
}

export function bumpServiceReported(name: string, success: boolean): void {
  const service = typeof name === 'string' ? name.trim() : '';
  if (!service) return;
  // Column picked from a boolean, never from user input.
  const column = success ? 'success_count' : 'fail_count';
  getDb().prepare(`
    INSERT INTO service_stats (name, ${column}, first_used_at, last_used_at)
    VALUES (?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(name) DO UPDATE SET ${column} = ${column} + 1
  `).run(service);
}

// `provider TEXT PRIMARY KEY` is not NOT NULL in SQLite, so a registration
// with an undefined name once inserted thousands of NULL-keyed rows (the
// WHERE provider = ? existence check never matches NULL). The registry now
// rejects such names; this removes what earlier builds left behind.
export function removeNullProviderConfigRows(database: Database.Database): number {
  return database.prepare(`DELETE FROM provider_config WHERE provider IS NULL`).run().changes;
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
      log.warn('failed to prune backup', { filename: backup.filename, error: e });
    }
  }
}

export function logActivity(type: string, text: string): void {
  db.prepare(`INSERT INTO activity_log (type, text) VALUES (?, ?)`).run(type, text);
}
