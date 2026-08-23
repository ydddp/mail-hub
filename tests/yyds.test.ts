import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { dispatch } from '../src/dispatcher.js';
import { YydsProvider, isDomainScopeError } from '../src/providers/yyds.js';
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

  it('refreshes a temporary token only on the current inbox id', async () => {
    const auth = { accountId: 'shared-account', address: 'shared@yyds.test', tempToken: 'old-token', inboxId: 'current' };
    getDb().prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base) VALUES
       ('current', 'yyds', 'shared@yyds.test', ?, 'https://api.yyds.test'),
       ('historical', 'yyds', 'shared@yyds.test', ?, 'https://api.yyds.test')`,
    ).run(JSON.stringify(auth), JSON.stringify({ ...auth, inboxId: 'historical' }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { token: 'new-token' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { messages: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new YydsProvider().getMessages({ address: 'shared@yyds.test', authData: auth, provider: 'yyds', apiBase: 'https://api.yyds.test' });

    const historical = getRow<{ auth_data: string }>(getDb(), `SELECT auth_data FROM inboxes WHERE id = 'historical'`);
    expect(JSON.parse(historical!.auth_data).tempToken).toBe('old-token');
  });

  it('persists a refreshed token for a legacy row without inboxId and leaves same-address history unchanged', async () => {
    const currentAuth = { accountId: 'shared-account', address: 'legacy@yyds.test', tempToken: 'old-current' };
    const historicalAuth = { accountId: 'shared-account', address: 'legacy@yyds.test', tempToken: 'old-historical' };
    getDb().prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, owner_key) VALUES
       ('legacy-current', 'yyds', 'legacy@yyds.test', ?, 'https://api.yyds.test', '__mail_hub_admin__'),
       ('legacy-historical', 'yyds', 'legacy@yyds.test', ?, 'https://api.yyds.test', '__mail_hub_admin__')`,
    ).run(JSON.stringify(currentAuth), JSON.stringify(historicalAuth));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { token: 'new-token' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { messages: [] } }), { status: 200 })));

    const response = await app.request('/api/inbox/legacy-current/messages', { headers: authHeaders() });

    expect(response.status).toBe(200);
    const rows = getDb().prepare(
      `SELECT id, auth_data FROM inboxes WHERE id IN ('legacy-current', 'legacy-historical') ORDER BY id`,
    ).all() as { id: string; auth_data: string }[];
    expect(rows.map((row) => [row.id, JSON.parse(row.auth_data).tempToken])).toEqual([
      ['legacy-current', 'new-token'],
      ['legacy-historical', 'old-historical'],
    ]);
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

// Upstream response bodies below are verbatim from the live API (2026-08-24),
// captured against a key whose scope is its own domain.
const SCOPE_403 = JSON.stringify({
  success: false,
  error: 'API key domain scope does not permit access to domain "007.hzeg.eu.org"',
  errorCode: 'api_key_domain_scope_forbidden',
});
const WILDCARD_RULE_400 = JSON.stringify({
  success: false,
  error: 'Wildcard is not enabled for requested domain',
  errorCode: 'wildcard_rule_not_enabled_for_domain',
});
const PERMISSION_DENIED_403 = JSON.stringify({
  success: false,
  error: 'Permission denied',
  errorCode: 'permission_denied',
});
const DOMAIN_UNAVAILABLE_400 = JSON.stringify({
  success: false,
  error: 'Domain "_check.invalid" is not available',
  errorCode: 'domain_not_available',
});
const PUBLIC_DOMAIN = '007.hzeg.eu.org';
const OWN_DOMAIN_ADDRESS = 'zw6116kq@d2f26c.mail.amber-invoice.com';

function created(address = OWN_DOMAIN_ADDRESS): Response {
  return new Response(
    JSON.stringify({ success: true, data: { id: 'acc-1', address, token: 'tok-1', mode: 'wildcard' } }),
    { status: 201 },
  );
}

function insertKey(apiKey: string, opts: { wildcard?: number | null; dailyCalls?: number; status?: string } = {}) {
  getDb().prepare(
    `INSERT INTO yyds_accounts (api_key, name, status, supports_wildcard, daily_calls) VALUES (?, '', ?, ?, ?)`,
  ).run(apiKey, opts.status ?? 'active', opts.wildcard ?? null, opts.dailyCalls ?? 0);
}

function wildcardFlag(apiKey: string): number | null {
  return getRow<{ supports_wildcard: number | null }>(
    getDb(), `SELECT supports_wildcard FROM yyds_accounts WHERE api_key = ?`, apiKey,
  )?.supports_wildcard ?? null;
}

function requestBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body));
}

function paths(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
}

