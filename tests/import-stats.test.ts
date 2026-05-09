import { describe, expect, it } from 'vitest';
import { app, jsonHeaders } from './helpers/http.js';

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
