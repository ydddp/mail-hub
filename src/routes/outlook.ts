import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { allRows, getDb, getRow, getSetting, logActivity, setSetting } from '../db.js';
import { checkToken, renewToken } from '../providers/outlook.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { importDelimited } from '../import-utils.js';
import { fetchWithTimeout, runConcurrent } from '../utils.js';
import { config } from '../config.js';
import { errorMessage } from '../errors.js';

const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com';
const OAUTH_SESSION_TTL_MINUTES = 30;
const OAUTH_CLAIM_STATUSES = ['pending_oauth', 'no_token'] as const;
const OAUTH_COMPLETABLE_STATUSES = new Set<string>([...OAUTH_CLAIM_STATUSES, 'invalid', '']);
const THUNDERBIRD_OAUTH_PRESET = {
  preset: 'thunderbird',
  clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
  redirectUri: 'https://localhost',
  scopes: [
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'https://outlook.office.com/POP.AccessAsUser.All',
    'https://outlook.office.com/SMTP.Send',
    'offline_access',
  ].join(' '),
  tenant: 'common',
} as const;

type OAuthPreset = 'custom' | 'thunderbird';

type OutlookOAuthSettings = {
  clientId: string;
  redirectUri: string;
  scopes: string;
  tenant: string;
  preset: OAuthPreset;
};

