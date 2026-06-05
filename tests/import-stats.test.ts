import { describe, expect, it } from 'vitest';
import { app, jsonHeaders } from './helpers/http.js';
import { getDb, getRow } from '../src/db.js';

describe('management import stats', () => {
  it('reports duplicate Outlook accounts separately from imported accounts', async () => {
    const body = { accounts: 'user@outlook.com----pw----client----refresh\nuser@outlook.com----pw----client----refresh' };

    const res = await app.request('/api/outlook/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      imported: 1,
      duplicated: 1,
      skipped: 0,
    });
  });

  it('imports bare Outlook accounts as pending OAuth accounts', async () => {
    const body = { accounts: 'bare@outlook.com----pw' };

    const res = await app.request('/api/outlook/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      imported: 1,
      duplicated: 0,
      skipped: 0,
    });

    const row = getRow<{ client_id: string; refresh_token: string; token_status: string }>(
      getDb(),
      `SELECT client_id, refresh_token, token_status FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(row).toEqual({ client_id: '', refresh_token: '', token_status: 'pending_oauth' });
  });

  it('reports duplicate YYDS keys separately from imported keys', async () => {
    const body = { accounts: 'yd_key----primary\nyd_key----primary' };

    const res = await app.request('/api/yyds/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      imported: 1,
      duplicated: 1,
      skipped: 0,
    });
  });
});
