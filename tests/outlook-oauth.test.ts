import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow, setSetting } from '../src/db.js';
import { app, jsonHeaders } from './helpers/http.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
  setSetting('proxy_url', '');
});

describe('Outlook OAuth completion', () => {
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
    expect(account).toEqual({ token_status: 'pending_oauth', refresh_token: '', oauth_last_error: 'bad code' });
    const count = getRow<{ count: number }>(getDb(), `SELECT COUNT(*) AS count FROM outlook_accounts WHERE email = ?`, 'bare@outlook.com');
    expect(count?.count).toBe(1);
  });

  it('keeps the account pending when token validation fails after exchange', async () => {
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
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
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

  it('exchanges a Thunderbird finalUrl through /oauth/code and validates via Outlook fallback', async () => {
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
      if (url.includes('outlook.office.com')) {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
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
      api_type: 'outlook',
    });
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
    expect(account).toEqual({ token_status: 'pending_oauth', refresh_token: '', oauth_last_error: 'bad code' });
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

  it('escapes OAuth callback token-exchange errors in the public HTML response', async () => {
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

    const res = await app.request(`/api/outlook/oauth/callback?code=bad-code&state=${encodeURIComponent(state!)}`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('<script>alert("xss")</script>');
    expect(text).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
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