type OAuthSessionRow = {
  id: string;
  email: string;
  client_id: string;
  redirect_uri: string;
  scopes: string;
  tenant: string;
  preset: OAuthPreset;
  state_hash: string;
  code_verifier: string;
  status: string;
  error: string;
  expires_at: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomBase64Url(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function sha256Base64Url(value: string): string {
  return base64Url(createHash('sha256').update(value).digest());
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeTenant(value: string): string {
  const tenant = value.trim();
  return tenant || 'consumers';
}

function normalizePreset(value: unknown): OAuthPreset {
  return value === 'custom' ? 'custom' : 'thunderbird';
}

function getOAuthSettings(preset: OAuthPreset, overrides: Partial<OutlookOAuthSettings> = {}): OutlookOAuthSettings {
  if (preset === 'thunderbird') {
    return { ...THUNDERBIRD_OAUTH_PRESET };
  }
  return {
    clientId: overrides.clientId?.trim() || getSetting('outlook_oauth_client_id', config.outlookOAuthClientId).trim(),
    redirectUri: overrides.redirectUri?.trim() || getSetting('outlook_oauth_redirect_uri', config.outlookOAuthRedirectUri).trim(),
    scopes: overrides.scopes?.trim() || getSetting('outlook_oauth_scopes', config.outlookOAuthScopes).trim(),
    tenant: normalizeTenant(overrides.tenant || getSetting('outlook_oauth_tenant', config.outlookOAuthTenant)),
    preset: 'custom',
  };
}

function ensureOAuthSettings(settings: OutlookOAuthSettings): string | null {
  if (!settings.clientId) return 'Missing Outlook OAuth client_id';
  if (!settings.redirectUri) return 'Missing Outlook OAuth redirect_uri';
  if (!settings.scopes) return 'Missing Outlook OAuth scopes';
  return null;
}

function isServerProxyConfigured(): boolean {
  return Boolean(getSetting('proxy_url') || config.proxyUrl);
}

function getServerProxyUrl(): string {
  return getSetting('proxy_url') || config.proxyUrl;
}

function buildAuthorizeUrl(settings: OutlookOAuthSettings, email: string, state: string, codeChallenge: string): string {
  const url = new URL(`${MICROSOFT_AUTHORITY}/${encodeURIComponent(settings.tenant)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', settings.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('login_hint', email);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function publicSession(row: Pick<OAuthSessionRow, 'id' | 'email' | 'status' | 'error' | 'preset'>): Record<string, string> {
  return {
    sessionId: row.id,
    email: row.email,
    status: row.status,
    preset: row.preset,
    ...(row.error ? { error: row.error } : {}),
  };
}

function createOAuthSession(email: string, settings: OutlookOAuthSettings, automationStatus = ''): {
  sessionId: string;
  authorizeUrl: string;
  status: string;
  preset: OAuthPreset;
  clientId: string;
  redirectUri: string;
} {
  const db = getDb();
  const sessionId = randomUUID();
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const authorizeUrl = buildAuthorizeUrl(settings, email, state, codeChallenge);

  db.prepare(`
    INSERT INTO outlook_oauth_sessions
      (id, email, client_id, redirect_uri, scopes, tenant, preset, state_hash, code_verifier, status, automation_status, claimed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CASE WHEN ? != '' THEN datetime('now') ELSE NULL END, datetime('now', ?))
  `).run(
    sessionId,
    email,
    settings.clientId,
    settings.redirectUri,
    settings.scopes,
    settings.tenant,
    settings.preset,
    sha256Hex(state),
    codeVerifier,
    automationStatus,
    automationStatus,
    `+${OAUTH_SESSION_TTL_MINUTES} minutes`,
  );
  db.prepare(`
    UPDATE outlook_accounts
    SET token_status = 'pending_oauth',
        oauth_last_session_id = ?,
        oauth_last_error = NULL
    WHERE email = ?
  `).run(sessionId, email);

  return {
    sessionId,
    authorizeUrl,
    status: 'pending',
    preset: settings.preset,
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
  };
}

function getCompletableAccount(email: string): { email: string; password: string; assigned_inbox_id: string | null; client_id: string; refresh_token: string; token_status: string } | undefined {
  return getRow<{ email: string; password: string; assigned_inbox_id: string | null; client_id: string; refresh_token: string; token_status: string }>(getDb(), `
    SELECT email, password, assigned_inbox_id, client_id, refresh_token, COALESCE(token_status, '') AS token_status
    FROM outlook_accounts WHERE email = ?
  `, email);
}

function getOAuthSessionByState(state: string): OAuthSessionRow | undefined {
  return getRow<OAuthSessionRow>(getDb(), `
    SELECT id, email, client_id, redirect_uri, scopes, tenant, preset, state_hash, code_verifier, status, error, expires_at
    FROM outlook_oauth_sessions WHERE state_hash = ?
  `, sha256Hex(state));
}

function claimOAuthAccount(
  settings: OutlookOAuthSettings,
  automationStatus: 'manual' | 'claimed',
  includeFailed = false,
): { sessionId: string; email: string; status: string; authorizeUrl: string; preset: OAuthPreset; clientId: string; redirectUri: string } | null {
  const failedFilter = includeFailed ? '' : `AND COALESCE(oauth_last_error, '') = ''`;
  const account = getRow<{ email: string }>(getDb(), `
    SELECT email
    FROM outlook_accounts
    WHERE assigned_inbox_id IS NULL
      AND (client_id = '' OR refresh_token = '' OR COALESCE(token_status, '') IN (?, ?))
      ${failedFilter}
    ORDER BY created_at ASC
    LIMIT 1
  `, ...OAUTH_CLAIM_STATUSES);
  if (!account) return null;

  const claimError = ensureOAuthSettings(settings);
  if (claimError) throw new Error(claimError);

  const session = createOAuthSession(account.email, settings, automationStatus);
  return { ...session, email: account.email };
}

async function exchangeAuthorizationCode(session: OAuthSessionRow, code: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: session.client_id,
    grant_type: 'authorization_code',
    code,
    redirect_uri: session.redirect_uri,
    code_verifier: session.code_verifier,
  });
  const res = await fetchWithTimeout(`${MICROSOFT_AUTHORITY}/${encodeURIComponent(session.tenant)}/oauth2/v2.0/token`, {
    timeout: 15000,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({})) as OAuthTokenResponse;
  if (!res.ok) {
    return { error: data.error || `token_exchange_${res.status}`, error_description: data.error_description || 'Token exchange failed' };
  }
  return data;
}

function isOAuthSessionExpired(session: OAuthSessionRow): boolean {
  return new Date(`${session.expires_at}Z`).getTime() < Date.now();
}

function oauthErrorMessage(data: OAuthTokenResponse, fallback: string): string {
  return data.error_description || data.error || fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function completeOAuthCodeExchange(session: OAuthSessionRow, code: string): Promise<{ ok: boolean; message: string }> {
  const db = getDb();
  if (session.status === 'completed') {
    return { ok: true, message: 'Refresh token saved' };
  }
  if (session.status === 'exchanging') {
    return { ok: false, message: 'OAuth session is already exchanging' };
  }
  if (isOAuthSessionExpired(session)) {
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = 'OAuth session expired', updated_at = datetime('now') WHERE id = ?`).run(session.id);
    return { ok: false, message: 'OAuth session expired' };
  }

  const account = getRow<{ email: string; assigned_inbox_id: string | null }>(
    db,
    `SELECT email, assigned_inbox_id FROM outlook_accounts WHERE email = ?`,
    session.email,
  );
  if (!account) {
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = 'Outlook account not found', updated_at = datetime('now') WHERE id = ?`).run(session.id);
    return { ok: false, message: 'Outlook account not found' };
  }
  if (account.assigned_inbox_id) {
    const message = 'Outlook account is already claimed';
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(message, session.id);
    db.prepare(`UPDATE outlook_accounts SET oauth_last_error = ? WHERE email = ?`).run(message, session.email);
    return { ok: false, message };
  }

  try {
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'exchanging', updated_at = datetime('now') WHERE id = ?`).run(session.id);
    const exchanged = await exchangeAuthorizationCode(session, code);
    if (!exchanged.refresh_token) {
      const message = oauthErrorMessage(exchanged, 'Token exchange did not return refresh_token');
      db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(message, session.id);
      db.prepare(`UPDATE outlook_accounts SET token_status = 'pending_oauth', oauth_last_error = ? WHERE email = ?`).run(message, session.email);
      return { ok: false, message };
    }

    db.prepare(`
      UPDATE outlook_accounts
      SET client_id = ?,
          refresh_token = ?,
          token_status = 'validating',
          oauth_last_error = NULL,
          oauth_last_session_id = ?,
          token_renewed_at = datetime('now')
      WHERE email = ?
    `).run(session.client_id, exchanged.refresh_token, session.id, session.email);

    const checked = await checkToken(session.email, session.client_id, exchanged.refresh_token);
    if (!checked.valid) {
      const message = 'Refresh token saved, but token validation failed';
      db.prepare(`
        UPDATE outlook_accounts
        SET token_status = 'pending_oauth',
            oauth_last_error = ?,
            last_checked_at = datetime('now')
        WHERE email = ?
      `).run(message, session.email);
      db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(message, session.id);
      return { ok: false, message };
    }
    db.prepare(`
      UPDATE outlook_accounts
      SET token_status = 'valid',
          api_type = CASE WHEN ? != '' THEN ? ELSE api_type END,
          last_checked_at = datetime('now')
      WHERE email = ?
    `).run(checked.apiType, checked.apiType, session.email);
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'completed', error = '', updated_at = datetime('now') WHERE id = ?`).run(session.id);
    return { ok: true, message: 'Refresh token saved' };
  } catch (e) {
    const message = errorMessage(e);
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(message, session.id);
    db.prepare(`UPDATE outlook_accounts SET token_status = 'pending_oauth', oauth_last_error = ? WHERE email = ?`).run(message, session.email);
    return { ok: false, message };
  }
}

function parseFinalOAuthUrl(finalUrl: string): { code: string; state: string } {
  const url = new URL(finalUrl);
  return {
    code: url.searchParams.get('code') || '',
    state: url.searchParams.get('state') || '',
  };
}

export function parseCredentials(parts: string[]): { clientId: string; refreshToken: string } {
  const fields = parts.slice(2).map(s => s.trim()).filter(Boolean);
  let clientId = '';
  let refreshToken = '';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const f of fields) {
    if (!clientId && uuidPattern.test(f)) {
      clientId = f;
    } else if (!refreshToken && f.length > 50) {
      refreshToken = f;
    }
  }
  if (!clientId && !refreshToken && fields.length >= 2) {
    clientId = fields[fields.length - 1];
    refreshToken = fields[fields.length - 2];
  } else if (!clientId && fields.length >= 1) {
    clientId = fields[0];
  } else if (!refreshToken && fields.length >= 1) {
    for (const f of fields) {
      if (f !== clientId) { refreshToken = f; break; }
    }
  }
  return { clientId, refreshToken };
}

export const outlookRoutes = new Hono<AdminEnv>();

outlookRoutes.use('/outlook/*', async (c, next) => {
  if (c.req.path.endsWith('/outlook/oauth/callback')) return next();
  return requireAdmin(c, next);
});

outlookRoutes.post('/outlook/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw: string = body.accounts || '';
  if (!raw.trim()) return c.json({ error: 'Missing required field: accounts' }, 400);

  const accountType = body.type === 'short' ? 'short' : 'long';
  const groupName = body.group || (accountType === 'long' ? 'Manual import' : 'Ungrouped');

  const result = importDelimited(raw, 'outlook_accounts', ['email', 'password', 'client_id', 'refresh_token', 'account_type', 'group_name', 'token_status'], (parts, line) => {
    if (parts.length < 2) return { skip: true, reason: `Invalid format: ${line.slice(0, 40)}` };
    const email = parts[0].trim();
    const password = parts[1].trim();
    const { clientId, refreshToken } = parseCredentials(parts);
    if (!email || !password) return { skip: true, reason: `Email or password is empty: ${line.slice(0, 40)}` };
    const tokenStatus = clientId && refreshToken ? '' : 'pending_oauth';
    return { values: [email, password, clientId, refreshToken, accountType, groupName, tokenStatus] };
  });
  if (result.imported > 0) logActivity('blue', `Imported ${result.imported} Outlook accounts`);
  return c.json({ ...result, errors: result.errors.slice(0, 20) });
});

outlookRoutes.post('/outlook/oauth/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim();
  if (!email) return c.json({ error: 'Missing required field: email' }, 400);

  const account = getCompletableAccount(email);
  if (!account) return c.json({ error: 'Outlook account not found' }, 404);
  if (account.assigned_inbox_id) return c.json({ error: 'Outlook account is already claimed' }, 409);
  if (account.client_id && account.refresh_token && !OAUTH_COMPLETABLE_STATUSES.has(account.token_status)) {
    return c.json({ error: `Outlook account status '${account.token_status || 'unchecked'}' is not completable via OAuth` }, 409);
  }

  const preset = normalizePreset(body.preset);
  const settings = getOAuthSettings(preset, {
    clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
    redirectUri: typeof body.redirectUri === 'string' ? body.redirectUri : undefined,
    scopes: typeof body.scopes === 'string' ? body.scopes : undefined,
    tenant: typeof body.tenant === 'string' ? body.tenant : undefined,
  });
  if (!settings.clientId && account.client_id) settings.clientId = account.client_id;
  const settingsError = ensureOAuthSettings(settings);
  if (settingsError) return c.json({ error: settingsError }, 400);

  const session = createOAuthSession(email, settings, 'manual');
  return c.json({
    ...session,
    email,
    serverProxyConfigured: isServerProxyConfigured(),
  });
});

outlookRoutes.get('/outlook/oauth/callback', async (c) => {
  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  const oauthError = c.req.query('error') || '';
  const oauthErrorDescription = c.req.query('error_description') || '';
  const db = getDb();

  function html(title: string, body: string): Response {
    const safeTitle = escapeHtml(title);
    const safeBody = escapeHtml(body);
    return c.html(`<!doctype html><meta charset="utf-8"><title>${safeTitle}</title><body style="font-family:system-ui,sans-serif;padding:24px;line-height:1.6"><h2>${safeTitle}</h2><p>${safeBody}</p><script>try{window.opener&&window.opener.postMessage({type:'outlook-oauth-complete'}, window.location.origin)}catch(e){} setTimeout(()=>window.close(),1200)</script></body>`);
  }

  if (!state) return html('Outlook OAuth failed', 'Missing state.');
  const session = getOAuthSessionByState(state);
  if (!session) return html('Outlook OAuth failed', 'Invalid or expired state.');

  if (oauthError) {
    const message = oauthErrorDescription || oauthError;
    db.prepare(`UPDATE outlook_oauth_sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(message, session.id);
    db.prepare(`UPDATE outlook_accounts SET token_status = 'pending_oauth', oauth_last_error = ? WHERE email = ?`).run(message, session.email);
    return html('Outlook OAuth failed', 'Microsoft returned an OAuth error. You can retry from Mail-Hub.');
  }
  if (!code) return html('Outlook OAuth failed', 'Missing authorization code.');

  const result = await completeOAuthCodeExchange(session, code);
  if (result.ok) return html('Outlook OAuth completed', 'Refresh token saved. You can return to Mail-Hub.');
  return html('Outlook OAuth failed', `${result.message}. You can retry from Mail-Hub.`);
});

