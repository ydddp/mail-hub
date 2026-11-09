import { describe, it, expect } from 'vitest';
import { getDb, initDb } from '../src/db.js';

describe('iCloud schema', () => {
  it('stores an account with its IMAP read-side columns', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO icloud_accounts (id, apple_id, region, auth_mode, cookies, imap_user, imap_password)
       VALUES ('acc-1', 'me@icloud.com', 'global', 'cookie', 'X-APPLE=1', 'me@icloud.com', 'app-specific')`,
    ).run();

    const row = db.prepare(
      `SELECT apple_id, region, imap_host, imap_port, imap_tls, status FROM icloud_accounts WHERE id = 'acc-1'`,
    ).get() as { apple_id: string; region: string; imap_host: string; imap_port: number; imap_tls: number; status: string };

    expect(row.apple_id).toBe('me@icloud.com');
    expect(row.region).toBe('global');
    // Defaults exist so an operator only supplies the app-specific password.
    expect(row.imap_host).toBe('imap.mail.me.com');
    expect(row.imap_port).toBe(993);
    expect(row.imap_tls).toBe(1);
    expect(row.status).toBe('active');
  });

  it('rejects two addresses sharing one anonymous_id', () => {
    const db = getDb();
    db.prepare(`INSERT INTO icloud_accounts (id, apple_id) VALUES ('acc-2', 'me@icloud.com')`).run();
    db.prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('a@icloud.com', 'acc-2', 'anon-1')`,
    ).run();

    // Reconciliation adopts by anonymous_id; without this constraint a lost
    // reserve response and a later adoption would create two rows for one
    // Apple-side address.
    expect(() =>
      db.prepare(
        `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('b@icloud.com', 'acc-2', 'anon-1')`,
      ).run(),
    ).toThrow(/UNIQUE/);
  });

  it('defaults a new address to the free pool', () => {
    const db = getDb();
    db.prepare(`INSERT INTO icloud_accounts (id, apple_id) VALUES ('acc-3', 'me@icloud.com')`).run();
    db.prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('c@icloud.com', 'acc-3', 'anon-2')`,
    ).run();

    const row = db.prepare(
      `SELECT state, use_count, assigned_inbox_id, upstream_active, upstream_checked_at FROM icloud_addresses WHERE hme = 'c@icloud.com'`,
    ).get() as { state: string; use_count: number; assigned_inbox_id: string | null; upstream_active: number | null; upstream_checked_at: string | null };

    expect(row.state).toBe('free');
    expect(row.use_count).toBe(0);
    expect(row.assigned_inbox_id).toBeNull();
    expect(row.upstream_active).toBeNull();
    expect(row.upstream_checked_at).toBeNull();
    const operation = db.prepare(`SELECT * FROM icloud_addresses WHERE hme = 'c@icloud.com'`).get() as Record<string, unknown>;
    expect(operation).toMatchObject({ retire_op_id: null, retire_started_at: null, retire_lease_until: null });
  });

  it('adds unknown upstream markers to legacy assignments without changing ownership on repeated startup', () => {
    const db = getDb();
    const columns = db.pragma('table_info(icloud_addresses)') as { name: string }[];
    for (const name of ['upstream_active', 'upstream_checked_at', 'retire_op_id', 'retire_started_at', 'retire_lease_until']) {
      if (columns.some(column => column.name === name)) db.exec(`ALTER TABLE icloud_addresses DROP COLUMN ${name}`);
    }
    db.prepare(`INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state, assigned_inbox_id, assigned_at, use_count)
      VALUES ('legacy@icloud.com', 'legacy-account', 'legacy-id', 'assigned', 'legacy-inbox', '2026-10-01 00:00:00', 7)`).run();
    db.prepare(`INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state)
      VALUES ('legacy-retiring@icloud.com', 'legacy-account', 'legacy-retiring', 'retiring')`).run();
    db.close();
    initDb().close();
    initDb();

    expect(getDb().prepare(`SELECT state, assigned_inbox_id, assigned_at, use_count, upstream_active, upstream_checked_at
      FROM icloud_addresses WHERE hme = 'legacy@icloud.com'`).get()).toEqual({
      state: 'assigned', assigned_inbox_id: 'legacy-inbox', assigned_at: '2026-10-01 00:00:00', use_count: 7,
      upstream_active: null, upstream_checked_at: null,
    });
    expect(getDb().prepare(`SELECT state, upstream_active, upstream_checked_at FROM icloud_addresses
      WHERE hme = 'legacy-retiring@icloud.com'`).get()).toEqual({ state: 'retiring', upstream_active: null, upstream_checked_at: null });
    expect(getDb().prepare(`SELECT retire_op_id, retire_started_at, retire_lease_until FROM icloud_addresses
      WHERE hme = 'legacy-retiring@icloud.com'`).get()).toEqual({ retire_op_id: null, retire_started_at: null, retire_lease_until: null });
  });
});
