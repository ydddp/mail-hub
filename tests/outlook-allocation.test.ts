import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatcher.js';
import { getDb, getRow } from '../src/db.js';

describe('Outlook account allocation', () => {
  it('reserves the selected account with the final inbox id during creation', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('reserve@outlook.test', 'pw', 'client', 'refresh', 'valid');

    const result = await dispatch({ provider: 'outlook', ownerKey: 'owner-a' });

    const assigned = getRow<{ assigned_inbox_id: string }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = ?`,
      'reserve@outlook.test',
    );
    expect(assigned?.assigned_inbox_id).toBe(result.id);

    const inbox = getRow<{ id: string; owner_key: string }>(db, `SELECT id, owner_key FROM inboxes WHERE id = ?`, result.id);
    expect(inbox).toEqual({ id: result.id, owner_key: 'owner-a' });
  });

  it('does not hand out an already reserved Outlook account', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status, assigned_inbox_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('busy@outlook.test', 'pw', 'client', 'refresh', 'valid', 'existing-inbox');

    await expect(dispatch({ provider: 'outlook', domain: 'outlook.test' })).rejects.toThrow(/无可用账号/);
  });
});