outlookRoutes.post('/outlook/oauth/code', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let code = typeof body.code === 'string' ? body.code.trim() : '';
  let state = typeof body.state === 'string' ? body.state.trim() : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';

  if (typeof body.finalUrl === 'string' && body.finalUrl.trim()) {
    try {
      const parsed = parseFinalOAuthUrl(body.finalUrl.trim());
      code ||= parsed.code;
      state ||= parsed.state;
    } catch {
      return c.json({ error: 'Invalid finalUrl' }, 400);
    }
  }
  if (!code) return c.json({ error: 'Missing required field: code' }, 400);
  if (!state) return c.json({ error: 'Missing required field: state' }, 400);

  const session = getOAuthSessionByState(state);
  if (!session) return c.json({ error: 'Invalid or expired OAuth state' }, 400);
  if (sessionId && session.id !== sessionId) return c.json({ error: 'OAuth session does not match state' }, 400);

  const result = await completeOAuthCodeExchange(session, code);
  if (!result.ok) return c.json({ error: result.message, sessionId: session.id, status: 'failed' }, 400);
  return c.json({ ok: true, sessionId: session.id, email: session.email, preset: session.preset, status: 'completed' });
});

outlookRoutes.get('/outlook/oauth/status/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const row = getRow<Pick<OAuthSessionRow, 'id' | 'email' | 'status' | 'error' | 'preset'>>(getDb(), `
    SELECT id, email, status, error, preset FROM outlook_oauth_sessions WHERE id = ?
  `, sessionId);
  if (!row) return c.json({ error: 'OAuth session not found' }, 404);
  return c.json(publicSession(row));
});

outlookRoutes.post('/outlook/oauth/password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body.sessionId || '').trim();
  const email = String(body.email || '').trim();
  if (!sessionId && !email) return c.json({ error: 'Missing required field: sessionId or email' }, 400);

  const row = sessionId
    ? getRow<{ email: string; password: string; token_status: string; assigned_inbox_id: string | null; client_id: string; refresh_token: string }>(getDb(), `
        SELECT a.email, a.password, COALESCE(a.token_status, '') AS token_status, a.assigned_inbox_id, a.client_id, a.refresh_token
        FROM outlook_oauth_sessions s
        JOIN outlook_accounts a ON a.email = s.email
        WHERE s.id = ?
      `, sessionId)
    : getRow<{ email: string; password: string; token_status: string; assigned_inbox_id: string | null; client_id: string; refresh_token: string }>(getDb(), `
        SELECT email, password, COALESCE(token_status, '') AS token_status, assigned_inbox_id, client_id, refresh_token
        FROM outlook_accounts
        WHERE email = ?
      `, email);

  if (!row) return c.json({ error: 'Outlook account not found' }, 404);
  if (row.assigned_inbox_id) return c.json({ error: 'Outlook account is already claimed' }, 409);
  if (row.client_id && row.refresh_token && !OAUTH_COMPLETABLE_STATUSES.has(row.token_status)) {
    return c.json({ error: `Outlook account status '${row.token_status || 'unchecked'}' is not completable via OAuth` }, 409);
  }
  if (!row.password) return c.json({ error: 'Outlook account password is empty' }, 404);

  return c.json({ email: row.email, password: row.password });
});

outlookRoutes.post('/outlook/oauth/automation/claim', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const preset = normalizePreset(body.preset);
  const settings = getOAuthSettings(preset, {
    clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
    redirectUri: typeof body.redirectUri === 'string' ? body.redirectUri : undefined,
    scopes: typeof body.scopes === 'string' ? body.scopes : undefined,
    tenant: typeof body.tenant === 'string' ? body.tenant : undefined,
  });
  const error = ensureOAuthSettings(settings);
  if (error) return c.json({ error }, 400);

  try {
    const claim = claimOAuthAccount(settings, 'claimed', body.includeFailed === true);
    if (!claim) return c.json({ error: 'No pending Outlook OAuth accounts' }, 404);
    const proxyUrl = getServerProxyUrl();
    return c.json({
      ...claim,
      serverProxyConfigured: Boolean(proxyUrl),
      ...(body.includeProxy === true && proxyUrl ? { proxyUrl } : {}),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

outlookRoutes.post('/outlook/oauth/automation/password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) return c.json({ error: 'Missing required field: sessionId' }, 400);
  const row = getRow<{ email: string; password: string }>(getDb(), `
    SELECT a.email, a.password
    FROM outlook_oauth_sessions s
    JOIN outlook_accounts a ON a.email = s.email
    WHERE s.id = ? AND s.automation_status = 'claimed'
  `, sessionId);
  if (!row) return c.json({ error: 'OAuth automation session not found' }, 404);
  return c.json({ email: row.email, password: row.password });
});

outlookRoutes.post('/outlook/oauth/automation/report', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body.sessionId || '').trim();
  const status = String(body.status || '').trim();
  const allowed = new Set(['started', 'waiting_user', 'failed', 'completed']);
  if (!sessionId) return c.json({ error: 'Missing required field: sessionId' }, 400);
  if (!allowed.has(status)) return c.json({ error: 'Invalid automation status' }, 400);

  const session = getRow<{ id: string; email: string }>(getDb(), `SELECT id, email FROM outlook_oauth_sessions WHERE id = ?`, sessionId);
  if (!session) return c.json({ error: 'OAuth session not found' }, 404);

  const message = typeof body.error === 'string' ? body.error.slice(0, 500) : '';
  if (status === 'failed') {
    getDb().prepare(`
      UPDATE outlook_oauth_sessions
      SET status = 'failed', automation_status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, message || 'Automation reported failure', sessionId);
    getDb().prepare(`UPDATE outlook_accounts SET token_status = 'pending_oauth', oauth_last_error = ? WHERE email = ?`).run(message || 'Automation reported failure', session.email);
  } else {
    getDb().prepare(`
      UPDATE outlook_oauth_sessions
      SET automation_status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, sessionId);
  }
  return c.json({ ok: true });
});

outlookRoutes.get('/outlook/accounts', (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const available = c.req.query('available');
  const group = c.req.query('group');

  const type = c.req.query('type');

  let sql = `SELECT oa.email, oa.token_status, oa.assigned_inbox_id, oa.group_name, oa.account_type, oa.created_at, oa.token_renewed_at, oa.last_checked_at, oa.oauth_last_error,
             (SELECT id FROM inboxes WHERE provider='outlook' AND address=oa.email ORDER BY created_at DESC LIMIT 1) as last_inbox_id
             FROM outlook_accounts oa WHERE 1=1`;
  const conditions: string[] = [];
  const params: string[] = [];

  if (status) {
    conditions.push(`token_status = ?`);
    params.push(status);
  }
  if (available === 'true') {
    conditions.push(`assigned_inbox_id IS NULL AND client_id != '' AND refresh_token != '' AND COALESCE(token_status, '') NOT IN ('invalid', 'no_token', 'pending_oauth')`);
  }
  if (available === 'false') conditions.push(`assigned_inbox_id IS NOT NULL`);
  if (group) {
    conditions.push(`group_name = ?`);
    params.push(group);
  }
  if (type) {
    conditions.push(`account_type = ?`);
    params.push(type);
  }

  if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const accounts = db.prepare(sql).all(...params);

  return c.json({ accounts });
});

outlookRoutes.delete('/outlook/accounts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const emails: string[] = body.emails || [];
  if (!emails.length) return c.json({ error: 'Missing required field: emails' }, 400);

  const db = getDb();
  let deleted = 0;
  for (const email of emails) {
    const row = getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM outlook_accounts WHERE email = ? AND assigned_inbox_id IS NULL`,
      email,
    ) ?? { count: 0 };
    const count = row.count;
    if (count > 0) {
      db.prepare(`DELETE FROM outlook_accounts WHERE email = ? AND assigned_inbox_id IS NULL`).run(email);
      deleted++;
    }
  }
  return c.json({ deleted, requested: emails.length });
});

