import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { assertTestPath } from './helpers/test-storage.js';
import { dirname } from 'path';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';
import { getDb, initDb } from '../src/db.js';
import { hashApiKey } from '../src/crypto.js';
import { trustTokenPath } from '../src/providers/icloud-auth.js';

const srpMockState = vi.hoisted(() => ({ rejectPassword: false }));

vi.mock('icloudjs', () => {
  class FakeService {
    authStore = { trustToken: '', getHeaders: () => ({ Cookie: '' }) };
    status = 'MfaRequested';
    awaitReady = Promise.resolve();
    async authenticate(): Promise<void> {
      if (srpMockState.rejectPassword) throw new Error('Apple rejected the password');
    }
  }
  return { default: FakeService };
});

afterEach(() => {
  srpMockState.rejectPassword = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function recoveryFixture(serviceUrl = 'https://svc.test', state = 'retiring'): void {
  getDb().prepare(`INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
    VALUES ('recovery-account', 'recovery@icloud.com', 'c', ?)`).run(serviceUrl);
  getDb().prepare(`INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state)
    VALUES ('recovery@icloud.com', 'recovery-account', 'recovery-alias', ?)`).run(state);
}

function retireRecovery(): Promise<Response> {
  return app.request('/api/icloud/addresses/recovery@icloud.com/retire', { method: 'POST', headers: jsonHeaders() });
}

function recoverySnapshot(active: boolean): Response {
  return new Response(JSON.stringify({ success: true, result: {
    hmeEmails: [{ hme: 'renamed@icloud.com', anonymousId: 'recovery-alias', isActive: active }],
  } }));
}

describe('iCloud admin routes', () => {
  it('reports upstream delivery status separately from assigned ownership in the address pool', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO icloud_addresses
      (hme, account_id, anonymous_id, state, assigned_inbox_id, upstream_active, upstream_checked_at)
      VALUES ('unavailable@icloud.com', 'account', 'unavailable', 'assigned', 'owner', 0, '2026-11-08 00:00:00')`).run();
    db.prepare(`INSERT INTO icloud_addresses (hme, account_id, anonymous_id)
      VALUES ('unknown@icloud.com', 'account', 'unknown')`).run();
    const response = await app.request('/api/icloud/addresses', { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = await response.json() as { addresses: Record<string, unknown>[] };
    expect(body.addresses.find(row => row.hme === 'unavailable@icloud.com')).toMatchObject({
      state: 'assigned', assigned_inbox_id: 'owner', upstream_active: 0, upstream_checked_at: '2026-11-08T00:00:00.000Z',
    });
    expect(body.addresses.find(row => row.hme === 'unknown@icloud.com')).toMatchObject({
      upstream_active: null, upstream_checked_at: null,
    });
  });

  it('refuses a non-admin caller', async () => {
    // A request with no token at all is answered 401 by the global /api/*
    // middleware and never reaches this router, so the caller has to be a real
    // regular API key for the admin boundary itself to be under test.
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey('mk_user'), 'user');

    const res = await app.request('/api/icloud/accounts', { headers: authHeaders('mk_user') });
    expect(res.status).toBe(403);
  });

  it('creates an account without echoing its secrets back', async () => {
    const res = await app.request('/api/icloud/accounts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        appleId: 'me@icloud.com',
        cookies: 'X-APPLE-WEBAUTH-TOKEN=secret; X-APPLE-WEBAUTH-USER=whoami',
        imapUser: 'me@icloud.com',
        imapPassword: 'abcd-efgh-ijkl-mnop',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { account: Record<string, unknown> };
    expect(body.account.apple_id).toBe('me@icloud.com');
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('abcd-efgh');
  });

  it('starts a new account as pending, so nothing serves it before /test', async () => {
    await app.request('/api/icloud/accounts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        appleId: 'untested@icloud.com',
        cookies: 'X-APPLE-WEBAUTH-TOKEN=t; X-APPLE-WEBAUTH-USER=u',
        // A wrong/blank IMAP password is invisible until the first poll fails;
        // the account must not mint or dispatch on the strength of the cookie
        // alone. getAccountById and refill both take only active/degraded.
        imapPassword: '',
      }),
    });

    const row = getDb().prepare(
      `SELECT status FROM icloud_accounts WHERE apple_id = 'untested@icloud.com'`,
    ).get() as { status: string };
    expect(row.status).toBe('pending');
  });

  it('accepts a whole Copy-as-cURL paste rather than only the Cookie header', async () => {
    const res = await app.request('/api/icloud/accounts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        appleId: 'curl@icloud.com',
        // Digging the Cookie line out of this by hand is the chore that
        // produces truncated pastes and a confusing failure an hour later.
        cookies: `curl 'https://p68-maildomainws.icloud.com/v1/hme/list' \\\n  -H 'accept: */*' \\\n  -H 'cookie: X-APPLE-WEBAUTH-TOKEN=tok; X-APPLE-WEBAUTH-USER=usr' \\\n  --compressed`,
        imapPassword: 'pw',
      }),
    });

    expect(res.status).toBe(200);
    const stored = getDb().prepare(
      `SELECT cookies FROM icloud_accounts WHERE apple_id = 'curl@icloud.com'`,
    ).get() as { cookies: string };
    expect(stored.cookies).toBe('X-APPLE-WEBAUTH-TOKEN=tok; X-APPLE-WEBAUTH-USER=usr');
  });

  it('names the missing cookie instead of storing a half-copied session', async () => {
    const res = await app.request('/api/icloud/accounts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        appleId: 'partial@icloud.com',
        // The /reportStats request carries the token but not the user, and it
        // is the one people happen to right-click.
        cookies: 'X-APPLE-WEBAUTH-TOKEN=tok; other=1',
        imapPassword: 'pw',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { missing: string[]; error: string };
    expect(body.missing).toEqual(['X-APPLE-WEBAUTH-USER']);
    expect(body.error).toContain('X-APPLE-WEBAUTH-USER');
    // Rejected means not stored — a half-copied session must not sit there
    // looking configured until the first poll fails.
    const row = getDb().prepare(
      `SELECT COUNT(*) AS c FROM icloud_accounts WHERE apple_id = 'partial@icloud.com'`,
    ).get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('swaps an expired cookie in place without losing the address pool', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-ck', 'ck@icloud.com', 'X-APPLE-WEBAUTH-TOKEN=old; X-APPLE-WEBAUTH-USER=old', 'https://stale.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('keep@icloud.com', 'acc-ck', 'anon-keep')`,
    ).run();

    const res = await app.request('/api/icloud/accounts/acc-ck/cookies', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ cookies: 'X-APPLE-WEBAUTH-TOKEN=new; X-APPLE-WEBAUTH-USER=new' }),
    });

    expect(res.status).toBe(200);
    const row = getDb().prepare(
      `SELECT cookies, hme_service_url FROM icloud_accounts WHERE id = 'acc-ck'`,
    ).get() as { cookies: string; hme_service_url: string };
    expect(row.cookies).toContain('=new');
    // The partition host belongs to the old session; keeping it would send the
    // new cookie to a host that no longer answers for it.
    expect(row.hme_service_url).toBe('');

    // Deleting and recreating the account would have burned this alias: every
    // address is one of the 750 an Apple ID ever gets.
    const pool = getDb().prepare(
      `SELECT COUNT(*) AS c FROM icloud_addresses WHERE account_id = 'acc-ck'`,
    ).get() as { c: number };
    expect(pool.c).toBe(1);
  });

  it('never returns cookies or the app-specific password when listing accounts', async () => {
    // The list route carries its own column list, so the create route's
    // omission proves nothing about it.
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, imap_password)
       VALUES ('acc-list', 'me@icloud.com', 'X-APPLE-WEBAUTH-TOKEN=cookie-secret', 'wxyz-app-password')`,
    ).run();

    const res = await app.request('/api/icloud/accounts', { headers: authHeaders() });

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain('acc-list');
    expect(raw).not.toContain('cookie-secret');
    expect(raw).not.toContain('wxyz-app-password');
  });

  it('mints addresses into the pool and marks them as Mail Hub owned', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-1', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();

    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const isReserve = String(url).includes('/reserve');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(isReserve
          ? { success: true, result: { hme: { hme: 'fresh@icloud.com', anonymousId: 'anon-1', label: 'mail-hub', note: '', isActive: true } } }
          : { success: true, result: { hme: 'fresh@icloud.com' } }),
      };
    }));

    const res = await app.request('/api/icloud/accounts/acc-1/generate', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ count: 1 }),
    });

    expect(res.status).toBe(200);
    const row = getDb().prepare(
      `SELECT state, anonymous_id, upstream_active, upstream_checked_at FROM icloud_addresses WHERE hme = 'fresh@icloud.com'`,
    ).get() as { state: string; anonymous_id: string; upstream_active: number | null; upstream_checked_at: string | null };
    expect(row.state).toBe('free');
    expect(row.anonymous_id).toBe('anon-1');
    expect(row.upstream_active).toBeNull();
    expect(row.upstream_checked_at).toBeNull();
    expect(bodies.some((b) => b.label === 'mail-hub')).toBe(true);
  });

  it('refuses an SRP sign-in for an account with no password saved', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id) VALUES ('acc-srp', 'me@icloud.com')`,
    ).run();

    const res = await app.request('/api/icloud/accounts/acc-srp/srp/begin', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    // Saying which credential is missing beats a stack trace out of the SRP
    // library, which is what a bare handshake attempt would produce.
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('password');
  });

  it('keeps the working credential state when Apple rejects a replacement password', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, auth_mode, password)
       VALUES ('acc-srp-reject', 'working@icloud.com', 'cookie', 'working-password')`,
    ).run();
    srpMockState.rejectPassword = true;

    const res = await app.request('/api/icloud/accounts/acc-srp-reject/srp/begin', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ password: 'mistyped-password' }),
    });

    expect(res.status).toBe(400);
    const row = getDb().prepare(
      `SELECT password, auth_mode FROM icloud_accounts WHERE id = 'acc-srp-reject'`,
    ).get() as { password: string; auth_mode: string };
    expect(row).toEqual({ password: 'working-password', auth_mode: 'cookie' });

    srpMockState.rejectPassword = false;
    const accepted = await app.request('/api/icloud/accounts/acc-srp-reject/srp/begin', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ password: 'accepted-password' }),
    });
    expect(accepted.status).toBe(200);
    const acceptedRow = getDb().prepare(
      `SELECT password, auth_mode FROM icloud_accounts WHERE id = 'acc-srp-reject'`,
    ).get() as { password: string; auth_mode: string };
    expect(acceptedRow).toEqual({ password: 'accepted-password', auth_mode: 'srp' });
  });

  it('refuses a 2FA code for a session it never issued', async () => {
    const res = await app.request('/api/icloud/accounts/acc-srp/srp/complete', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: 'never-issued', code: '123456' }),
    });

    expect(res.status).toBe(400);
  });

  it('reports Apple’s own message when generation is refused', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-2', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: false, error: { errorMessage: 'Rate limited, try later' } }),
    })));

    const res = await app.request('/api/icloud/accounts/acc-2/generate', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ count: 1 }),
    });

    const body = await res.json() as { error?: string; created?: number };
    expect(body.created).toBe(0);
    expect(body.error).toContain('Rate limited, try later');
  });

  it('deactivates a burned address at Apple and never hands it out again', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-rt', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('burned@icloud.com', 'acc-rt', 'anon-burn')`,
    ).run();

    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ success: true, result: {} }) };
    }));

    const res = await app.request('/api/icloud/addresses/burned@icloud.com/retire', {
      method: 'POST', headers: jsonHeaders(),
    });

    expect(res.status).toBe(200);
    // This is the one place Apple-side deactivation belongs: the address is
    // burned, so the slot is spent either way and recycling it would hand a
    // tenant an alias a target already blocks.
    expect(bodies).toContainEqual({ anonymousId: 'anon-burn' });
    const row = getDb().prepare(
      `SELECT state FROM icloud_addresses WHERE hme = 'burned@icloud.com'`,
    ).get() as { state: string };
    expect(row.state).toBe('retired');
  });

  it('claims the address before Apple is called, so dispatch cannot grab it mid-retire', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-order', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('mid@icloud.com', 'acc-order', 'anon-mid')`,
    ).run();

    const statesSeenByApple: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const row = getDb().prepare(
        `SELECT state FROM icloud_addresses WHERE hme = 'mid@icloud.com'`,
      ).get() as { state: string };
      statesSeenByApple.push(row.state);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ success: true, result: {} }) };
    }));

    const res = await app.request('/api/icloud/addresses/mid@icloud.com/retire', {
      method: 'POST', headers: jsonHeaders(),
    });

    expect(res.status).toBe(200);
    // The row must already be off the market while Apple deactivates it. When
    // it was still 'free' here, a dispatch could claim it in that window and
    // end up holding an alias Apple had just killed.
    expect(statesSeenByApple).toEqual(['retiring']);
  });

  it('puts the address back as it was only when Apple explicitly rejects deactivation', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-fail', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('stay@icloud.com', 'acc-fail', 'anon-stay')`,
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ success: false, error: { errorMessage: 'deactivation is not allowed for this alias' } }),
    })));

    const res = await app.request('/api/icloud/addresses/stay@icloud.com/retire', {
      method: 'POST', headers: jsonHeaders(),
    });

    expect(res.status).toBe(502);
    // A completed response that explicitly rejected the op proves the alias
    // still forwards, so it must not be stranded in 'retiring' — that would
    // quietly shrink the pool by one for ever.
    const row = getDb().prepare(
      `SELECT state FROM icloud_addresses WHERE hme = 'stay@icloud.com'`,
    ).get() as { state: string };
    expect(row.state).toBe('free');
  });

  it('keeps an address retiring when the deactivation result is ambiguous', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-timeout', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('uncertain@icloud.com', 'acc-timeout', 'anon-uncertain')`,
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network timeout'); }));
    const output: string[] = [];
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    let res: Response;
    try {
      res = await app.request('/api/icloud/addresses/uncertain@icloud.com/retire', {
        method: 'POST', headers: jsonHeaders(),
      });
    } finally {
      logSpy.mockRestore();
    }

    // A timeout can land after Apple already deactivated, so returning the
    // alias to the pool would hand a dead address to the next tenant. Stay
    // fail-closed in 'retiring'.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'network timeout' });
    expect(getDb().prepare(`SELECT state FROM icloud_addresses WHERE hme = 'uncertain@icloud.com'`).get()).toEqual({ state: 'retiring' });
    const warnings = output
      .flatMap((chunk) => chunk.trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === 'warn' && entry.module === 'icloud-route');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ address: 'uncertain@icloud.com' });
    expect(warnings[0]?.operatorAction).toMatch(/inspect.*retry/i);
    expect(warnings[0]?.error).toEqual({ class: 'Error', category: 'error' });
    expect(output.join('')).not.toContain('network timeout');
  });

  it.each([
    ['returns HTTP 5xx', async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'upstream unavailable' })],
    ['returns malformed JSON', async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>gateway</html>' })],
  ])('keeps an address retiring when Apple %s', async (_caseName, response) => {
    const suffix = _caseName.replace(/\W+/g, '-');
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES (?, ?, 'c', 'https://svc.test')`,
    ).run(`acc-${suffix}`, `${suffix}@icloud.com`);
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES (?, ?, ?)`,
    ).run(`${suffix}@icloud.com`, `acc-${suffix}`, `anon-${suffix}`);
    vi.stubGlobal('fetch', vi.fn(response));

    const res = await app.request(`/api/icloud/addresses/${encodeURIComponent(`${suffix}@icloud.com`)}/retire`, {
      method: 'POST', headers: jsonHeaders(),
    });

    expect(res.status).toBe(502);
    expect(getDb().prepare(`SELECT state FROM icloud_addresses WHERE hme = ?`).get(`${suffix}@icloud.com`)).toEqual({ state: 'retiring' });
  });

  it('restores the old state for Apple’s structured 409 operation rejection', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-409', '409@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('reject409@icloud.com', 'acc-409', 'anon-409')`,
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, headers: { get: () => null },
      text: async () => JSON.stringify({ success: false, error: { errorMessage: 'operation rejected' } }),
    })));

    const res = await app.request('/api/icloud/addresses/reject409@icloud.com/retire', {
      method: 'POST', headers: jsonHeaders(),
    });

    // A 409 whose body says success:false is a definitive business rejection,
    // so the alias is still live and returns to 'free'.
    expect(res.status).toBe(502);
    expect(getDb().prepare(`SELECT state FROM icloud_addresses WHERE hme = 'reject409@icloud.com'`).get()).toEqual({ state: 'free' });
  });

  it.each([false, true])('recovers a legacy retiring address after confirming upstream activity=%s', async (active) => {
    getDb().prepare(`INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
      VALUES ('acc-recover', 'recover@icloud.com', 'c', 'https://svc.test')`).run();
    getDb().prepare(`INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state)
      VALUES ('recover@icloud.com', 'acc-recover', 'anon-recover', 'retiring')`).run();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, result: String(url).endsWith('/list')
        ? { hmeEmails: [{ hme: 'renamed@icloud.com', anonymousId: 'anon-recover', isActive: active }] } : {} }));
    }));
    const response = await app.request('/api/icloud/addresses/recover@icloud.com/retire', { method: 'POST', headers: jsonHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map(url => url.split('/').pop())).toEqual(active ? ['list', 'deactivate'] : ['list']);
    expect(getDb().prepare(`SELECT hme, account_id, state, upstream_active FROM icloud_addresses`).get())
      .toEqual({ hme: 'recover@icloud.com', account_id: 'acc-recover', state: 'retired', upstream_active: 0 });
  });

  it('refuses to retire an address already mid-retirement, so two calls cannot both claim it', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-conc', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    // A persisted, unexpired operation remains exclusive across restarts.
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state, retire_op_id, retire_started_at, retire_lease_until)
       VALUES ('mid2@icloud.com', 'acc-conc', 'anon-mid2', 'retiring', 'persisted-op', ?, ?)`,
    ).run(Date.now(), Date.now() + 120_000);
    getDb().close();
    initDb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await app.request('/api/icloud/addresses/mid2@icloud.com/retire', {
      method: 'POST', headers: jsonHeaders(),
    });

    expect(res.status).toBe(409);
    // The second caller must not have called Apple at all.
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = getDb().prepare(
      `SELECT state FROM icloud_addresses WHERE hme = 'mid2@icloud.com'`,
    ).get() as { state: string };
    expect(row.state).toBe('retiring');
  });

  it.each(['expired', 'exact expiry', 'missing identity', 'missing start', 'missing lease'])('verifies %s operations before recovering a persisted retirement', async (kind) => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    recoveryFixture();
    getDb().prepare(`UPDATE icloud_addresses SET retire_op_id = ?, retire_started_at = ?, retire_lease_until = ?`)
      .run(kind === 'missing identity' ? null : 'old-op', kind === 'missing start' ? null : now - 120_000,
        kind === 'missing lease' ? null : kind === 'expired' ? now - 1 : kind === 'exact expiry' ? now : now + 60_000);
    const fetchSpy = vi.fn(async () => recoverySnapshot(false));
    vi.stubGlobal('fetch', fetchSpy);
    expect((await retireRecovery()).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/list');
    expect(getDb().prepare(`SELECT state, upstream_active FROM icloud_addresses`).get()).toEqual({ state: 'retired', upstream_active: 0 });
  });

  it.each([
    ['absent target', () => new Response(JSON.stringify({ success: true, result: { hmeEmails: [] } }))],
    ['malformed entry', () => new Response(JSON.stringify({ success: true, result: { hmeEmails: [{ anonymousId: 'recovery-alias', hme: 'x', isActive: null }] } }))],
    ['partial list', () => new Response(JSON.stringify({ success: true, result: { hmeEmails: [], hasMore: true } }))],
    ['missing positive success', () => new Response(JSON.stringify({ result: { hmeEmails: [] } }))],
    ['expired authentication', () => new Response('', { status: 401 })],
    ['network failure', () => { throw new Error('read unavailable'); }],
  ])('leaves recovery explicitly unresolved after %s without sending deactivate', async (_kind, result) => {
    recoveryFixture();
    const fetchSpy = vi.fn(async () => result());
    vi.stubGlobal('fetch', fetchSpy);
    const response = await retireRecovery();
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toMatch(/unresolved/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/list');
    expect(getDb().prepare(`SELECT state, upstream_active, upstream_checked_at FROM icloud_addresses`).get())
      .toEqual({ state: 'retiring', upstream_active: null, upstream_checked_at: null });
    // This request has ended: a fresh administrator retry can verify immediately.
    vi.stubGlobal('fetch', vi.fn(async () => recoverySnapshot(false)));
    expect((await retireRecovery()).status).toBe(200);
  });

  it('keeps a recovered active alias retiring after a definitive write rejection', async () => {
    recoveryFixture();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/list') ? recoverySnapshot(true)
      : new Response(JSON.stringify({ success: false, error: { errorMessage: 'rejected' } }))));
    expect((await retireRecovery()).status).toBe(502);
    expect(getDb().prepare(`SELECT state, upstream_active FROM icloud_addresses`).get())
      .toEqual({ state: 'retiring', upstream_active: 1 });
  });

  it('does not roll a first rejection back to free after reconciliation has confirmed inactivity', async () => {
    recoveryFixture('https://svc.test', 'free');
    vi.stubGlobal('fetch', vi.fn(async () => {
      getDb().prepare(`UPDATE icloud_addresses SET upstream_active = 0`).run();
      return new Response(JSON.stringify({ success: false, error: { errorMessage: 'rejected' } }));
    }));
    expect((await retireRecovery()).status).toBe(502);
    expect(getDb().prepare(`SELECT state, upstream_active FROM icloud_addresses`).get())
      .toEqual({ state: 'retired', upstream_active: 0 });
  });

  it('persists one bounded operation before sending and excludes a concurrent administrator', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    recoveryFixture('https://svc.test', 'free');
    const entered = deferred<void>();
    const pendingPost = deferred<Response>();
    const fetchSpy = vi.fn(async () => { entered.resolve(); return pendingPost.promise; });
    vi.stubGlobal('fetch', fetchSpy);
    const first = retireRecovery();
    await entered.promise;
    const operation = getDb().prepare(`SELECT state, retire_op_id, retire_started_at, retire_lease_until FROM icloud_addresses`).get() as Record<string, unknown>;
    expect(operation).toMatchObject({ state: 'retiring', retire_started_at: now, retire_lease_until: now + 120_000 });
    expect(operation.retire_op_id).toEqual(expect.any(String));
    expect((await retireRecovery()).status).toBe(409);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    pendingPost.resolve(new Response(JSON.stringify({ success: true, result: {} })));
    expect((await first).status).toBe(200);
  });

  it.each(['success', 'rejection', 'body'] as const)('rejects a late old POST %s without overwriting or logging a newer operation', async (outcome) => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    recoveryFixture('https://svc.test', 'free');
    const entered = deferred<void>();
    const oldResponse = deferred<Response>();
    const oldBody = deferred<string>();
    vi.stubGlobal('fetch', vi.fn(async () => {
      entered.resolve();
      if (outcome === 'body') return { ok: true, status: 200, headers: new Headers(), text: () => oldBody.promise };
      return oldResponse.promise;
    }));
    const first = retireRecovery();
    await entered.promise;
    clock.mockReturnValue(now + 120_001);
    // New process/request acquires and waits on a still-running LIST.
    const newerEntered = deferred<void>();
    const newList = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async () => { newerEntered.resolve(); return newList.promise; }));
    const newer = retireRecovery();
    await newerEntered.promise;
    const before = getDb().prepare(`SELECT * FROM icloud_addresses`).get();
    const envelope = JSON.stringify({ success: outcome !== 'rejection', result: {}, error: { errorMessage: 'old rejected' } });
    if (outcome === 'body') oldBody.resolve(envelope);
    else oldResponse.resolve(new Response(envelope));
    expect((await first).status).toBe(409);
    expect(getDb().prepare(`SELECT * FROM icloud_addresses`).get()).toEqual(before);
    expect(getDb().prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE text LIKE 'Retired iCloud address%'`).get()).toEqual({ c: 0 });
    newList.resolve(recoverySnapshot(false));
    expect((await newer).status).toBe(200);
  });

  it.each(['LIST', 'validate', 'recovery validate'] as const)('blocks an expired operation whose delayed %s would otherwise send a stale POST', async (phase) => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    recoveryFixture(phase.includes('validate') ? '' : 'https://svc.test', phase === 'validate' ? 'free' : 'retiring');
    const entered = deferred<void>();
    const delayed = deferred<Response>();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      entered.resolve();
      return delayed.promise;
    }));
    const old = retireRecovery();
    await entered.promise;
    clock.mockReturnValue(now + 120_000);
    delayed.resolve(phase.includes('validate')
      ? new Response(JSON.stringify({ webservices: { premiummailsettings: { url: 'https://svc.test' } } }))
      : recoverySnapshot(true));
    expect((await old).status).toBe(409);
    expect(calls).toHaveLength(1);
    expect(calls.some(url => url.endsWith('/deactivate'))).toBe(false);
    expect(getDb().prepare(`SELECT state, upstream_active FROM icloud_addresses`).get()).toEqual({ state: 'retiring', upstream_active: null });
  });

  it('completes the maximum bounded network sequence within the original 120-second lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'));
    const started = Date.now();
    recoveryFixture('');
    let lists = 0;
    const seenLeases: unknown[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      seenLeases.push((getDb().prepare(`SELECT retire_lease_until FROM icloud_addresses`).get() as { retire_lease_until: number }).retire_lease_until);
      await new Promise(resolve => setTimeout(resolve, 15_000));
      if (String(url).endsWith('/validate')) return new Response(JSON.stringify({ webservices: { premiummailsettings: { url: 'https://svc.test' } } }));
      if (String(url).endsWith('/list')) {
        if (++lists < 3) throw new TypeError('transient read disconnect');
        return recoverySnapshot(true);
      }
      return new Response(JSON.stringify({ success: true, result: {} }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const request = retireRecovery();
    await vi.runAllTimersAsync();
    expect((await request).status).toBe(200);
    expect(Date.now() - started).toBe(77_400);
    expect(seenLeases).toEqual(Array(5).fill(started + 120_000));
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/deactivate'))).toHaveLength(1);
  });

  it('erases the on-disk trust token when the account is deleted', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, auth_mode, trust_token)
       VALUES ('acc-del', 'del@icloud.com', 'srp', 'tok-xyz')`,
    ).run();
    // The token file is what the SRP flow writes; it is a 2FA-bypass credential
    // and must not survive the row it belongs to.
    const path = assertTestPath(trustTokenPath('del@icloud.com'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'tok-xyz', 'utf8');
    expect(existsSync(path)).toBe(true);

    const res = await app.request('/api/icloud/accounts/acc-del', {
      method: 'DELETE', headers: authHeaders('admin-secret'),
    });

    expect(res.status).toBe(200);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps account deletion retryable when the trust token cannot be erased', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, auth_mode, trust_token)
       VALUES ('acc-stuck-token', 'stuck@icloud.com', 'srp', 'tok-stuck')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id)
       VALUES ('keep-stuck@icloud.com', 'acc-stuck-token', 'anon-stuck')`,
    ).run();
    const path = assertTestPath(trustTokenPath('stuck@icloud.com'));
    mkdirSync(path, { recursive: true });
    writeFileSync(`${path}/credential`, 'tok-stuck', 'utf8');

    const res = await app.request('/api/icloud/accounts/acc-stuck-token', {
      method: 'DELETE', headers: authHeaders('admin-secret'),
    });

    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('trust token');
    expect(existsSync(`${path}/credential`)).toBe(true);
    const account = getDb().prepare(
      `SELECT id FROM icloud_accounts WHERE id = 'acc-stuck-token'`,
    ).get();
    const address = getDb().prepare(
      `SELECT hme FROM icloud_addresses WHERE account_id = 'acc-stuck-token'`,
    ).get();
    expect(account).toBeDefined();
    expect(address).toBeDefined();
  });

  it('refuses to retire an address a live inbox still holds', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url)
       VALUES ('acc-rt2', 'me@icloud.com', 'c', 'https://svc.test')`,
    ).run();
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state, assigned_inbox_id)
       VALUES ('busy@icloud.com', 'acc-rt2', 'anon-busy', 'assigned', 'ib-live')`,
    ).run();

    const res = await app.request('/api/icloud/addresses/busy@icloud.com/retire', {
      method: 'POST', headers: jsonHeaders(),
    });

    expect(res.status).toBe(409);
  });
});
