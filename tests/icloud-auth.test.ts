import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { assertTestPath, removeTestPath } from './helpers/test-storage.js';
import { getDb } from '../src/db.js';

const authState = vi.hoisted(() => ({
  status: 'MfaRequested' as string,
  mfaCalls: [] as string[],
  trustToken: '',
  authArgs: [] as unknown[],
  authCalls: 0,
  ctorOpts: undefined as Record<string, unknown> | undefined,
  cookieHeader: 'X-APPLE-WEBAUTH-TOKEN=srp; X-APPLE-WEBAUTH-USER=srp',
}));

// The package is `icloudjs` — the npm name `icloud.js` from the plan was
// unpublished in 2022. It ships a CommonJS build whose class hangs off
// `exports.default`, which is why the mock returns `{ default: … }`.
vi.mock('icloudjs', () => {
  class FakeService {
    accountInfo = { webservices: { premiummailsettings: { url: 'https://svc.test' } } };
    // Cookies come off the auth store's headers and the trust token off the
    // store itself; the library exposes no getCookies().
    authStore = {
      get trustToken() { return authState.trustToken; },
      getHeaders: () => ({ Cookie: authState.cookieHeader }),
    };
    status = authState.status;
    // Resolves once the cookie jar is populated. The real library fires that
    // work off unawaited, so every caller has to wait on this.
    awaitReady = Promise.resolve();
    constructor(opts: Record<string, unknown>) {
      authState.ctorOpts = opts;
    }
    async authenticate(username?: string, password?: string): Promise<void> {
      authState.authArgs = [username, password];
      authState.authCalls++;
      this.status = authState.status;
    }
    async provideMfaCode(code: string): Promise<void> {
      authState.mfaCalls.push(code);
      authState.trustToken = 'trust-abc';
      this.status = 'Trusted';
    }
  }
  return { default: FakeService };
});

const { beginSrpLogin, completeSrpLogin, trustTokenPath: rawTrustTokenPath, markAccountDeleted, deleteTrustToken, __resetDeleteTombstonesForTest } = await import('../src/providers/icloud-auth.js');
const trustTokenPath = (appleId: string) => assertTestPath(rawTrustTokenPath(appleId));
const { runRefillOnce } = await import('../src/providers/icloud-pool.js');
const { setSetting } = await import('../src/db.js');

beforeEach(() => {
  authState.status = 'MfaRequested';
  authState.mfaCalls = [];
  authState.trustToken = '';
  authState.authArgs = [];
  authState.authCalls = 0;
  authState.ctorOpts = undefined;
  __resetDeleteTombstonesForTest();
  authState.cookieHeader = 'X-APPLE-WEBAUTH-TOKEN=srp; X-APPLE-WEBAUTH-USER=srp';
  getDb().prepare(
    `INSERT INTO icloud_accounts (id, apple_id, auth_mode, password) VALUES ('acc-s', 'me@icloud.com', 'srp', 'pw')`,
  ).run();
});