outlookRoutes.post('/outlook/check', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const concurrency = Math.max(1, parseInt(getSetting('batch_concurrency', '5'), 10) || 5);

  let sql = `SELECT email, client_id, refresh_token FROM outlook_accounts`;
  if (body.emails?.length) {
    const placeholders = body.emails.map(() => '?').join(',');
    sql += ` WHERE email IN (${placeholders})`;
  }

  const rows = allRows<{ email: string; client_id: string; refresh_token: string }>(db, sql, ...(body.emails ?? []));

  const noToken: typeof rows = [];
  const withToken: typeof rows = [];
  for (const row of rows) {
    (row.client_id && row.refresh_token ? withToken : noToken).push(row);
  }

  for (const row of noToken) {
    db.prepare(`UPDATE outlook_accounts SET token_status = 'no_token', last_checked_at = datetime('now') WHERE email = ?`).run(row.email);
  }

  const checked = await runConcurrent(withToken, concurrency, async (row) => {
    const { valid, apiType } = await checkToken(row.email, row.client_id, row.refresh_token);
    const updates = [`token_status = ?`];
    const params: any[] = [valid ? 'valid' : 'invalid'];
    if (apiType) { updates.push(`api_type = ?`); params.push(apiType); }
    params.push(row.email);
    updates.push(`last_checked_at = datetime('now')`);
    db.prepare(`UPDATE outlook_accounts SET ${updates.join(', ')} WHERE email = ?`).run(...params);
    return { email: row.email, valid, apiType };
  });

  const results = [
    ...noToken.map(row => ({ email: row.email, valid: false as const })),
    ...checked,
  ];

  return c.json({
    checked: results.length,
    valid: results.filter((r) => r.valid).length,
    invalid: results.filter((r) => !r.valid).length,
    results,
  });
});

