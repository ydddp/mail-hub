import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { app, authHeaders, jsonHeaders, jsonOf } from './helpers/http.js';

type CreatedKey = { key: string; keyHash: string };
type KeyRow = { keyHash: string; name: string; active: boolean; dailyLimit: number | null; dailyCalls: number };

afterEach(() => vi.useRealTimers());

async function createKey(name = 'quota-key'): Promise<CreatedKey> {
  const res = await app.request('/api/keys', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return jsonOf<CreatedKey>(res);
}

async function patchKey(keyHash: string, body: Record<string, unknown>) {
  return app.request(`/api/keys/${encodeURIComponent(keyHash)}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function listKeys(): Promise<KeyRow[]> {
  const res = await app.request('/api/keys', { headers: authHeaders() });
  return (await jsonOf<{ keys: KeyRow[] }>(res)).keys;
}

describe('PATCH /api/keys/:key', () => {
  it.each([
    ['2026-10-05T00:00:00+09:00', 429, 1],
    ['2026-10-04T23:59:59.999Z', 429, 1],
    ['2026-10-05T00:00:00.000Z', 200, 0],
  ])('keeps the quota day in UTC at %s', async (now, status, displayed) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const { key, keyHash } = await createKey();
    getDb().prepare("UPDATE api_keys SET daily_limit=1,daily_calls=1,daily_reset_at='2026-10-04' WHERE key=?").run(keyHash);
    expect((await listKeys()).find(k => k.keyHash === keyHash)?.dailyCalls).toBe(displayed);
    const res = await app.request('/api/providers', { headers: authHeaders(key) });
    expect(res.status).toBe(status);
    expect((await listKeys()).find(k => k.keyHash === keyHash)?.dailyCalls).toBe(1);
  });

  it.each([
    ['2026-10-05T00:00:00+09:00', 19], ['2026-10-05T00:00:00Z', 0],
  ])('displays YYDS counters for the current UTC day at %s', async (now, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    getDb().prepare("INSERT INTO yyds_accounts (api_key,daily_calls,daily_reset_at) VALUES ('tz',19,'2026-10-04')").run();
    const list = await app.request('/api/yyds/accounts', { headers: authHeaders() });
    expect((await list.json()).accounts[0].daily_calls).toBe(expected);
    const stats = await app.request('/api/yyds/stats', { headers: authHeaders() });
    expect((await stats.json()).dailyUsed).toBe(expected);
    expect(getDb().prepare("SELECT daily_calls FROM yyds_accounts WHERE api_key='tz'").get()).toEqual({ daily_calls: 19 });
  });
  it('persists dailyLimit instead of 500ing on the camelCase field (regression)', async () => {
    const { keyHash } = await createKey();

    const res = await patchKey(keyHash, { dailyLimit: 100 });
    expect(res.status).toBe(200);

    const stored = getRow<{ daily_limit: number | null }>(getDb(), `SELECT daily_limit FROM api_keys WHERE key = ?`, keyHash);
    expect(stored?.daily_limit).toBe(100);
    expect((await listKeys()).find((k) => k.keyHash === keyHash)?.dailyLimit).toBe(100);
  });

  it('clears dailyLimit when set to null', async () => {
    const { keyHash } = await createKey('clear-key');
    await patchKey(keyHash, { dailyLimit: 50 });

    const res = await patchKey(keyHash, { dailyLimit: null });
    expect(res.status).toBe(200);
    const stored = getRow<{ daily_limit: number | null }>(getDb(), `SELECT daily_limit FROM api_keys WHERE key = ?`, keyHash);
    expect(stored?.daily_limit).toBeNull();
  });

  it('still updates name and active', async () => {
    const { keyHash } = await createKey('old-name');

    expect((await patchKey(keyHash, { name: '  new-name  ', active: false })).status).toBe(200);
    const row = (await listKeys()).find((k) => k.keyHash === keyHash);
    expect(row?.name).toBe('new-name');
    expect(row?.active).toBe(false);
  });

  it('enforces a persisted dailyLimit on the auth path', async () => {
    const { key, keyHash } = await createKey('enforced-key');
    await patchKey(keyHash, { dailyLimit: 1 });

    const first = await app.request('/api/providers', { headers: authHeaders(key) });
    expect(first.status).toBe(200);
    const second = await app.request('/api/providers', { headers: authHeaders(key) });
    expect(second.status).toBe(429);
  });
});
