import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow, setSetting } from '../src/db.js';
import { app, jsonHeaders } from './helpers/http.js';
import { cleanupExpired } from '../src/app.js';

const oauthImapState = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, any>>,
  locks: [] as Array<{ path: string; options?: Record<string, unknown>; released: boolean }>,
  connectError: undefined as Error | undefined,
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    constructor(options: Record<string, any>) {
      oauthImapState.constructorOptions.push(options);
    }
    async connect(): Promise<void> {
      if (oauthImapState.connectError) throw oauthImapState.connectError;
    }
    once(): void {}
    close(): void {}
    async logout(): Promise<void> {}
    async getMailboxLock(path: string, options?: Record<string, unknown>): Promise<{ release(): void }> {
      const lock = { path, options, released: false };
      oauthImapState.locks.push(lock);
      return { release: () => { lock.released = true; } };
    }
    async search(): Promise<number[]> { return []; }
  }
  return { ImapFlow: FakeImapFlow };
});

const THUNDERBIRD_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const THUNDERBIRD_REDIRECT_URI = 'https://localhost';
const THUNDERBIRD_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/POP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
].join(' ');

function insertBareAccount(email = 'bare@outlook.com'): void {
  getDb().prepare(
    `INSERT INTO outlook_accounts (email, password, token_status)
     VALUES (?, ?, 'pending_oauth')`,
  ).run(email, 'pw');
}

function customOAuthBody(email = 'bare@outlook.com'): Record<string, string> {
  return {
    email,
    preset: 'custom',
    clientId: '11111111-1111-1111-1111-111111111111',
    redirectUri: 'http://localhost:3100/api/outlook/oauth/callback',
    scopes: 'offline_access https://graph.microsoft.com/Mail.Read',
    tenant: 'consumers',
  };
}

type OAuthStartResponse = {
  sessionId: string;
  authorizeUrl: string;
  email: string;
  status: string;
  preset: string;
  clientId: string;
  redirectUri: string;
  serverProxyConfigured: boolean;
};

async function startCustomOAuth(email = 'bare@outlook.com'): Promise<OAuthStartResponse> {
  const res = await app.request('/api/outlook/oauth/start', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(customOAuthBody(email)),
  });
  expect(res.status).toBe(200);
  return await res.json() as OAuthStartResponse;
}

async function startThunderbirdOAuth(email = 'bare@outlook.com'): Promise<OAuthStartResponse> {
  const res = await app.request('/api/outlook/oauth/start', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  return await res.json() as OAuthStartResponse;
}

function postOAuth(path: string, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.request(`/api/outlook/oauth/${path}`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body),
  }));
}

function sessionState(start: OAuthStartResponse): string {
  return new URL(start.authorizeUrl).searchParams.get('state')!;
}

function oauthSnapshot(): unknown {
  const db = getDb();
  return {
    accounts: db.prepare('SELECT * FROM outlook_accounts ORDER BY email').all(),
    sessions: db.prepare('SELECT * FROM outlook_oauth_sessions ORDER BY id').all(),
  };
}