outlookRoutes.post('/outlook/renew', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const concurrency = Math.max(1, parseInt(getSetting('batch_concurrency', '5'), 10) || 5);

  let sql = `SELECT email, client_id, refresh_token FROM outlook_accounts`;
  if (body.emails?.length) {
    const placeholders = body.emails.map(() => '?').join(',');
    sql += ` WHERE email IN (${placeholders})`;
  }

  const rows = allRows<{ email: string; client_id: string; refresh_token: string }>(db, sql, ...(body.emails ?? []));

  const noToken: typeof rows = [];
  const withToken: typeof rows = [];
  for (const row of rows) {
    (row.client_id && row.refresh_token ? withToken : noToken).push(row);
  }

  const noTokenResults = noToken.map(row => ({ email: row.email, renewed: false }));

  const checked = await runConcurrent(withToken, concurrency, async (row) => {
    const result = await renewToken(row.client_id, row.refresh_token);
    if (result) {
      db.prepare(
        `UPDATE outlook_accounts SET refresh_token = ?, token_status = 'valid', token_renewed_at = datetime('now') WHERE email = ?`,
      ).run(result.newRefreshToken, row.email);
      return { email: row.email, renewed: true };
    }
    db.prepare(`UPDATE outlook_accounts SET token_status = 'invalid' WHERE email = ?`).run(row.email);
    return { email: row.email, renewed: false };
  });

  const results = [...noTokenResults, ...checked];

  return c.json({
    total: results.length,
    renewed: results.filter((r) => r.renewed).length,
    failed: results.filter((r) => !r.renewed).length,
    results,
  });
});