describe('SRP login', () => {
  it('reports that a code is needed and records a pending session', async () => {
    const result = await beginSrpLogin('acc-s');

    expect(result.needsMfa).toBe(true);
    const row = getDb().prepare(
      `SELECT status FROM icloud_auth_sessions WHERE id = ?`,
    ).get(result.sessionId) as { status: string };
    expect(row.status).toBe('pending_mfa');
  });

  it('stores the trust token so the next login needs no code', async () => {
    const { sessionId } = await beginSrpLogin('acc-s');
    const done = await completeSrpLogin(sessionId, '123456', 'acc-s');

    expect(done.ok).toBe(true);
    expect(authState.mfaCalls).toEqual(['123456']);
    const row = getDb().prepare(
      `SELECT trust_token, cookies, status FROM icloud_accounts WHERE id = 'acc-s'`,
    ).get() as { trust_token: string; cookies: string; status: string };
    // The trust token is the whole point: without it every restart would ask
    // for a fresh 2FA code.
    expect(row.trust_token).toBe('trust-abc');
    expect(row.cookies).toContain('X-APPLE-WEBAUTH-TOKEN');
    expect(row.status).toBe('active');
  });

  it('skips the code entirely when Apple trusts the stored token', async () => {
    authState.status = 'Trusted';

    const result = await beginSrpLogin('acc-s');

    expect(result.needsMfa).toBe(false);
    expect(authState.mfaCalls).toEqual([]);
  });

  it('refuses a code for a session that has expired', async () => {
    const { sessionId } = await beginSrpLogin('acc-s');
    getDb().prepare(
      `UPDATE icloud_auth_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`,
    ).run(sessionId);

    const done = await completeSrpLogin(sessionId, '123456', 'acc-s');

    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/expired/i);
    expect(authState.mfaCalls).toEqual([]);
  });

  it('refuses a code for an unknown session', async () => {
    const done = await completeSrpLogin('no-such-session', '123456', 'acc-s');
    expect(done.ok).toBe(false);
  });

  it('refuses to complete a session under a different account', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, auth_mode, password) VALUES ('acc-other', 'other@icloud.com', 'srp', 'pw')`,
    ).run();
    const { sessionId } = await beginSrpLogin('acc-s');

    // The session is bound to the account that began it; the URL must agree.
    const done = await completeSrpLogin(sessionId, '123456', 'acc-other');

    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/different account/i);
    // The code was never spent against Apple.
    expect(authState.mfaCalls).toEqual([]);
  });

  it('refuses to replay an already-completed session', async () => {
    const { sessionId } = await beginSrpLogin('acc-s');
    expect((await completeSrpLogin(sessionId, '123456', 'acc-s')).ok).toBe(true);

    const replay = await completeSrpLogin(sessionId, '654321', 'acc-s');

    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/already completed/i);
    // The replay must not overwrite the completed record either.
    const row = getDb().prepare(
      `SELECT status FROM icloud_auth_sessions WHERE id = ?`,
    ).get(sessionId) as { status: string };
    expect(row.status).toBe('completed');
  });

  it('hands the stored trust token over through the file the library insists on reading', async () => {
    getDb().prepare(`UPDATE icloud_accounts SET trust_token = 'stored-token' WHERE id = 'acc-s'`).run();

    await beginSrpLogin('acc-s');

    // authenticate() unconditionally reloads the token from this path, so a
    // value set on the object is overwritten and only the file is read.
    expect(readFileSync(trustTokenPath('me@icloud.com'), 'utf8')).toBe('stored-token');
  });

  it.each([
    {
      name: 'erases a trust token file a mid-flight sign-in writes after the account was deleted',
      obstructErase: false,
      cookieHeader: 'X-APPLE-WEBAUTH-TOKEN=srp; X-APPLE-WEBAUTH-USER=srp',
      expectedOk: true,
      expectedStatus: 'completed',
    },
    {
      name: 'returns the sign-in error when the deleted account token cannot be erased',
      obstructErase: true,
      cookieHeader: 'X-APPLE-WEBAUTH-TOKEN=only',
      expectedOk: false,
      expectedStatus: 'failed',
    },
  ])('$name', async ({ obstructErase, cookieHeader, expectedOk, expectedStatus }) => {
    // The real leak: the icloudjs library writes a fresh token file when its
    // awaitReady resolves. If a DELETE lands while a sign-in is in flight, that
    // write can happen AFTER the delete erased the file, resurrecting a
    // 2FA-bypass credential with no account row left to own it. Model that
    // library write here as a file appearing during provideMfaCode().
    const { sessionId } = await beginSrpLogin('acc-s');

    // The DELETE route runs: it erases the current file and tombstones the
    // Apple ID. (The row deletion itself is irrelevant to the file leak.)
    deleteTrustToken('me@icloud.com');
    markAccountDeleted('me@icloud.com');

    const path = assertTestPath(trustTokenPath('me@icloud.com'));
    const logSpy = obstructErase
      ? vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      : undefined;
    try {
      // Now the in-flight library resolves and writes the token file back.
      if (obstructErase) {
        mkdirSync(path, { recursive: true });
        writeFileSync(`${path}/credential`, 'resurrected-token', 'utf8');
      } else {
        writeFileSync(path, 'resurrected-token', 'utf8');
      }
      authState.cookieHeader = cookieHeader;

      const done = await completeSrpLogin(sessionId, '123456', 'acc-s');

      expect(done.ok).toBe(expectedOk);
      const row = getDb().prepare(
        `SELECT status FROM icloud_auth_sessions WHERE id = ?`,
      ).get(sessionId) as { status: string };
      expect(row.status).toBe(expectedStatus);
      if (obstructErase) {
        expect(done.error).toMatch(/missing X-APPLE-WEBAUTH-USER/);
        const output = logSpy?.mock.calls.map(([chunk]) => String(chunk)).join('') ?? '';
        expect(output).toContain('"level":"warn"');
        expect(output).toContain('could not erase iCloud trust token after account was deleted mid-flight');
        expect(output).toContain('me@icloud.com');
        expect(output).toContain('"error":');
      } else {
        // Delete wins: completion must have erased the file the library resurrected.
        expect(existsSync(path)).toBe(false);
      }
      // Clear only the successful obstruction case so later sign-ins can use
      // the path; an assertion failure leaves its evidence untouched.
      if (obstructErase) removeTestPath(path);
    } finally {
      logSpy?.mockRestore();
    }
  });

  it('keeps a delete tombstone past a full session lifetime for a late Apple response', async () => {
    vi.useFakeTimers();
    try {
      const { sessionId } = await beginSrpLogin('acc-s');
      deleteTrustToken('me@icloud.com');
      markAccountDeleted('me@icloud.com');

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      writeFileSync(trustTokenPath('me@icloud.com'), 'late-token', 'utf8');
      const done = await completeSrpLogin(sessionId, '123456', 'acc-s');

      expect(done.ok).toBe(true);
      expect(existsSync(trustTokenPath('me@icloud.com'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the trust token file intact for a normal sign-in with no delete in flight', async () => {
    const { sessionId } = await beginSrpLogin('acc-s');
    // A normal completion — model the library's post-await file write.
    writeFileSync(trustTokenPath('me@icloud.com'), 'trust-abc', 'utf8');

    const done = await completeSrpLogin(sessionId, '123456', 'acc-s');

    expect(done.ok).toBe(true);
    // No delete raced, so the token the sign-in earned must survive.
    expect(existsSync(trustTokenPath('me@icloud.com'))).toBe(true);
  });

  it('always passes the Apple ID and password, so keytar is never reached', async () => {
    await beginSrpLogin('acc-s');

    // authenticate() falls back to require('keytar') the moment either is
    // missing, and that native module cannot load in a container.
    expect(authState.authArgs).toEqual(['me@icloud.com', 'pw']);
  });

  it('drops the expected keychain warning without hiding other icloudjs warnings', async () => {
    await beginSrpLogin('acc-s');
    const libraryLogger = authState.ctorOpts?.logger as ((level: number, ...args: unknown[]) => void) | undefined;
    expect(libraryLogger).toBeTypeOf('function');
    const output: string[] = [];
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    try {
      libraryLogger?.(2, 'Unable to save account credentials:', new Error('libsecret-1.so.0: cannot open shared object file'));
      libraryLogger?.(2, 'Authentication failed: upstream network unavailable');
      const toString = vi.fn(() => 'opaque-library-object-94');
      libraryLogger?.(3, 'opaque-library-token-93', { toString });
      expect(toString).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }

    const warnings = output
      .flatMap((chunk) => chunk.trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === 'warn' && entry.module === 'icloud-auth' && entry.msg === 'icloudjs');
    // Library warnings remain visible by account and severity. Arbitrary
    // upstream text is no longer part of the logging contract.
    expect(warnings).toHaveLength(2);
    expect(warnings.map(entry => [entry.accountId, entry.libraryLevel])).toEqual([['acc-s', 2], ['acc-s', 3]]);
    expect(warnings.every(entry => !('detail' in entry))).toBe(true);
    expect(output.join('')).not.toContain('opaque-library');
  });

  it('asks Apple to remember the session', async () => {
    await beginSrpLogin('acc-s');

    // icloudjs forwards saveCredentials as the sign-in body's rememberMe
    // (build/index.js:171). false would ask Apple NOT to remember the session,
    // shortening the very trust this flow exists to earn.
    expect(authState.ctorOpts?.saveCredentials).toBe(true);
  });
});

describe('what a sign-in may write to account health', () => {
  it('cures a degraded account, because a fresh session is exactly the cure', async () => {
    authState.status = 'Trusted';
    getDb().prepare(
      `UPDATE icloud_accounts SET status = 'degraded', last_error = 'cookie expired' WHERE id = 'acc-s'`,
    ).run();

    await beginSrpLogin('acc-s');

    const row = getDb().prepare(
      `SELECT status, last_error FROM icloud_accounts WHERE id = 'acc-s'`,
    ).get() as { status: string; last_error: string | null };
    expect(row.status).toBe('active');
    expect(row.last_error).toBeNull();
  });

  it('leaves a broken read half broken — a sign-in proves nothing about IMAP', async () => {
    authState.status = 'Trusted';
    getDb().prepare(
      `UPDATE icloud_accounts SET status = 'error', last_error = 'IMAP: authentication rejected' WHERE id = 'acc-s'`,
    ).run();

    await beginSrpLogin('acc-s');

    // /test computed 'error' from the IMAP half, which this sign-in never
    // touched. Writing 'active' here would put an account whose every poll
    // fails straight back into dispatch.
    const row = getDb().prepare(
      `SELECT status, last_error, cookies FROM icloud_accounts WHERE id = 'acc-s'`,
    ).get() as { status: string; last_error: string | null; cookies: string };
    expect(row.status).toBe('error');
    expect(row.last_error).toContain('IMAP');
    // The fresh session itself is still banked — it is the status that must not move.
    expect(row.cookies).toContain('X-APPLE-WEBAUTH-TOKEN');
  });

  it('refuses to store a session missing the cookies the HME service needs', async () => {
    authState.status = 'Trusted';
    authState.cookieHeader = 'X-APPLE-WEBAUTH-TOKEN=only; other=1';
    getDb().prepare(`UPDATE icloud_accounts SET cookies = 'X-OLD=1' WHERE id = 'acc-s'`).run();

    // The same bar a pasted cookie has to clear: storing this anyway would
    // surface an hour later as "session not valid" with nothing pointing here.
    await expect(beginSrpLogin('acc-s')).rejects.toThrow(/X-APPLE-WEBAUTH-USER/);
    const row = getDb().prepare(
      `SELECT cookies FROM icloud_accounts WHERE id = 'acc-s'`,
    ).get() as { cookies: string };
    expect(row.cookies).toBe('X-OLD=1');
  });
});

describe('silent SRP renewal from the refill task', () => {
  function degrade(): void {
    getDb().prepare(
      `UPDATE icloud_accounts
          SET status = 'degraded', last_error = 'cookie expired',
              cookies = 'X-OLD=1', hme_service_url = 'https://svc.test'
        WHERE id = 'acc-s'`,
    ).run();
  }

  it('renews a degraded SRP account without a human when Apple trusts the token', async () => {
    authState.status = 'Trusted';
    degrade();
    // Pool already at target so the pass never needs Apple's HME API — the
    // renewal itself goes through the mocked icloudjs, not fetch.
    setSetting('icloud_pool_target', '1');
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('full@icloud.com', 'acc-s', 'anon-full')`,
    ).run();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await runRefillOnce();

    const row = getDb().prepare(
      `SELECT status, cookies FROM icloud_accounts WHERE id = 'acc-s'`,
    ).get() as { status: string; cookies: string };
    // This is why the Apple ID password is stored at all.
    expect(row.status).toBe('active');
    expect(row.cookies).toContain('X-APPLE-WEBAUTH-TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('attempts renewal once per degradation, not once per tick', async () => {
    authState.status = 'MfaRequested';
    degrade();

    await runRefillOnce();
    await runRefillOnce();

    // Each begin makes Apple push a 2FA prompt to the owner's devices;
    // retrying every 15 minutes would buzz their phone until someone typed a
    // code. One attempt, then wait for a human.
    expect(authState.authCalls).toBe(1);
    const row = getDb().prepare(
      `SELECT status, last_error FROM icloud_accounts WHERE id = 'acc-s'`,
    ).get() as { status: string; last_error: string | null };
    expect(row.status).toBe('degraded');
    expect(row.last_error).toMatch(/2FA code/);
  });

  it('never tries to renew a cookie-mode account, which has no password path', async () => {
    degrade();
    getDb().prepare(`UPDATE icloud_accounts SET auth_mode = 'cookie', password = '' WHERE id = 'acc-s'`).run();

    await runRefillOnce();

    expect(authState.authCalls).toBe(0);
  });
});