function totalChanges(): number {
  return getRow<{ count: number }>(getDb(), 'SELECT total_changes() AS count')!.count;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function invalidateSession(start: OAuthStartResponse, change: string): Promise<void> {
  const db = getDb();
  if (change === 'superseded') {
    await startCustomOAuth();
  } else if (change === 'expired') {
    db.prepare(`UPDATE outlook_oauth_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(start.sessionId);
  } else if (change === 'assigned') {
    db.prepare(`UPDATE outlook_accounts SET assigned_inbox_id = 'new-owner' WHERE email = ?`).run(start.email);
  } else if (change === 'deleted') {
    db.prepare('DELETE FROM outlook_accounts WHERE email = ?').run(start.email);
  } else {
    db.prepare('UPDATE outlook_oauth_sessions SET status = ? WHERE id = ?').run(change, start.sessionId);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSetting('proxy_url', '');
  oauthImapState.constructorOptions = [];
  oauthImapState.locks = [];
  oauthImapState.connectError = undefined;
});

describe('Outlook OAuth completion', () => {
  it('retains a completed real OAuth transition after an older daily refresh rejects', async () => {
    const email = 'bare@outlook.com';
    insertBareAccount(email);
    getDb().prepare("UPDATE outlook_accounts SET client_id = 'old-client', refresh_token = 'old-refresh', token_status = 'valid' WHERE email = ?").run(email);
    const oldRefresh = deferred<Response>();
    const entered = deferred<void>();
    const grants: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/token')) {
        const grant = new URLSearchParams(String(init?.body)).get('grant_type')!;
        grants.push(grant);
        if (grant === 'refresh_token') { entered.resolve(); return oldRefresh.promise; }
        return new Response('{"access_token":"new-oauth-at","refresh_token":"new-oauth-rt"}');
      }
      return new Response('{"value":[]}');
    }));
    const running = cleanupExpired();
    await entered.promise;
    getDb().prepare("UPDATE outlook_accounts SET token_status = '' WHERE email = ?").run(email);
    const start = await startCustomOAuth();
    const complete = await postOAuth('code', { finalUrl: `http://localhost/?code=new-code&state=${sessionState(start)}` });
    expect(complete.status).toBe(200);
    expect(getDb().prepare('SELECT status FROM outlook_oauth_sessions WHERE id = ?').get(start.sessionId)).toEqual({ status: 'completed' });
    const account = getDb().prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email);
    oldRefresh.resolve(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await running;
    expect(getDb().prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email)).toEqual(account);
    expect(grants).toEqual(['refresh_token', 'authorization_code']);
  });

  it('keeps token-endpoint error text private in callback HTML, status, account and logs', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const output: string[] = [];
    const spies = [process.stdout, process.stderr].map(stream => vi.spyOn(stream, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; }));
    const raw = JSON.stringify({ error: 'invalid_grant', access_token: 'private-error-at', refresh_token: 'private-error-rt', error_description: 'private-error-at private-error-rt <script>opaque</script>' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 400 })));
    try {
      const callback = await app.request(`/api/outlook/oauth/callback?code=bad&state=${sessionState(start)}`);
      const status = await app.request(`/api/outlook/oauth/status/${start.sessionId}`, { headers: jsonHeaders() });
      const publicText = await callback.text() + await status.text() + JSON.stringify(getDb().prepare('SELECT oauth_last_error FROM outlook_accounts').all())
        + JSON.stringify(getDb().prepare('SELECT * FROM activity_log').all()) + output.join('');
      expect(publicText).not.toMatch(/private-error-at|private-error-rt|opaque/);
      expect(getDb().prepare('SELECT raw_response FROM outlook_credential_checkpoints WHERE http_status = 400').get()).toEqual({ raw_response: raw });
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it.each(['callback error', 'automation failure', 'automation started', 'automation waiting_user', 'automation completed'])(
    '%s cannot mutate completed, exchanging, failed, expired, superseded, or assigned sessions',
    async (entry) => {
      for (const change of ['completed', 'exchanging', 'failed', 'expired', 'superseded', 'assigned']) {
        // Each row uses an independent account, so a rejected old session cannot
        // hide an account write behind another row's expected outcome.
        const email = `${entry.replaceAll(' ', '-')}-${change}@outlook.com`;
        insertBareAccount(email);
        const start = await startCustomOAuth(email);
        if (change === 'superseded') await startCustomOAuth(email);
        else await invalidateSession(start, change);
        const before = oauthSnapshot();
        const writes = totalChanges();
        const res = entry === 'callback error'
          ? await app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&error=access_denied&error_description=old-error`)
          : await postOAuth('automation/report', { sessionId: start.sessionId, status: entry === 'automation failure' ? 'failed' : entry.split(' ')[1], error: 'old-error' });
        expect(res.status).toBe(entry === 'callback error' ? 200 : 409);
        expect(oauthSnapshot()).toEqual(before);
        expect(totalChanges()).toBe(writes);
      }
    },
  );

  it.each(['callback', 'code'])('%s rejects noncurrent authorization codes without network or writes', async (entry) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const change of ['failed', 'exchanging', 'expired', 'superseded', 'assigned', 'deleted']) {
      insertBareAccount(`${change}@outlook.com`);
      const start = await startCustomOAuth(`${change}@outlook.com`);
      if (change === 'superseded') await startCustomOAuth(start.email);
      else await invalidateSession(start, change);
      const before = oauthSnapshot();
      const writes = totalChanges();
      const res = entry === 'callback'
        ? await app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&code=single-use`)
        : await postOAuth('code', { state: sessionState(start), code: 'single-use' });
      expect(res.status).toBe(entry === 'callback' ? 200 : 400);
      expect(oauthSnapshot()).toEqual(before);
      expect(totalChanges()).toBe(writes);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['callback', 'code'])('%s completed replay succeeds without network or writes even after reassignment', async (entry) => {
    insertBareAccount();
    const start = await startCustomOAuth();
    await invalidateSession(start, 'completed');
    await invalidateSession(start, 'expired');
    await invalidateSession(start, 'assigned');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const before = oauthSnapshot();
    const writes = totalChanges();
    const res = entry === 'callback'
      ? await app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&code=used`)
      : await postOAuth('code', { state: sessionState(start), code: 'used' });
    expect(res.status).toBe(200);
    expect(oauthSnapshot()).toEqual(before);
    expect(totalChanges()).toBe(writes);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['callback', 'code'])('shares one exchange right when %s starts first and rejects errors, claims, and manual replacement', async (entry) => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const entered = deferred<void>();
    const exchange = deferred<Response>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (String(init?.body).includes('grant_type=authorization_code')) {
        entered.resolve();
        return exchange.promise;
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = entry === 'callback'
      ? app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&code=single-use`)
      : postOAuth('code', { state: sessionState(start), code: 'single-use' });
    await entered.promise;
    const before = oauthSnapshot();
    const writes = totalChanges();
    expect((await postOAuth('code', { state: sessionState(start), code: 'single-use' })).status).toBe(400);
    expect(await (await app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&code=single-use`)).text()).toContain('already exchanging');
    expect((await postOAuth('automation/report', { sessionId: start.sessionId, status: 'failed' })).status).toBe(409);
    await app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&error=access_denied`);
    expect((await postOAuth('start', customOAuthBody())).status).toBe(409);
    expect((await postOAuth('automation/claim', { includeFailed: true })).status).toBe(404);
    expect(oauthSnapshot()).toEqual(before);
    expect(totalChanges()).toBe(writes);
    exchange.resolve(new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), { status: 200 }));
    expect((await first).status).toBe(200);
    expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('grant_type=authorization_code'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('grant_type=refresh_token'))).toBe(false);
  });

  it.each([
    ['exchange', 'valid'], ['validation', 'valid'], ['validation', 'invalid'], ['validation', 'unknown'],
  ])('rechecks all account bindings after the %s await with %s validation and preserves credentials', async (boundary, outcome) => {
    for (const change of ['superseded', 'assigned', 'expired', 'deleted', 'failed']) {
      const email = `${boundary}-${change}@outlook.com`;
      insertBareAccount(email);
      const start = await startCustomOAuth(email);
      const entered = deferred<void>();
      const gate = deferred<Response>();
      if (outcome !== 'valid') oauthImapState.connectError = outcome === 'invalid'
        ? Object.assign(new Error('Authentication failed'), { authenticationFailed: true }) : new Error('IMAP unreachable');
      const tokens = { access_token: `access-${change}`, refresh_token: `refresh-${change}`, token_type: 'Bearer', scope: 'Mail.Read', expires_in: 3600, ext_expires_in: 7200, unexpected: 'must-not-persist' };
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const isExchange = String(init?.body).includes('grant_type=authorization_code');
        if ((boundary === 'exchange') === isExchange) {
          entered.resolve();
          return gate.promise;
        }
        return new Response(JSON.stringify(isExchange ? tokens : { value: [] }), { status: isExchange || outcome === 'valid' ? 200 : outcome === 'invalid' ? 401 : 503 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const pending = postOAuth('code', { state: sessionState(start), code: 'single-use' });
      await entered.promise;
      if (boundary === 'validation') {
        const checkpoint = getRow<{ credential_checkpoint: string }>(getDb(), 'SELECT credential_checkpoint FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)!;
        expect(JSON.parse(checkpoint.credential_checkpoint)).toMatchObject({ refresh_token: tokens.refresh_token, access_token: tokens.access_token });
        expect(getRow<{ token_status: string; refresh_token: string }>(getDb(), 'SELECT token_status, refresh_token FROM outlook_accounts WHERE email = ?', email)).toEqual({ token_status: 'pending_oauth', refresh_token: '' });
      }
      if (change === 'superseded') {
        // Simulate another operator/process changing the binding. Manual start
        // itself must refuse replacement while this exchange is live.
        getDb().prepare("UPDATE outlook_accounts SET oauth_last_session_id = 'new-session', client_id = 'new-client', refresh_token = 'new-refresh', token_status = 'valid', oauth_last_error = 'new-error' WHERE email = ?").run(email);
      } else await invalidateSession(start, change);
      const accounts = getDb().prepare('SELECT * FROM outlook_accounts ORDER BY email').all();
      const session = getRow(getDb(), 'SELECT status, error, updated_at FROM outlook_oauth_sessions WHERE id = ?', start.sessionId);
      gate.resolve(new Response(JSON.stringify(boundary === 'exchange' ? tokens : { value: [] }), { status: outcome === 'valid' ? 200 : outcome === 'invalid' ? 401 : 503 }));
      expect((await pending).status).toBe(400);
      expect(getDb().prepare('SELECT * FROM outlook_accounts ORDER BY email').all()).toEqual(accounts);
      expect(getRow(getDb(), 'SELECT status, error, updated_at FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)).toEqual(session);
      const checkpoint = getRow<{ credential_checkpoint: string }>(getDb(), 'SELECT credential_checkpoint FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)!;
      expect(JSON.parse(checkpoint.credential_checkpoint)).toMatchObject({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_type: 'Bearer', scope: 'Mail.Read', expires_in: 3600, ext_expires_in: 7200 });
      expect(checkpoint.credential_checkpoint).not.toContain('must-not-persist');
      const status = await app.request(`/api/outlook/oauth/status/${start.sessionId}`, { headers: jsonHeaders() });
      expect(await status.text()).not.toContain(tokens.refresh_token);
      expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('grant_type=refresh_token'))).toBe(false);
      if (boundary === 'exchange') expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['rejected', 'disconnected'])('ignores %s exchanges that finish after the account binding changes', async (outcome) => {
    for (const change of ['superseded', 'assigned', 'expired', 'deleted', 'failed']) {
      const email = `${outcome}-${change}@outlook.com`;
      insertBareAccount(email);
      const start = await startCustomOAuth(email);
      const entered = deferred<void>();
      const gate = deferred<void>();
      vi.stubGlobal('fetch', vi.fn(async () => {
        entered.resolve();
        await gate.promise;
        if (outcome === 'disconnected') throw new Error('exchange disconnected');
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }));
      const pending = postOAuth('code', { state: sessionState(start), code: 'single-use' });
      await entered.promise;
      if (change === 'superseded') getDb().prepare("UPDATE outlook_accounts SET oauth_last_session_id = 'new-session', oauth_last_error = 'new-error' WHERE email = ?").run(email);
      else await invalidateSession(start, change);
      const before = oauthSnapshot();
      const writes = totalChanges();
      gate.resolve();
      expect((await pending).status).toBe(400);
      expect(oauthSnapshot()).toEqual(before);
      // Received responses append private history even when stale; the owning
      // account/session snapshot above must still remain unchanged.
      expect(totalChanges()).toBe(writes + (outcome === 'rejected' ? 1 : 0));
    }
  });

  it('defers inconclusive mailbox validation while retaining the exchanged tokens', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    oauthImapState.connectError = new Error('IMAP unreachable');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => String(init?.body).includes('grant_type=authorization_code')
      ? new Response(JSON.stringify({ access_token: 'access', refresh_token: 'issued-refresh' }), { status: 200 })
      : new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await postOAuth('code', { state: sessionState(start), code: 'single-use' })).status).toBe(200);
    expect(getRow(getDb(), 'SELECT refresh_token, token_status, last_checked_at FROM outlook_accounts WHERE email = ?', start.email)).toEqual({ refresh_token: 'issued-refresh', token_status: '', last_checked_at: null });
    expect(getRow(getDb(), 'SELECT status FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)).toEqual({ status: 'completed' });
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('grant_type=refresh_token'))).toBe(false);
  });

  it('saves refresh-token-only exchanges with deferred validation and never refreshes them', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ refresh_token: 'issued-refresh' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await postOAuth('code', { state: sessionState(start), code: 'single-use' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRow(getDb(), 'SELECT refresh_token, token_status, last_checked_at FROM outlook_accounts WHERE email = ?', start.email)).toEqual({ refresh_token: 'issued-refresh', token_status: '', last_checked_at: null });
    const checkpoint = getRow<{ credential_checkpoint: string }>(getDb(), 'SELECT credential_checkpoint FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)!;
    expect(JSON.parse(checkpoint.credential_checkpoint)).toMatchObject({ refresh_token: 'issued-refresh' });
  });

  it.each(['access_token', 'refresh_token', 'both'])('preserves received %s credentials on a rejected exchange without completing it', async (material) => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const tokens = {
      ...(material !== 'refresh_token' ? { access_token: 'issued-access' } : {}),
      ...(material !== 'access_token' ? { refresh_token: 'issued-refresh' } : {}),
      token_type: 'Bearer', scope: 'Mail.Read', expires_in: 3600,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...tokens, error: 'invalid_grant', error_description: 'rejected exchange', unexpected: 'must-not-persist',
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await postOAuth('code', { state: sessionState(start), code: 'single-use' });
    expect(res.status).toBe(400);
    // Token-endpoint error text is untrusted credential-bearing data.
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'Token exchange failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRow(getDb(), 'SELECT refresh_token, token_status FROM outlook_accounts WHERE email = ?', start.email)).toEqual({ refresh_token: '', token_status: 'pending_oauth' });
    const checkpoint = getRow<{ credential_checkpoint: string }>(getDb(), 'SELECT credential_checkpoint FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)!;
    expect(JSON.parse(checkpoint.credential_checkpoint)).toEqual(tokens);
  });

  it.each(['password', 'automation/password'])('%s releases passwords only to a current pending unexpired unassigned session', async (entry) => {
    for (const change of ['completed', 'exchanging', 'failed', 'expired', 'superseded', 'assigned']) {
      const email = `${entry.replaceAll('/', '-')}-${change}@outlook.com`;
      insertBareAccount(email);
      const start = await startCustomOAuth(email);
      getDb().prepare("UPDATE outlook_oauth_sessions SET automation_status = 'claimed' WHERE id = ?").run(start.sessionId);
      if (change === 'superseded') await startCustomOAuth(email);
      else await invalidateSession(start, change);
      const res = await postOAuth(entry, { sessionId: start.sessionId });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain('"password"');
    }
  });

  it('keeps manual password access but requires an automation claim for automation passwords', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    expect((await postOAuth('password', { sessionId: start.sessionId })).status).toBe(200);
    expect((await postOAuth('automation/password', { sessionId: start.sessionId })).status).toBe(404);
    getDb().prepare("UPDATE outlook_oauth_sessions SET automation_status = 'claimed' WHERE id = ?").run(start.sessionId);
    expect((await postOAuth('automation/password', { sessionId: start.sessionId })).status).toBe(200);
  });

  it('lets only current pending errors finalize and keeps failed codes single use', async () => {
    for (const entry of ['callback', 'automation/report']) {
      const email = `${entry.replaceAll('/', '-')}@outlook.com`;
      insertBareAccount(email);
      const start = await startCustomOAuth(email);
      const res = entry === 'callback'
        ? await app.request(`/api/outlook/oauth/callback?state=${sessionState(start)}&error=access_denied`)
        : await postOAuth(entry, { sessionId: start.sessionId, status: 'failed', error: 'access_denied' });
      expect(res.status).toBe(200);
      expect(getRow(getDb(), 'SELECT status, error FROM outlook_oauth_sessions WHERE id = ?', start.sessionId)).toEqual({ status: 'failed', error: 'access_denied' });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const writes = totalChanges();
      expect((await postOAuth('code', { state: sessionState(start), code: 'used' })).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(totalChanges()).toBe(writes);
    }
  });
  it('does not exchange an authorization code twice after a lost token response', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    const fetchMock = vi.fn(async () => { throw new TypeError('token issued but response disconnected'); });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const pending = app.request(`/api/outlook/oauth/callback?code=single-use&state=${encodeURIComponent(state!)}`);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getRow<{ status: string }>(getDb(), `SELECT status FROM outlook_oauth_sessions WHERE id = ?`, start.sessionId)?.status)
        .toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a Thunderbird preset OAuth session without a configured custom client id', async () => {
    insertBareAccount();

    const data = await startThunderbirdOAuth();
    const url = new URL(data.authorizeUrl);

    expect(data).toMatchObject({
      email: 'bare@outlook.com',
      status: 'pending',
      preset: 'thunderbird',
      clientId: THUNDERBIRD_CLIENT_ID,
      redirectUri: THUNDERBIRD_REDIRECT_URI,
      serverProxyConfigured: false,
    });
    expect(data.sessionId).toBeTruthy();
    expect(url.searchParams.get('login_hint')).toBe('bare@outlook.com');
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe(THUNDERBIRD_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(THUNDERBIRD_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(THUNDERBIRD_SCOPES);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const session = getRow<{ email: string; status: string; preset: string }>(
      getDb(),
      `SELECT email, status, preset FROM outlook_oauth_sessions WHERE id = ?`,
      data.sessionId,
    );
    expect(session).toEqual({ email: 'bare@outlook.com', status: 'pending', preset: 'thunderbird' });
  });

  it('marks OAuth starts when the server has an outbound proxy configured', async () => {
    insertBareAccount();
    setSetting('proxy_url', 'http://127.0.0.1:18080');

    const data = await startThunderbirdOAuth();

    expect(data.serverProxyConfigured).toBe(true);
  });

  it('does not delete the account when callback state is invalid', async () => {
    insertBareAccount();

    const res = await app.request('/api/outlook/oauth/callback?code=abc&state=wrong-state');

    expect(res.status).toBe(200);
    const account = getRow<{ email: string }>(getDb(), `SELECT email FROM outlook_accounts WHERE email = ?`, 'bare@outlook.com');
    expect(account).toEqual({ email: 'bare@outlook.com' });
  });

  it('keeps the custom app callback flow working', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body || '');
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=authorization_code')) {
        return new Response(JSON.stringify({ access_token: 'access-from-code', refresh_token: 'refresh-from-code' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ access_token: 'access-from-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('graph.microsoft.com')) {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }));

    const res = await app.request(`/api/outlook/oauth/callback?code=auth-code&state=${encodeURIComponent(state!)}`);

    expect(res.status).toBe(200);
    const account = getRow<{ client_id: string; refresh_token: string; token_status: string }>(
      getDb(),
      `SELECT client_id, refresh_token, token_status FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({
      client_id: customOAuthBody().clientId,
      refresh_token: 'refresh-from-code',
      token_status: 'valid',
    });
    const session = getRow<{ status: string; error: string }>(
      getDb(),
      `SELECT status, error FROM outlook_oauth_sessions WHERE id = ?`,
      start.sessionId,
    );
    expect(session).toEqual({ status: 'completed', error: '' });
  });

  it('keeps completed OAuth sessions idempotent when the final URL is submitted again', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    let authorizationCodeExchanges = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body || '');
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=authorization_code')) {
        authorizationCodeExchanges++;
        if (authorizationCodeExchanges > 1) {
          return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code already used' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ access_token: 'access-from-code', refresh_token: 'refresh-from-code' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ access_token: 'access-from-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('graph.microsoft.com')) {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }));

    const finalUrl = `http://localhost:3100/api/outlook/oauth/callback?code=auth-code&state=${encodeURIComponent(state!)}`;
    const first = await app.request('/api/outlook/oauth/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ finalUrl }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/api/outlook/oauth/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ finalUrl }),
    });
    expect(second.status).toBe(200);
    expect(authorizationCodeExchanges).toBe(1);

    const account = getRow<{ refresh_token: string; token_status: string; oauth_last_error: string | null }>(
      getDb(),
      `SELECT refresh_token, token_status, oauth_last_error FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({ refresh_token: 'refresh-from-code', token_status: 'valid', oauth_last_error: null });
    const session = getRow<{ status: string; error: string }>(
      getDb(),
      `SELECT status, error FROM outlook_oauth_sessions WHERE id = ?`,
      start.sessionId,
    );
    expect(session).toEqual({ status: 'completed', error: '' });
  });

  it('keeps the account when token exchange fails', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'bad code',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    const res = await app.request(`/api/outlook/oauth/callback?code=bad-code&state=${encodeURIComponent(state!)}`);

    expect(res.status).toBe(200);
    const account = getRow<{ token_status: string; refresh_token: string; oauth_last_error: string }>(
      getDb(),
      `SELECT token_status, refresh_token, oauth_last_error FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({ token_status: 'pending_oauth', refresh_token: '', oauth_last_error: 'Token exchange failed' });
    const count = getRow<{ count: number }>(getDb(), `SELECT COUNT(*) AS count FROM outlook_accounts WHERE email = ?`, 'bare@outlook.com');
    expect(count?.count).toBe(1);
  });

  it('keeps the account pending when token validation fails after exchange', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    oauthImapState.connectError = Object.assign(new Error('Authentication failed'), { authenticationFailed: true });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body || '');
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=authorization_code')) {
        return new Response(JSON.stringify({ access_token: 'access-from-code', refresh_token: 'refresh-from-code' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 401 });
    }));

    const res = await app.request(`/api/outlook/oauth/callback?code=auth-code&state=${encodeURIComponent(state!)}`);

    expect(res.status).toBe(200);
    const account = getRow<{ token_status: string; refresh_token: string; oauth_last_error: string }>(
      getDb(),
      `SELECT token_status, refresh_token, oauth_last_error FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({
      token_status: 'pending_oauth',
      refresh_token: 'refresh-from-code',
      oauth_last_error: 'Refresh token saved, but token validation failed',
    });
    const session = getRow<{ status: string; error: string }>(
      getDb(),
      `SELECT status, error FROM outlook_oauth_sessions WHERE id = ?`,
      start.sessionId,
    );
    expect(session).toEqual({
      status: 'failed',
      error: 'Refresh token saved, but token validation failed',
    });
  });

  it('exchanges a Thunderbird finalUrl through /oauth/code and validates via IMAP XOAUTH2', async () => {
    insertBareAccount();
    const start = await startThunderbirdOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body || '');
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=authorization_code')) {
        expect(body).toContain(`redirect_uri=${encodeURIComponent(THUNDERBIRD_REDIRECT_URI)}`);
        return new Response(JSON.stringify({ access_token: 'access-from-code', refresh_token: 'refresh-from-code' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/oauth2/v2.0/token') && body.includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ access_token: 'access-from-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('graph.microsoft.com')) {
        return new Response('{}', { status: 401 });
      }
      if (url.includes('outlook.office.com/api/')) {
        return new Response('{}', { status: 401 });
      }
      return new Response('{}', { status: 404 });
    }));

    const res = await app.request('/api/outlook/oauth/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ finalUrl: `https://localhost/?code=auth-code&state=${encodeURIComponent(state!)}` }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      sessionId: start.sessionId,
      email: 'bare@outlook.com',
      preset: 'thunderbird',
      status: 'completed',
    });
    const account = getRow<{ client_id: string; refresh_token: string; token_status: string; api_type: string }>(
      getDb(),
      `SELECT client_id, refresh_token, token_status, api_type FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({
      client_id: THUNDERBIRD_CLIENT_ID,
      refresh_token: 'refresh-from-code',
      token_status: 'valid',
      api_type: 'imap',
    });
    expect(oauthImapState.constructorOptions[0]?.auth).toEqual({
      user: 'bare@outlook.com',
      accessToken: 'access-from-code',
    });
    expect(oauthImapState.locks).toEqual([{
      path: 'INBOX',
      options: { readOnly: true },
      released: true,
    }]);
  });

  it('rejects /oauth/code state mismatches without deleting the account', async () => {
    insertBareAccount();
    await startThunderbirdOAuth();

    const res = await app.request('/api/outlook/oauth/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ finalUrl: 'https://localhost/?code=auth-code&state=wrong-state' }),
    });

    expect(res.status).toBe(400);
    const account = getRow<{ email: string }>(getDb(), `SELECT email FROM outlook_accounts WHERE email = ?`, 'bare@outlook.com');
    expect(account).toEqual({ email: 'bare@outlook.com' });
  });

  it('rejects expired /oauth/code sessions without deleting the account', async () => {
    insertBareAccount();
    const start = await startThunderbirdOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    getDb().prepare(`UPDATE outlook_oauth_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(start.sessionId);

    const res = await app.request('/api/outlook/oauth/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ finalUrl: `https://localhost/?code=auth-code&state=${encodeURIComponent(state!)}` }),
    });

    expect(res.status).toBe(400);
    const account = getRow<{ token_status: string; refresh_token: string }>(
      getDb(),
      `SELECT token_status, refresh_token FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({ token_status: 'pending_oauth', refresh_token: '' });
  });

  it('keeps the account when /oauth/code token exchange fails', async () => {
    insertBareAccount();
    const start = await startThunderbirdOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'bad code',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    const res = await app.request('/api/outlook/oauth/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ finalUrl: `https://localhost/?code=bad-code&state=${encodeURIComponent(state!)}` }),
    });

    expect(res.status).toBe(400);
    const account = getRow<{ token_status: string; refresh_token: string; oauth_last_error: string }>(
      getDb(),
      `SELECT token_status, refresh_token, oauth_last_error FROM outlook_accounts WHERE email = ?`,
      'bare@outlook.com',
    );
    expect(account).toEqual({ token_status: 'pending_oauth', refresh_token: '', oauth_last_error: 'Token exchange failed' });
    const count = getRow<{ count: number }>(getDb(), `SELECT COUNT(*) AS count FROM outlook_accounts WHERE email = ?`, 'bare@outlook.com');
    expect(count?.count).toBe(1);
  });

  it('returns the password for a pending OAuth session without exposing tokens', async () => {
    insertBareAccount();
    const start = await startThunderbirdOAuth();

    const res = await app.request('/api/outlook/oauth/password', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: start.sessionId }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      email: 'bare@outlook.com',
      password: 'pw',
    });
  });

  it('returns the password by email only for unassigned OAuth-completable accounts', async () => {
    const db = getDb();
    insertBareAccount('pending@outlook.com');
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('valid@outlook.com', 'valid-pw', 'client', 'refresh', 'valid');
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, token_status, assigned_inbox_id)
       VALUES (?, ?, ?, ?)`,
    ).run('assigned@outlook.com', 'assigned-pw', 'pending_oauth', 'existing');

    const pending = await app.request('/api/outlook/oauth/password', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'pending@outlook.com' }),
    });
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toEqual({
      email: 'pending@outlook.com',
      password: 'pw',
    });

    const valid = await app.request('/api/outlook/oauth/password', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'valid@outlook.com' }),
    });
    expect(valid.status).toBe(409);

    const assigned = await app.request('/api/outlook/oauth/password', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'assigned@outlook.com' }),
    });
    expect(assigned.status).toBe(409);
  });

  it('keeps user callback error text out of the public HTML response', async () => {
    insertBareAccount();
    const start = await startCustomOAuth();
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: '<script>alert("xss")</script>',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    const res = await app.request(`/api/outlook/oauth/callback?error=access_denied&error_description=${encodeURIComponent('<script>alert("xss")</script>')}&state=${encodeURIComponent(state!)}`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('<script>alert("xss")</script>');
    expect(text).not.toContain('xss');
    expect(text).toContain('Microsoft returned an OAuth error');
  });

  it('automation claim defaults to Thunderbird and skips valid and assigned accounts', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('valid@outlook.com', 'pw', 'client', 'refresh', 'valid');
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, token_status, assigned_inbox_id)
       VALUES (?, ?, ?, ?)`,
    ).run('assigned@outlook.com', 'pw', 'pending_oauth', 'existing');
    insertBareAccount('claim@outlook.com');

    setSetting('proxy_url', 'http://127.0.0.1:18080');
    const res = await app.request('/api/outlook/oauth/automation/claim', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ includeProxy: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as {
      email: string;
      authorizeUrl: string;
      password?: string;
      preset: string;
      redirectUri: string;
      serverProxyConfigured: boolean;
      proxyUrl?: string;
    };
    expect(data.email).toBe('claim@outlook.com');
    expect(data.preset).toBe('thunderbird');
    expect(data.redirectUri).toBe(THUNDERBIRD_REDIRECT_URI);
    expect(data.password).toBeUndefined();
    expect(data.serverProxyConfigured).toBe(true);
    expect(data.proxyUrl).toBe('http://127.0.0.1:18080');
    expect(new URL(data.authorizeUrl).searchParams.get('login_hint')).toBe('claim@outlook.com');
    expect(new URL(data.authorizeUrl).searchParams.get('client_id')).toBe(THUNDERBIRD_CLIENT_ID);
  });

  it('automation claim skips OAuth failures unless includeFailed is true', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, token_status, oauth_last_error, created_at)
       VALUES (?, ?, 'pending_oauth', ?, ?)`,
    ).run('failed@outlook.com', 'pw', 'oauth failed', '2026-01-01 00:00:00');
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, token_status, created_at)
       VALUES (?, ?, 'pending_oauth', ?)`,
    ).run('clean@outlook.com', 'pw', '2026-01-02 00:00:00');

    const defaultRes = await app.request('/api/outlook/oauth/automation/claim', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    expect(defaultRes.status).toBe(200);
    const defaultData = await defaultRes.json() as { email: string };
    expect(defaultData.email).toBe('clean@outlook.com');

    const includeFailedRes = await app.request('/api/outlook/oauth/automation/claim', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ includeFailed: true }),
    });

    expect(includeFailedRes.status).toBe(200);
    const includeFailedData = await includeFailedRes.json() as { email: string };
    expect(includeFailedData.email).toBe('failed@outlook.com');
  });
});
