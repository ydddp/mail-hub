import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpired } from '../src/app.js';
import { getDb, getRow, setSetting } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { IcloudProvider } from '../src/providers/icloud.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type EndAge = number | null | 'invalid';
type EndFormat = 'sqlite' | 'iso' | 'offset' | 'rfc';

function endTimestamp(daysAgo: EndAge, format: EndFormat = 'sqlite'): string | null {
  if (daysAgo === null) return null;
  if (daysAgo === 'invalid') return 'not-a-date';
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  if (format === 'rfc') return date.toUTCString();
  if (format === 'offset') return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 19) + '+09:00';
  return format === 'iso' ? date.toISOString() : date.toISOString().slice(0, 19).replace('T', ' ');
}

function insertHistoryInbox(id: string, closedAt: string | null, expiresAt: string | null, status = 'closed', provider = 'fake'): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, created_at, closed_at, expires_at, status)
     VALUES (?, ?, 'history@example.test', '{}', '', datetime('now', '-120 days'), ?, ?, ?)`,
  ).run(id, provider, closedAt, expiresAt, status);
}

function insertShortAccount(email: string, refreshToken: string): void {
  getDb().prepare(
    `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status, account_type)
     VALUES (?, 'pw', 'client-id', ?, 'valid', 'short')`,
  ).run(email, refreshToken);
}

describe('expired inbox cleanup', () => {
  it.each([null, 1, 0])('releases expired iCloud ownership with marker %s and fences the later purge replay', async active => {
    const db = getDb();
    setSetting('retention_inbox_days', '30');
    db.prepare(`INSERT INTO icloud_accounts (id, apple_id) VALUES ('icloud-owner', 'owner@icloud.com')`).run();
    db.prepare(`INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at)
      VALUES ('icloud-expired', 'icloud', 'expired@icloud.com', ?, 'https://www.icloud.com', datetime('now', '-1 hour'))`)
      .run(JSON.stringify({ icloudAccountId: 'icloud-owner', hme: 'expired@icloud.com', anonymousId: 'expired' }));
    db.prepare(`INSERT INTO icloud_addresses
      (hme, account_id, anonymous_id, state, assigned_inbox_id, assigned_at, upstream_active)
      VALUES ('expired@icloud.com', 'icloud-owner', 'expired', 'assigned', 'icloud-expired', '2026-01-01', ?)`).run(active);
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    await cleanupExpired();
    expect(db.prepare(`SELECT state, assigned_inbox_id, assigned_at FROM icloud_addresses`).get()).toEqual({
      state: active === 0 ? 'retired' : 'free', assigned_inbox_id: null, assigned_at: null,
    });
    expect(db.prepare(`SELECT status FROM inboxes WHERE id = 'icloud-expired'`).get()).toEqual({ status: 'closed' });
    if (active !== 0) {
      await new IcloudProvider().createInbox({ inboxId: 'new-owner' });
      db.prepare(`INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at)
        VALUES ('new-owner', 'icloud', 'expired@icloud.com', ?, '', datetime('now', '+1 day'))`)
        .run(JSON.stringify({ icloudAccountId: 'icloud-owner', hme: 'expired@icloud.com', anonymousId: 'expired' }));
    }
    db.prepare(`UPDATE inboxes SET closed_at = datetime('now', '-31 days'), expires_at = datetime('now', '-31 days')
      WHERE id = 'icloud-expired'`).run();
    await cleanupExpired();
    expect(db.prepare(`SELECT id FROM inboxes WHERE id = 'icloud-expired'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT state, assigned_inbox_id FROM icloud_addresses`).get()).toEqual({
      state: active === 0 ? 'retired' : 'assigned', assigned_inbox_id: active === 0 ? null : 'new-owner',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each<{
    label: string; closed: EndAge; expires: EndAge; purged: boolean; status?: string; format?: EndFormat;
  }>([
    { label: 'two-day expiry with the configured thirty-day retention', closed: null, expires: 2, purged: false },
    { label: 'thirty-one-day expiry with the configured thirty-day retention', closed: null, expires: 31, purged: true },
    { label: 'old creation with a recent manual close and no expiry', closed: 2, expires: null, purged: false },
    { label: 'old manual close with no expiry', closed: 31, expires: null, purged: true },
    { label: 'old creation with a recent manual close before a future expiry', closed: 2, expires: -1, purged: false },
    { label: 'old manual close before a future expiry', closed: 31, expires: -1, purged: true },
    { label: 'expiry before a recent delayed close', closed: 2, expires: 31, purged: true },
    { label: 'manual close before a recent expiry', closed: 31, expires: 2, purged: true },
    { label: 'recent close with an invalid expiry', closed: 2, expires: 'invalid', purged: false },
    { label: 'old close with an invalid expiry', closed: 31, expires: 'invalid', purged: true },
    { label: 'recent expiry with an invalid close', closed: 'invalid', expires: 2, purged: false },
    { label: 'old expiry with an invalid close', closed: 'invalid', expires: 31, purged: true },
    { label: 'both end timestamps missing', closed: null, expires: null, purged: false },
    { label: 'both end timestamps invalid', closed: 'invalid', expires: 'invalid', purged: false },
    { label: 'missing close with an invalid expiry', closed: null, expires: 'invalid', purged: false },
    { label: 'invalid close with a missing expiry', closed: 'invalid', expires: null, purged: false },
    { label: 'ISO expiry', closed: null, expires: 31, format: 'iso', purged: true },
    { label: 'offset expiry', closed: null, expires: 31, format: 'offset', purged: true },
    { label: 'RFC expiry', closed: null, expires: 31, format: 'rfc', purged: true },
    { label: 'RFC manual close', closed: 31, expires: null, format: 'rfc', purged: true },
    { label: 'recent RFC expiry', closed: null, expires: 2, format: 'rfc', purged: false },
    { label: 'late cleanup of an active expired inbox', closed: null, expires: 31, status: 'active', purged: true },
    { label: 'an active inbox with a future expiry', closed: null, expires: -1, status: 'active', purged: false },
    { label: 'an active row even when its close field is old', closed: 31, expires: -1, status: 'active', purged: false },
  ])('applies effective-end retention to $label', async ({ closed, expires, purged, status, format }) => {
    setSetting('retention_inbox_days', '30');
    insertHistoryInbox('history-retention', endTimestamp(closed, format), endTimestamp(expires, format), status);

    await cleanupExpired();

    expect(getDb().prepare(`SELECT id FROM inboxes WHERE id = 'history-retention'`).get())
      .toEqual(purged ? undefined : { id: 'history-retention' });
  });

  it('retains and reports the count of closed rows with no known end', async () => {
    setSetting('retention_inbox_days', '30');
    for (const [index, [closed, expires]] of [
      [null, null], ['invalid', 'invalid'], [null, 'invalid'], ['invalid', null],
    ].entries()) {
      insertHistoryInbox(`unknown-end-${index}`, closed, expires);
    }
    insertHistoryInbox('known-end', endTimestamp(31), null);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await cleanupExpired();

    expect(getDb().prepare(`SELECT id FROM inboxes ORDER BY id`).all()).toEqual([
      { id: 'unknown-end-0' }, { id: 'unknown-end-1' }, { id: 'unknown-end-2' }, { id: 'unknown-end-3' },
    ]);
    const logs = output.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn', msg: 'retained closed inboxes with unknown end timestamp', count: 4,
    }));
  });

  it.each<{ label: string; status: string; closed: EndAge; expires: EndAge }>([
    { label: 'the inbox is active again', status: 'active', closed: null, expires: -1 },
    { label: 'the close time becomes recent', status: 'closed', closed: 2, expires: null },
    { label: 'the expiry becomes recent', status: 'closed', closed: null, expires: 2 },
    { label: 'the end becomes unknown', status: 'closed', closed: null, expires: null },
  ])('rechecks retention after releasing resources when $label', async ({ status, closed, expires }) => {
    const db = getDb();
    setSetting('retention_inbox_days', '30');
    insertHistoryInbox('changing-history', endTimestamp(31), null);
    insertHistoryInbox('unchanged-history', endTimestamp(31), null);
    const provider = new FakeProvider();
    registry.register(provider);
    vi.spyOn(provider, 'releaseInbox').mockImplementation(async () => {
      await Promise.resolve();
      db.prepare(`UPDATE inboxes SET status = ?, closed_at = ?, expires_at = ? WHERE id = 'changing-history'`)
        .run(status, endTimestamp(closed), endTimestamp(expires));
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await cleanupExpired();

    expect(db.prepare(`SELECT id, status FROM inboxes WHERE id = 'changing-history'`).get())
      .toEqual({ id: 'changing-history', status });
    expect(db.prepare(`SELECT id FROM inboxes WHERE id = 'unchanged-history'`).get()).toBeUndefined();
    const logs = output.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'purged expired inboxes', count: 1 }));
    expect(provider.deleteCount).toBe(0);
    registry.unregister('fake');
  });

  it('releases assigned Outlook accounts before deleting stale inboxes', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, account_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('user@outlook.com', 'pw', 'client', 'refresh', 'inbox-old', 'long');
    db.prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at, status)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-8 day'), 'closed')`,
    ).run('inbox-old', 'outlook', 'user@outlook.com', JSON.stringify({ email: 'user@outlook.com' }), '');

    await cleanupExpired();

    const assigned = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = ?`,
      'user@outlook.com',
    );
    expect(assigned?.assigned_inbox_id).toBeNull();
    const inbox = db.prepare(`SELECT id FROM inboxes WHERE id = ?`).get('inbox-old');
    expect(inbox).toBeUndefined();
  });

  it('does not call external provider deletion from scheduled cleanup', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    const db = getDb();
    db.prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at, status)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-8 day'), 'closed')`,
    ).run('fake-old', 'fake', 'old@example.test', JSON.stringify({ token: 't' }), 'https://fake.test');
    const releasedWhilePresent: boolean[] = [];
    vi.spyOn(provider, 'releaseInbox').mockImplementation(async (_inbox, inboxId) => {
      releasedWhilePresent.push(db.prepare(`SELECT id FROM inboxes WHERE id = ?`).get(inboxId) !== undefined);
    });

    await cleanupExpired();

    expect(provider.deleteCount).toBe(0);
    expect(releasedWhilePresent).toEqual([true]);
    const inbox = db.prepare(`SELECT id FROM inboxes WHERE id = ?`).get('fake-old');
    expect(inbox).toBeUndefined();
    registry.unregister('fake');
  });

  it.each(['outlook', 'icloud'])('purges old %s history without releasing its new owner', async (provider) => {
    const db = getDb();
    setSetting('retention_inbox_days', '30');
    insertHistoryInbox('previous-owner', endTimestamp(31), null, 'closed', provider);
    insertHistoryInbox('current-owner', null, endTimestamp(-1), 'active', provider);
    db.prepare(`UPDATE inboxes SET auth_data = ? WHERE id IN ('previous-owner', 'current-owner')`)
      .run(JSON.stringify({ email: 'history@example.test', hme: 'history@example.test' }));
    if (provider === 'outlook') {
      db.prepare(
        `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, assigned_at, account_type)
         VALUES ('history@example.test', 'pw', 'client', 'refresh', 'current-owner', datetime('now'), 'long')`,
      ).run();
    } else {
      db.prepare(
        `INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state, assigned_inbox_id, assigned_at)
         VALUES ('history@example.test', 'account', 'anonymous', 'assigned', 'current-owner', datetime('now'))`,
      ).run();
    }

    await cleanupExpired();

    expect(db.prepare(`SELECT id FROM inboxes WHERE id = 'previous-owner'`).get()).toBeUndefined();
    const assignment = provider === 'outlook'
      ? db.prepare(`SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'history@example.test'`).get()
      : db.prepare(`SELECT assigned_inbox_id FROM icloud_addresses WHERE hme = 'history@example.test' AND state = 'assigned'`).get();
    expect(assignment).toEqual({ assigned_inbox_id: 'current-owner' });
    expect(db.prepare(`SELECT id FROM inboxes WHERE id = 'current-owner'`).get()).toEqual({ id: 'current-owner' });
  });

  it('closes expired active inboxes and frees their Outlook account at close time', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, account_type)
       VALUES ('used@outlook.com', 'pw', 'c', 'r', 'inbox-exp', 'long')`,
    ).run();
    db.prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at, status)
       VALUES ('inbox-exp', 'outlook', 'used@outlook.com', ?, '', datetime('now', '-1 hour'), 'active')`,
    ).run(JSON.stringify({ email: 'used@outlook.com' }));

    await cleanupExpired();

    const inbox = getRow<{ status: string }>(db, `SELECT status FROM inboxes WHERE id = 'inbox-exp'`);
    expect(inbox?.status).toBe('closed');
    const account = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'used@outlook.com'`,
    );
    expect(account?.assigned_inbox_id).toBeNull();
  });

  it('releases Outlook assignments pointing at inboxes that no longer exist', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, account_type)
       VALUES ('ghost@outlook.com', 'pw', 'c', 'r', 'ghost-inbox', 'long')`,
    ).run();

    await cleanupExpired();

    const account = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'ghost@outlook.com'`,
    );
    expect(account?.assigned_inbox_id).toBeNull();
  });

  it('spares an Outlook account claimed moments ago whose inbox row is still coming', async () => {
    const db = getDb();
    // The dispatcher claims the account first and writes the inbox row moments
    // later; a cleanup firing in that window used to see a "missing" inbox and
    // hand the account to a second caller.
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, assigned_at, account_type)
       VALUES ('midclaim@outlook.com', 'pw', 'c', 'r', 'being-written', datetime('now'), 'long')`,
    ).run();

    await cleanupExpired();

    const account = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'midclaim@outlook.com'`,
    );
    expect(account?.assigned_inbox_id).toBe('being-written');
  });

  it('purges SRP auth sessions once they are a day past their expiry', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO icloud_auth_sessions (id, account_id, status, expires_at)
       VALUES ('sess-old', 'acc', 'failed', datetime('now', '-2 days')),
              ('sess-recent', 'acc', 'failed', datetime('now', '-1 hour')),
              ('sess-live', 'acc', 'pending_mfa', datetime('now', '+4 minutes'))`,
    ).run();

    await cleanupExpired();

    // The recent failure stays readable for post-mortem; only the day-old row
    // is pure accumulation in a table nothing ever deleted from.
    const ids = db.prepare(`SELECT id FROM icloud_auth_sessions ORDER BY id`).all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(['sess-live', 'sess-recent']);
  });
});