outlookRoutes.get('/outlook/stats', (c) => {
  const db = getDb();
  const row = getRow<{
    total: number;
    available: number | null;
    assigned: number | null;
    valid_token: number | null;
    invalid_token: number | null;
    pending_oauth: number | null;
    no_token: number | null;
    long_count: number | null;
    short_count: number | null;
  }>(db, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN assigned_inbox_id IS NULL AND client_id != '' AND refresh_token != '' AND COALESCE(token_status, '') NOT IN ('invalid', 'no_token', 'pending_oauth') THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN assigned_inbox_id IS NOT NULL THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN token_status = 'valid' THEN 1 ELSE 0 END) as valid_token,
      SUM(CASE WHEN token_status = 'invalid' THEN 1 ELSE 0 END) as invalid_token,
      SUM(CASE WHEN token_status = 'pending_oauth' THEN 1 ELSE 0 END) as pending_oauth,
      SUM(CASE WHEN token_status = 'no_token' THEN 1 ELSE 0 END) as no_token,
      SUM(CASE WHEN account_type = 'long' THEN 1 ELSE 0 END) as long_count,
      SUM(CASE WHEN account_type = 'short' THEN 1 ELSE 0 END) as short_count
    FROM outlook_accounts
  `) ?? { total: 0, available: 0, assigned: 0, valid_token: 0, invalid_token: 0, pending_oauth: 0, no_token: 0, long_count: 0, short_count: 0 };
  return c.json({
    total: row.total || 0,
    available: row.available || 0,
    assigned: row.assigned || 0,
    validToken: row.valid_token || 0,
    invalidToken: row.invalid_token || 0,
    pendingOAuth: row.pending_oauth || 0,
    noToken: row.no_token || 0,
    longCount: row.long_count || 0,
    shortCount: row.short_count || 0,
  });
});

outlookRoutes.get('/outlook/settings', (c) => {
  return c.json({
    recordFailService: getSetting('outlook_record_fail_service') !== '0',
    batchConcurrency: parseInt(getSetting('batch_concurrency', '5'), 10) || 5,
    oauthClientId: getSetting('outlook_oauth_client_id', config.outlookOAuthClientId),
    oauthRedirectUri: getSetting('outlook_oauth_redirect_uri', config.outlookOAuthRedirectUri),
    oauthScopes: getSetting('outlook_oauth_scopes', config.outlookOAuthScopes),
    oauthTenant: getSetting('outlook_oauth_tenant', config.outlookOAuthTenant),
  });
});

outlookRoutes.patch('/outlook/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.recordFailService === 'boolean') {
    const val = body.recordFailService ? '1' : '0';
    setSetting('outlook_record_fail_service', val);
  }
  if (body.batchConcurrency != null) {
    const val = Math.max(1, Math.min(50, parseInt(body.batchConcurrency, 10) || 5));
    setSetting('batch_concurrency', String(val));
  }
  if (typeof body.oauthClientId === 'string') setSetting('outlook_oauth_client_id', body.oauthClientId.trim());
  if (typeof body.oauthRedirectUri === 'string') setSetting('outlook_oauth_redirect_uri', body.oauthRedirectUri.trim());
  if (typeof body.oauthScopes === 'string') setSetting('outlook_oauth_scopes', body.oauthScopes.trim());
  if (typeof body.oauthTenant === 'string') setSetting('outlook_oauth_tenant', normalizeTenant(body.oauthTenant));
  return c.json({ ok: true });
});
