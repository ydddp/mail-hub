import { describe, expect, it } from 'vitest';
import { cleanupExpired } from '../src/app.js';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';

describe('expired inbox cleanup', () => {
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

    await cleanupExpired();

    expect(provider.deleteCount).toBe(0);
    const inbox = db.prepare(`SELECT id FROM inboxes WHERE id = ?`).get('fake-old');
    expect(inbox).toBeUndefined();
    registry.unregister('fake');
  });
});