describe('daily Outlook token check safety', () => {
  it.each(['generation', 'assignment'])('rechecks accepted invalid evidence before purge after %s changes', async change => {
    const db = getDb();
    insertShortAccount('purge-fenced@outlook.com', 'before-purge');
    db.exec(`CREATE TEMP TRIGGER changed_after_invalid AFTER UPDATE OF token_status ON outlook_accounts
      WHEN NEW.email = 'purge-fenced@outlook.com' AND NEW.token_status = 'invalid'
      BEGIN UPDATE outlook_accounts SET ${change === 'generation' ? "refresh_token = 'replacement-purge'" : "assigned_inbox_id = 'new-owner'"}
        WHERE email = NEW.email; END`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })));
    try {
      await cleanupExpired();
      expect(db.prepare("SELECT email FROM outlook_accounts WHERE email = 'purge-fenced@outlook.com'").get()).toEqual({ email: 'purge-fenced@outlook.com' });
    } finally { db.exec('DROP TRIGGER changed_after_invalid'); }
  });

  it.each(['client_id', 'refresh_token', 'oauth_last_session_id', 'deleted', 'pending_oauth'].flatMap(change =>
    [200, 400, 503].map(status => ({ change, status })),
  ))('ignores old daily HTTP $status after $change changes', async ({ change, status }) => {
    const email = 'daily-generation@outlook.com';
    insertShortAccount(email, 'old-rt');
    const db = getDb();
    let release!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { started(); return response; }));
    const cleanup = cleanupExpired();
    await entered;
    if (change === 'deleted') db.prepare('DELETE FROM outlook_accounts WHERE email = ?').run(email);
    else if (change === 'pending_oauth') db.prepare("UPDATE outlook_accounts SET token_status = 'pending_oauth' WHERE email = ?").run(email);
    else db.prepare(`UPDATE outlook_accounts SET ${change} = 'new-generation' WHERE email = ?`).run(email);
    const expected = db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email);
    release(new Response(status === 200 ? '{"access_token":"late-daily-at"}' : '{"error":"invalid_grant"}', { status }));
    await cleanup;
    expect(db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email)).toEqual(expected);
  });

  it('persists the transport discovered during the daily capability check', async () => {
    insertShortAccount('rest-detected@outlook.com', 'rt-rest-detected');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'access-rest-detected' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('graph.microsoft.com')) return new Response('{}', { status: 401 });
      if (target.includes('outlook.office.com/api/')) {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }));

    await cleanupExpired();

    expect(getRow<{ token_status: string; api_type: string }>(
      getDb(),
      `SELECT token_status, api_type FROM outlook_accounts WHERE email = 'rest-detected@outlook.com'`,
    )).toEqual({ token_status: 'valid', api_type: 'outlook' });
  });

  it('keeps accounts when the token endpoint fails with 5xx', async () => {
    insertShortAccount('a5xx@outlook.com', 'rt-5xx-unique');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));

    await cleanupExpired();

    const row = getRow<{ token_status: string; last_checked_at: string | null }>(
      getDb(),
      `SELECT token_status, last_checked_at FROM outlook_accounts WHERE email = 'a5xx@outlook.com'`,
    );
    expect(row?.token_status).toBe('valid');
    expect(row?.last_checked_at).not.toBeNull();
  });

  it('keeps accounts when the token endpoint is throttling with 429', async () => {
    insertShortAccount('a429@outlook.com', 'rt-429-unique');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'throttled' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })));

    await cleanupExpired();

    const row = getRow<{ token_status: string }>(
      getDb(),
      `SELECT token_status FROM outlook_accounts WHERE email = 'a429@outlook.com'`,
    );
    expect(row?.token_status).toBe('valid');
  });

  it('deletes unassigned short accounts only on deterministic OAuth rejection', async () => {
    insertShortAccount('bad@outlook.com', 'rt-bad-unique');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    await cleanupExpired();

    const row = getRow<{ email: string }>(
      getDb(),
      `SELECT email FROM outlook_accounts WHERE email = 'bad@outlook.com'`,
    );
    expect(row).toBeUndefined();
  });
});
