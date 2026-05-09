import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { YydsProvider } from '../src/providers/yyds.js';
import { app, authHeaders, jsonHeaders, jsonOf } from './helpers/http.js';

interface ImportResponse { imported: number; duplicated: number }
interface AccountsResponse { accounts: Record<string, unknown>[] }
interface DeleteResponse { deleted: number }
interface StatsResponse { total: number; active: number; invalid: number; dailyQuota: number }
interface StatusResponse { updated: number; enabled: boolean }
interface WildcardResponse { updated: number; wildcard: boolean }

function insertAccount(apiKey: string, name = '', status = 'active') {
  getDb().prepare(
    `INSERT INTO yyds_accounts (api_key, name, status) VALUES (?, ?, ?)`
  ).run(apiKey, name, status);
}

describe('YYDS account management', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses cached domains when the upstream domain list is unavailable', async () => {
    insertAccount('key1');
    getDb().prepare(
      `INSERT INTO yyds_domain_cache (domain) VALUES (?), (?)`,
    ).run('cached-a.test', 'cached-b.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));

    const provider = new YydsProvider();
    const domains = await provider.getDomains();

    expect(domains).toEqual(['cached-a.test', 'cached-b.test']);
  });

  describe('POST /api/yyds/import', () => {
    it('imports accounts from newline-delimited text', async () => {
      const res = await app.request('/api/yyds/import', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ accounts: 'key1----Name1\nkey2----Name2\nkey3' }),
      });
      const data = await jsonOf<ImportResponse>(res);
      expect(res.status).toBe(200);
      expect(data.imported).toBe(3);
      expect(data.duplicated).toBe(0);

      const rows = getDb().prepare(`SELECT * FROM yyds_accounts`).all();
      expect(rows).toHaveLength(3);
    });

    it('skips duplicate keys', async () => {
      insertAccount('existing-key', 'Old');

      const res = await app.request('/api/yyds/import', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ accounts: 'existing-key----New\nfresh-key' }),
      });
      const data = await jsonOf<ImportResponse>(res);
      expect(data.imported).toBe(1);
      expect(data.duplicated).toBe(1);
    });

    it('rejects empty accounts field', async () => {
      const res = await app.request('/api/yyds/import', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ accounts: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('requires admin auth', async () => {
      const res = await app.request('/api/yyds/import', {
        method: 'POST',
        headers: jsonHeaders('wrong'),
        body: JSON.stringify({ accounts: 'key1' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/yyds/accounts', () => {
    it('lists all accounts', async () => {
      insertAccount('k1', 'A');
      insertAccount('k2', 'B');

      const res = await app.request('/api/yyds/accounts', { headers: authHeaders() });
      const data = await jsonOf<AccountsResponse>(res);
      expect(res.status).toBe(200);
      expect(data.accounts).toHaveLength(2);
      expect(data.accounts[0]).toHaveProperty('api_key');
      expect(data.accounts[0]).toHaveProperty('status');
    });

    it('returns empty array when no accounts', async () => {
      const res = await app.request('/api/yyds/accounts', { headers: authHeaders() });
      const data = await jsonOf<AccountsResponse>(res);
      expect(data.accounts).toHaveLength(0);
    });
  });

  describe('DELETE /api/yyds/accounts', () => {
    it('deletes specified keys', async () => {
      insertAccount('del1');
      insertAccount('del2');
      insertAccount('keep1');

      const res = await app.request('/api/yyds/accounts', {
        method: 'DELETE',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: ['del1', 'del2'] }),
      });
      const data = await jsonOf<DeleteResponse>(res);
      expect(data.deleted).toBe(2);

      const remaining = getDb().prepare(`SELECT * FROM yyds_accounts`).all();
      expect(remaining).toHaveLength(1);
    });

    it('rejects empty keys array', async () => {
      const res = await app.request('/api/yyds/accounts', {
        method: 'DELETE',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/yyds/stats', () => {
    it('returns aggregated stats', async () => {
      insertAccount('a1', '', 'active');
      insertAccount('a2', '', 'active');
      insertAccount('a3', '', 'invalid');

      const res = await app.request('/api/yyds/stats', { headers: authHeaders() });
      const data = await jsonOf<StatsResponse>(res);
      expect(res.status).toBe(200);
      expect(data.total).toBe(3);
      expect(data.active).toBe(2);
      expect(data.invalid).toBe(1);
      expect(data.dailyQuota).toBe(2 * 20000);
    });

    it('returns zeros when empty', async () => {
      const res = await app.request('/api/yyds/stats', { headers: authHeaders() });
      const data = await jsonOf<StatsResponse>(res);
      expect(data.total).toBe(0);
      expect(data.active).toBe(0);
      expect(data.dailyQuota).toBe(0);
    });
  });

  describe('PATCH /api/yyds/accounts/status', () => {
    it('disables accounts', async () => {
      insertAccount('s1');
      insertAccount('s2');

      const res = await app.request('/api/yyds/accounts/status', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: ['s1', 's2'], enabled: false }),
      });
      const data = await jsonOf<StatusResponse>(res);
      expect(data.updated).toBe(2);
      expect(data.enabled).toBe(false);

      const row = getRow<{ status: string }>(getDb(), `SELECT status FROM yyds_accounts WHERE api_key = ?`, 's1');
      expect(row?.status).toBe('disabled');
    });

    it('enables disabled accounts', async () => {
      insertAccount('d1', '', 'disabled');

      const res = await app.request('/api/yyds/accounts/status', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: ['d1'], enabled: true }),
      });
      const data = await jsonOf<StatusResponse>(res);
      expect(data.enabled).toBe(true);

      const row = getRow<{ status: string }>(getDb(), `SELECT status FROM yyds_accounts WHERE api_key = ?`, 'd1');
      expect(row?.status).toBe('active');
    });

    it('rejects empty keys', async () => {
      const res = await app.request('/api/yyds/accounts/status', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: [], enabled: false }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/yyds/accounts/wildcard', () => {
    it('sets wildcard support flag', async () => {
      insertAccount('w1');

      const res = await app.request('/api/yyds/accounts/wildcard', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: ['w1'], wildcard: true }),
      });
      const data = await jsonOf<WildcardResponse>(res);
      expect(data.updated).toBe(1);
      expect(data.wildcard).toBe(true);

      const row = getRow<{ supports_wildcard: number }>(getDb(), `SELECT supports_wildcard FROM yyds_accounts WHERE api_key = ?`, 'w1');
      expect(row?.supports_wildcard).toBe(1);
    });

    it('clears wildcard support flag', async () => {
      getDb().prepare(`INSERT INTO yyds_accounts (api_key, supports_wildcard) VALUES (?, 1)`).run('w2');

      const res = await app.request('/api/yyds/accounts/wildcard', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: ['w2'], wildcard: false }),
      });
      const data = await jsonOf<WildcardResponse>(res);
      expect(data.wildcard).toBe(false);

      const row = getRow<{ supports_wildcard: number }>(getDb(), `SELECT supports_wildcard FROM yyds_accounts WHERE api_key = ?`, 'w2');
      expect(row?.supports_wildcard).toBe(0);
    });

    it('rejects empty keys', async () => {
      const res = await app.request('/api/yyds/accounts/wildcard', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: [], wildcard: true }),
      });
      expect(res.status).toBe(400);
    });
  });
});