describe('YYDS upstream error classification', () => {
  it('recognises only the domain-scope refusal', () => {
    expect(isDomainScopeError(SCOPE_403)).toBe(true);
    expect(isDomainScopeError(WILDCARD_RULE_400)).toBe(false);
    expect(isDomainScopeError(DOMAIN_UNAVAILABLE_400)).toBe(false);
    expect(isDomainScopeError('')).toBe(false);
    // Non-JSON upstreams fall back to the prose match.
    expect(isDomainScopeError('API key domain scope does not permit access')).toBe(true);
  });
});

describe('YYDS own-domain (wildcard) keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates from the wildcard endpoint with no domain in the body', async () => {
    insertKey('own-key', { wildcard: 1 });
    const fetchMock = vi.fn(async () => created());
    vi.stubGlobal('fetch', fetchMock);

    const inbox = await new YydsProvider().createInbox();

    expect(inbox.address).toBe(OWN_DOMAIN_ADDRESS);
    expect(paths(fetchMock)).toEqual(['/v1/accounts/wildcard']);
    expect(requestBody(fetchMock.mock.calls[0])).not.toHaveProperty('domain');
  });

  it('does not fall back to the public endpoint when the wildcard rule rejects a public domain', async () => {
    // The real production sequence for an own-domain key that dispatch handed a
    // public domain: 400 from the wildcard rule, then a guaranteed 403 from the
    // public endpoint. Only the first call may happen.
    insertKey('own-key', { wildcard: 1 });
    const fetchMock = vi.fn(async () => new Response(WILDCARD_RULE_400, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new YydsProvider().createInbox({ domain: PUBLIC_DOMAIN })).rejects.toThrow(/自有域名 Key/);

    expect(paths(fetchMock)).toEqual(['/v1/accounts/wildcard']);
    expect(wildcardFlag('own-key')).toBe(1);
  });

  it('does not latch an own-domain key to the public path on a domain-scope 403', async () => {
    insertKey('own-key', { wildcard: 1 });
    const fetchMock = vi.fn(async () => new Response(SCOPE_403, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new YydsProvider().createInbox()).rejects.toThrow(/403.*domain scope/);

    expect(wildcardFlag('own-key')).toBe(1);
    // Reports upstream's cause, and never tries the public endpoint.
    expect(paths(fetchMock)).toEqual(['/v1/accounts/wildcard']);
  });

  it('never rewrites an operator-set wildcard flag, even on a 403', async () => {
    insertKey('own-key', { wildcard: 1 });
    const fetchMock = vi.fn(async () => new Response(PERMISSION_DENIED_403, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new YydsProvider().createInbox()).rejects.toThrow(/自有域名 Key/);

    expect(wildcardFlag('own-key')).toBe(1);
    expect(paths(fetchMock)).toEqual(['/v1/accounts/wildcard']);
  });

  it('reads a domainless refusal, and only that, as "this key cannot wildcard"', async () => {
    insertKey('probe-key', { wildcard: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(PERMISSION_DENIED_403, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: [{ domain: PUBLIC_DOMAIN, isPublic: true, isVerified: true, isMxValid: true }],
      }), { status: 200 }))
      .mockResolvedValueOnce(created('u1@public.test'));
    vi.stubGlobal('fetch', fetchMock);

    // No domain in the request, so the refusal is about the key itself.
    const inbox = await new YydsProvider().createInbox();

    expect(wildcardFlag('probe-key')).toBe(0);
    expect(inbox.address).toBe('u1@public.test');
  });

  it('promotes an unknown key when a named domain is refused', async () => {
    // The exact production sequence: dispatch preselects a public domain, the
    // wildcard endpoint refuses that domain, and the domainless probe proves
    // the key owns one. 403 permission_denied is the refusal the old code read
    // as "this key cannot wildcard" and latched on.
    for (const refusal of [
      new Response(PERMISSION_DENIED_403, { status: 403 }),
      new Response(WILDCARD_RULE_400, { status: 400 }),
    ]) {
      getDb().prepare(`DELETE FROM yyds_accounts`).run();
      insertKey('fresh-key', { wildcard: null });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(refusal)
        .mockResolvedValueOnce(created());
      vi.stubGlobal('fetch', fetchMock);

      const inbox = await new YydsProvider().createInbox({ domain: PUBLIC_DOMAIN });

      expect(inbox.address).toBe(OWN_DOMAIN_ADDRESS);
      expect(wildcardFlag('fresh-key')).toBe(1);
      expect(paths(fetchMock)).toEqual(['/v1/accounts/wildcard', '/v1/accounts/wildcard']);
      expect(requestBody(fetchMock.mock.calls[1])).not.toHaveProperty('domain');
    }
  });

  it('recovers a key an earlier release latched to "no wildcard"', async () => {
    insertKey('latched-key', { wildcard: 0 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(SCOPE_403, { status: 403 }))
      .mockResolvedValueOnce(created());
    vi.stubGlobal('fetch', fetchMock);

    const inbox = await new YydsProvider().createInbox({ domain: PUBLIC_DOMAIN });

    expect(inbox.address).toBe(OWN_DOMAIN_ADDRESS);
    expect(wildcardFlag('latched-key')).toBe(1);
    expect(paths(fetchMock)).toEqual(['/v1/accounts', '/v1/accounts/wildcard']);
  });

  it('does not mistake a key scoped to a few public domains for an own-domain key', async () => {
    insertKey('scoped-key', { wildcard: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(WILDCARD_RULE_400, { status: 400 }))
      .mockResolvedValueOnce(new Response(WILDCARD_RULE_400, { status: 400 }))
      .mockResolvedValueOnce(created('u1@public.test'));
    vi.stubGlobal('fetch', fetchMock);

    const inbox = await new YydsProvider().createInbox({ domain: PUBLIC_DOMAIN });

    // The domainless probe failed, so the key is public after all.
    expect(wildcardFlag('scoped-key')).toBe(0);
    expect(inbox.address).toBe('u1@public.test');
    expect(paths(fetchMock)).toEqual(['/v1/accounts/wildcard', '/v1/accounts/wildcard', '/v1/accounts']);
  });

  it('does not demote a key on a transient domainless failure', async () => {
    insertKey('flaky-key', { wildcard: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(WILDCARD_RULE_400, { status: 400 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(created('u1@public.test'));
    vi.stubGlobal('fetch', fetchMock);

    await new YydsProvider().createInbox({ domain: PUBLIC_DOMAIN });

    expect(wildcardFlag('flaky-key')).toBeNull();
  });

  it('reports from_create only while an own-domain key is usable', () => {
    const provider = new YydsProvider();
    expect(provider.getDomainMode()).toBe('endpoint');

    insertKey('unknown-key', { wildcard: null });
    expect(provider.getDomainMode()).toBe('endpoint');

    insertKey('own-key', { wildcard: 1 });
    expect(provider.getDomainMode()).toBe('from_create');

    getDb().prepare(`UPDATE yyds_accounts SET daily_calls = 20000 WHERE api_key = 'own-key'`).run();
    expect(provider.getDomainMode()).toBe('endpoint');
  });

  it('dispatches to an own-domain key without preselecting a public domain', async () => {
    insertKey('own-key', { wildcard: 1 });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/domains')) {
        return new Response(JSON.stringify({
          success: true,
          data: [{ domain: PUBLIC_DOMAIN, isPublic: true, isVerified: true, isMxValid: true }],
        }), { status: 200 });
      }
      return created();
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatch({ provider: 'yyds' });

    expect(result.address).toBe(OWN_DOMAIN_ADDRESS);
    const createCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/accounts'));
    expect(requestBody(createCall!)).not.toHaveProperty('domain');
  });
});

describe('POST /api/yyds/check', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a scope-limited key active when the probe domain is refused', async () => {
    insertKey('own-key', { wildcard: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SCOPE_403, { status: 403 })));

    const res = await app.request('/api/yyds/check', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ keys: ['own-key'] }),
    });

    expect(res.status).toBe(200);
    expect(await jsonOf<{ valid: number }>(res)).toMatchObject({ valid: 1, invalid: 0 });
    expect(getRow<{ status: string }>(getDb(), `SELECT status FROM yyds_accounts WHERE api_key = ?`, 'own-key')?.status)
      .toBe('active');
  });

  it('keeps a key active on the 400 the live probe actually returns', async () => {
    insertKey('own-key', { wildcard: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(DOMAIN_UNAVAILABLE_400, { status: 400 })));

    const res = await app.request('/api/yyds/check', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ keys: ['own-key'] }),
    });

    expect(await jsonOf<{ valid: number }>(res)).toMatchObject({ valid: 1, invalid: 0 });
  });

  it('marks a rejected key invalid on 401', async () => {
    insertKey('dead-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const res = await app.request('/api/yyds/check', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ keys: ['dead-key'] }),
    });

    expect(await jsonOf<{ invalid: number }>(res)).toMatchObject({ valid: 0, invalid: 1 });
    expect(getRow<{ status: string }>(getDb(), `SELECT status FROM yyds_accounts WHERE api_key = ?`, 'dead-key')?.status)
      .toBe('invalid');
  });

  it('marks a key invalid on a 403 that is not about a domain', async () => {
    insertKey('revoked-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'API key revoked' }), { status: 403 })));

    const res = await app.request('/api/yyds/check', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ keys: ['revoked-key'] }),
    });

    expect(await jsonOf<{ invalid: number }>(res)).toMatchObject({ valid: 0, invalid: 1 });
  });
});
