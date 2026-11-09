import { parseTimestamp, utcFields } from '../time.js';
import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { allRows, getDb, getRow, getSetting, logActivity, setSetting } from '../db.js';
import { checkToken, fetchAccountMailboxPage, fetchAccountMessage, OAuthRejectedError, probeIssuedAccessToken, renewToken } from '../providers/outlook.js';
import { OutlookHistoryTokenError } from '../outlook-history.js';
import {
  beginCredentialRequest, checkpointCredentialResponse, credentialContext, credentialsCurrent,
  CREDENTIAL_COLUMNS, extractIssuedCredentials, updateCredentialAccount, type OutlookCredentialRow,
  OutlookCredentialStorageError,
} from '../outlook-credentials.js';
import { parseInboxStartTimestamp, parseInboxTimestamp } from '../inbox-lifecycle.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { importDelimited } from '../import-utils.js';
import { fetchWithTimeout } from '../utils.js';
import { config } from '../config.js';
import { errorMessage, httpStatus, retryAfterHeader } from '../errors.js';
import { startBatchJob, runSynchronousBatch } from '../batch-jobs.js';
import { MESSAGE_RECIPIENTS, type Message } from '../providers/base.js';
import { foldAsciiCase } from '../mail-address.js';

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
  token_type?: string;
  scope?: string;
  expires_in?: number;
  ext_expires_in?: number;
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
} | null {
  const db = getDb();
  const sessionId = randomUUID();
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const authorizeUrl = buildAuthorizeUrl(settings, email, state, codeChallenge);

  return db.transaction(() => {
    const account = getRow<{ oauth_last_session_id: string | null }>(db, `
      SELECT oauth_last_session_id FROM outlook_accounts
      WHERE email = ? AND assigned_inbox_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM outlook_oauth_sessions s
          WHERE s.id = outlook_accounts.oauth_last_session_id
            AND s.status = 'exchanging' AND julianday(s.expires_at) > julianday('now')
        )
    `, email);
    if (!account) return null;
    const bound = db.prepare(`
      UPDATE outlook_accounts
      SET token_status = 'pending_oauth', oauth_last_session_id = ?, oauth_last_error = NULL
      WHERE email = ? AND assigned_inbox_id IS NULL AND oauth_last_session_id IS ?
    `).run(sessionId, email, account.oauth_last_session_id);
    if (bound.changes !== 1) return null;
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
    return {
      sessionId,
      authorizeUrl,
      status: 'pending',
      preset: settings.preset,
      clientId: settings.clientId,
      redirectUri: settings.redirectUri,
    };
  }).immediate();
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
  const db = getDb();
  return db.transaction(() => {
    const account = getRow<{ email: string }>(db, `
      SELECT email
      FROM outlook_accounts
      WHERE assigned_inbox_id IS NULL
        AND (client_id = '' OR refresh_token = '' OR COALESCE(token_status, '') IN (?, ?))
        ${failedFilter}
        AND NOT EXISTS (
          SELECT 1 FROM outlook_oauth_sessions s
          WHERE s.id = outlook_accounts.oauth_last_session_id
            AND s.status IN ('pending', 'exchanging')
            AND julianday(s.expires_at) > julianday('now')
        )
      ORDER BY created_at ASC
      LIMIT 1
    `, ...OAUTH_CLAIM_STATUSES);
    if (!account) return null;

    const claimError = ensureOAuthSettings(settings);
    if (claimError) throw new Error(claimError);

    const session = createOAuthSession(account.email, settings, automationStatus);
    return session ? { ...session, email: account.email } : null;
  }).immediate();
}

async function exchangeAuthorizationCode(session: OAuthSessionRow, code: string): Promise<OAuthTokenResponse> {
  const context = credentialContext({ email: session.email, client_id: session.client_id, refresh_token: '', oauth_last_session_id: session.id }, 'authorization-code');
  beginCredentialRequest(context);
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
  const data = checkpointCredentialResponse(context, res.status, await res.text()) as OAuthTokenResponse;
  if (!res.ok) {
    // Error responses can still contain issued credentials. Preserve their
    // fields for the private checkpoint while keeping the exchange failed.
    return { ...data, error: `token_exchange_${res.status}`, error_description: 'Token exchange failed' };
  }
  return data;
}

// Check authorization with the write, never with a pre-network snapshot.
const CURRENT_OAUTH_SESSION_SQL = `
  julianday(s.expires_at) > julianday('now')
  AND EXISTS (
    SELECT 1 FROM outlook_accounts a
    WHERE a.email = s.email AND a.oauth_last_session_id = s.id
      AND a.assigned_inbox_id IS NULL
  )`;

type OAuthAccountUpdate = { set: string; values: Array<string | null> };

function transitionOAuthSession(
  session: OAuthSessionRow,
  expectedStatus: string,
  nextStatus: string,
  error: string,
  accountUpdate?: OAuthAccountUpdate,
  automationStatus?: string,
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const changed = db.prepare(`
      UPDATE outlook_oauth_sessions AS s
      SET status = ?, error = ?, updated_at = datetime('now')
          ${automationStatus === undefined ? '' : ', automation_status = ?'}
      WHERE s.id = ? AND s.status = ? AND ${CURRENT_OAUTH_SESSION_SQL}
    `).run(nextStatus, error, ...(automationStatus === undefined ? [] : [automationStatus]), session.id, expectedStatus);
    if (changed.changes !== 1) return false;
    if (accountUpdate) {
      const account = db.prepare(`
        UPDATE outlook_accounts SET ${accountUpdate.set}
        WHERE email = ? AND oauth_last_session_id = ? AND assigned_inbox_id IS NULL
          AND EXISTS (
            SELECT 1 FROM outlook_oauth_sessions s
            WHERE s.id = ? AND s.status = ? AND ${CURRENT_OAUTH_SESSION_SQL}
          )
      `).run(...accountUpdate.values, session.email, session.id, session.id, nextStatus);
      if (account.changes !== 1) throw new Error('OAuth account binding changed during commit');
    }
    return true;
  })();
}

function isCurrentOAuthSession(sessionId: string, expectedStatus: string): boolean {
  return Boolean(getRow(getDb(), `
    SELECT s.id FROM outlook_oauth_sessions s
    WHERE s.id = ? AND s.status = ? AND ${CURRENT_OAUTH_SESSION_SQL}
  `, sessionId, expectedStatus));
}

function failCurrentOAuthSession(session: OAuthSessionRow, expectedStatus: string, message: string, automationStatus?: string): boolean {
  return transitionOAuthSession(session, expectedStatus, 'failed', message, {
    set: "token_status = 'pending_oauth', oauth_last_error = ?", values: [message],
  }, automationStatus);
}

function checkpointOAuthCredentials(sessionId: string, exchanged: OAuthTokenResponse): void {
  const checkpoint = extractIssuedCredentials(exchanged);
  if (!checkpoint.access_token && !checkpoint.refresh_token) return;
  // Preserve issued credentials even after supersession, expiry, assignment or
  // account deletion. This private asset write changes no business state and
  // the sensitive column is excluded from every API projection.
  getDb().prepare('UPDATE outlook_oauth_sessions SET credential_checkpoint = ? WHERE id = ?')
    .run(JSON.stringify(checkpoint), sessionId);
}

function oauthErrorMessage(data: OAuthTokenResponse, fallback: string): string {
  return data.error ? 'Token exchange failed' : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type OAuthExchangeResult = { ok: boolean; message: string; status: string };

function inactiveOAuthResult(session: OAuthSessionRow): OAuthExchangeResult {
  const current = getRow<{ status: string }>(getDb(), 'SELECT status FROM outlook_oauth_sessions WHERE id = ?', session.id);
  return {
    ok: false,
    message: current?.status === 'exchanging' ? 'OAuth session is already exchanging or no longer current' : 'OAuth session is not pending, current, unexpired and unassigned',
    status: current?.status || 'failed',
  };
}

async function completeOAuthCodeExchange(session: OAuthSessionRow, code: string): Promise<OAuthExchangeResult> {
  if (session.status === 'completed') return { ok: true, message: 'Refresh token saved', status: 'completed' };
  // Both callbacks must win this pending -> exchanging CAS. Failed codes are
  // never consumed again; error callbacks/reports cannot take this lock.
  if (!transitionOAuthSession(session, 'pending', 'exchanging', '')) return inactiveOAuthResult(session);
  try {
    const exchanged = await exchangeAuthorizationCode(session, code);
    checkpointOAuthCredentials(session.id, exchanged);
    if (!isCurrentOAuthSession(session.id, 'exchanging')) return inactiveOAuthResult(session);
    if (typeof exchanged.refresh_token !== 'string' || !exchanged.refresh_token || exchanged.error) {
      const message = oauthErrorMessage(exchanged, 'Token exchange did not return refresh_token');
      if (!failCurrentOAuthSession(session, 'exchanging', message)) return inactiveOAuthResult(session);
      return { ok: false, message, status: 'failed' };
    }

    // Reuse the just-issued access token. Refreshing here could rotate it via
    // the provider's separate account CAS before this session is committed.
    const checked = typeof exchanged.access_token === 'string' && exchanged.access_token
      ? await probeIssuedAccessToken(session.email, exchanged.access_token)
      : { status: 'unknown' as const, apiType: '' };
    const invalid = checked.status === 'invalid';
    const deferredValidation = checked.status === 'unknown';
    const message = invalid ? 'Refresh token saved, but token validation failed'
      : deferredValidation ? 'Refresh token saved (validation deferred: upstream unreachable)' : 'Refresh token saved';
    const nextStatus = invalid ? 'failed' : 'completed';
    const committed = transitionOAuthSession(session, 'exchanging', nextStatus, invalid ? message : '', {
      set: `client_id = ?, refresh_token = ?, token_status = ?, oauth_last_error = ?,
            token_renewed_at = datetime('now'),
            last_checked_at = ${deferredValidation ? 'NULL' : "datetime('now')"}
            ${invalid || deferredValidation ? '' : ", api_type = CASE WHEN ? != '' THEN ? ELSE api_type END"}`,
      values: [session.client_id, exchanged.refresh_token, invalid ? 'pending_oauth' : deferredValidation ? '' : 'valid', invalid ? message : null,
        ...(invalid || deferredValidation ? [] : [checked.apiType || '', checked.apiType || ''])],
    });
    if (!committed) return inactiveOAuthResult(session);
    return { ok: !invalid, message, status: nextStatus };
  } catch (err) {
    const message = 'OAuth exchange could not be completed';
    if (!failCurrentOAuthSession(session, 'exchanging', message)) return inactiveOAuthResult(session);
    return { ok: false, message, status: 'failed' };
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
  if (!session) return c.json({ error: 'Outlook OAuth exchange is in progress or account is unavailable' }, 409);
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
    failCurrentOAuthSession(session, 'pending', message);
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
  if (!result.ok) return c.json({ error: result.message, sessionId: session.id, status: result.status }, 400);
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
        WHERE s.id = ? AND s.status = 'pending' AND ${CURRENT_OAUTH_SESSION_SQL}
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
      AND s.status = 'pending' AND ${CURRENT_OAUTH_SESSION_SQL}
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

  const session = getRow<OAuthSessionRow>(getDb(), `SELECT * FROM outlook_oauth_sessions WHERE id = ?`, sessionId);
  if (!session) return c.json({ error: 'OAuth session not found' }, 404);

  const message = typeof body.error === 'string' ? body.error.slice(0, 500) : '';
  if (status === 'failed') {
    if (!failCurrentOAuthSession(session, 'pending', message || 'Automation reported failure', status)) {
      return c.json({ error: 'OAuth session is not current and pending' }, 409);
    }
  } else {
    const changed = getDb().prepare(`
      UPDATE outlook_oauth_sessions AS s
      SET automation_status = ?, updated_at = datetime('now')
      WHERE s.id = ? AND s.status = 'pending' AND ${CURRENT_OAUTH_SESSION_SQL}
    `).run(status, sessionId);
    if (changed.changes !== 1) return c.json({ error: 'OAuth session is not current and pending' }, 409);
  }
  return c.json({ ok: true });
});

outlookRoutes.get('/outlook/accounts', (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const available = c.req.query('available');
  const group = c.req.query('group');

  const type = c.req.query('type');
  const q = c.req.query('q');

  // last_inbox_id matches on auth_data.email, not address: with plus addressing
  // an inbox's address is `local+tag@domain` while the account is `local@domain`,
  // so an address join would report "never used" for every alias inbox.
  let sql = `SELECT oa.email, oa.token_status, oa.assigned_inbox_id, oa.group_name, oa.account_type, oa.created_at, oa.token_renewed_at, oa.last_checked_at, oa.oauth_last_error,
             (SELECT id FROM inboxes WHERE provider='outlook' AND COALESCE(json_extract(auth_data, '$.email'), address) = oa.email ORDER BY created_at DESC LIMIT 1) as last_inbox_id
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
  if (q) {
    const escaped = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(`(email LIKE ? ESCAPE '\\' OR COALESCE(group_name, '') LIKE ? ESCAPE '\\')`);
    params.push(escaped, escaped);
  }

  if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const accounts = db.prepare(sql).all(...params);

  return c.json({ accounts: accounts.map((row) => utcFields(row, 'created_at', 'token_renewed_at', 'last_checked_at')) });
});

const MAILBOX_DEFAULT_LIMIT = 50;
const MAILBOX_MAX_LIMIT = 100;

interface LeaseRow {
  id: string;
  address: string;
  target_service: string | null;
  created_at: string;
  closed_at: string | null;
  expires_at: string | null;
  status: string;
}

interface Lease {
  id: string;
  address: string;
  targetService: string | null;
  createdAt: string;
  endedAt: string | null;
  status: string;
  startMs: number;
  endMs: number;
}

/**
 * Every lease this account has served, newest first, each with the real window
 * it owned the mailbox for.
 *
 * The end of a lease is whichever came first: it was closed (closed_at), it
 * expired (expires_at, including an active row awaiting cleanup), or the
 * account was handed to the next lease. That
 * last cap is what makes rows with no recorded end still land somewhere honest:
 * a lease can never have owned the mailbox past the moment the next one started.
 */
function accountLeases(email: string): Lease[] {
  const rows = allRows<LeaseRow>(
    getDb(),
    `SELECT id, address, target_service, created_at, closed_at, expires_at, status
     FROM inboxes
     WHERE provider = 'outlook' AND COALESCE(json_extract(auth_data, '$.email'), address) = ?
     ORDER BY datetime(created_at) DESC`,
    email,
  );

  const leases: Lease[] = [];
  for (const [index, row] of rows.entries()) {
    const startMs = parseInboxStartTimestamp(row.created_at);
    const validEnds = [parseInboxTimestamp(row.closed_at), parseInboxTimestamp(row.expires_at)]
      .filter((value) => value > 0);
    const explicitEnd = validEnds.length > 0 ? Math.min(...validEnds) : Infinity;
    // rows are newest-first, so the lease that superseded this one is at index-1.
    const nextStart = index > 0 ? parseInboxTimestamp(rows[index - 1].created_at) : Infinity;
    const endMs = Math.max(startMs, Math.min(explicitEnd || Infinity, nextStart));
    leases.push({
      id: row.id,
      address: row.address,
      targetService: row.target_service,
      createdAt: row.created_at,
      endedAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
      status: row.status,
      startMs,
      endMs,
    });
  }
  return leases;
}

type LeaseState = 'lease' | 'gap' | 'before' | 'undated';

function classifyMessage(receivedAt: string | undefined, leases: Lease[]): { leaseId: string | null; leaseState: LeaseState } {
  if (!receivedAt) return { leaseId: null, leaseState: 'undated' };
  const t = parseTimestamp(receivedAt);
  if (!Number.isFinite(t)) return { leaseId: null, leaseState: 'undated' };
  for (const lease of leases) {
    if (t >= lease.startMs && t < lease.endMs) return { leaseId: lease.id, leaseState: 'lease' };
  }
  const oldest = leases[leases.length - 1];
  if (oldest && t < parseInboxTimestamp(oldest.createdAt)) return { leaseId: null, leaseState: 'before' };
  return { leaseId: null, leaseState: 'gap' };
}

/** Recipient evidence is independent of arrival windows and retained leases. */
function recipientAttribution(message: Message): { recipientAddress?: string; recipientMatch: 'exact' | 'multiple' | 'unknown' } {
  const addresses = new Map<string, string>();
  for (const value of message[MESSAGE_RECIPIENTS] ?? []) {
    const address = value.trim();
    if (address) addresses.set(foldAsciiCase(address), addresses.get(foldAsciiCase(address)) ?? address);
  }
  if (addresses.size === 0) return { recipientMatch: 'unknown' };
  if (addresses.size > 1) return { recipientMatch: 'multiple' };
  return { recipientMatch: 'exact', recipientAddress: addresses.values().next().value! };
}

/**
 * The account's mailbox, not an inbox's view of it. An inbox is a lease and its
 * message list stays clipped to that lease — widening it would put a previous
 * tenant's verification codes back in front of a caller. This route answers the
 * other question, "what else is in this mailbox", and only for an admin (the
 * whole /outlook/* tree is behind requireAdmin).
 *
 * A fresh request loads the newest `limit` messages. The opaque pageToken
 * continues each folder and its unseen merge buffer with the original limit;
 * repeating a token returns the same page and successor. Refresh starts over.
 */
outlookRoutes.get('/outlook/accounts/:email/mailbox', async (c) => {
  const email = c.req.param('email');
  const exists = getRow<{ email: string }>(getDb(), `SELECT email FROM outlook_accounts WHERE email = ?`, email);
  if (!exists) return c.json({ error: 'Outlook account not found' }, 404);

  const requested = parseInt(c.req.query('limit') || '', 10);
  const limit = Number.isFinite(requested)
    ? Math.min(MAILBOX_MAX_LIMIT, Math.max(1, requested))
    : MAILBOX_DEFAULT_LIMIT;

  const leases = accountLeases(email);

  try {
    const page = await fetchAccountMailboxPage(email, c.get('apiKey'), limit, c.req.query('pageToken'), c.req.raw.signal);
    const { messages, nextPageToken } = page;
    return c.json({
      email,
      limit: page.limit,
      truncated: nextPageToken !== null,
      nextPageToken,
      messages: messages.map((m) => ({ ...m, ...classifyMessage(m.receivedAt, leases), ...recipientAttribution(m) })),
      leases: leases.map(({ startMs: _s, endMs: _e, ...rest }) => utcFields(rest, 'createdAt', 'endedAt')),
    });
  } catch (e) {
    if (e instanceof OutlookHistoryTokenError) return c.json({ error: e.message }, 400);
    if (httpStatus(e, 0) === 429) {
      const retryAfter = retryAfterHeader(e);
      if (retryAfter !== undefined) c.header('Retry-After', retryAfter);
      return c.json({ error: errorMessage(e) }, 429);
    }
    return c.json({ error: errorMessage(e) }, 502);
  }
});

outlookRoutes.get('/outlook/accounts/:email/mailbox/:mid', async (c) => {
  const email = c.req.param('email');
  const exists = getRow<{ email: string }>(getDb(), `SELECT email FROM outlook_accounts WHERE email = ?`, email);
  if (!exists) return c.json({ error: 'Outlook account not found' }, 404);
  try {
    const message = await fetchAccountMessage(email, c.req.param('mid'));
    return c.json({ ...message, ...classifyMessage(message.receivedAt, accountLeases(email)), ...recipientAttribution(message) });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
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

  let sql = `SELECT ${CREDENTIAL_COLUMNS} FROM outlook_accounts`;
  if (body.emails?.length) {
    const placeholders = body.emails.map(() => '?').join(',');
    sql += ` WHERE email IN (${placeholders})`;
  }

  const rows = allRows<OutlookCredentialRow>(db, sql, ...(body.emails ?? []));

  const noToken: typeof rows = [];
  const withToken: typeof rows = [];
  for (const row of rows) {
    (row.client_id && row.refresh_token ? withToken : noToken).push(row);
  }

  const processAccount = async (row: (typeof rows)[number]) => {
    const context = credentialContext(row, 'manual-check');
    const stale = { email: row.email, valid: false, status: 'unknown' };
    if (!credentialsCurrent(context)) return stale;
    if (!row.client_id || !row.refresh_token) {
      if (!updateCredentialAccount(context, "token_status = 'no_token', last_checked_at = datetime('now')")) return stale;
      return { email: row.email, valid: false, status: 'no_token' };
    }
    let checked;
    try { checked = await checkToken(context); }
    catch (error) {
      if (error instanceof OutlookCredentialStorageError) return stale;
      throw error;
    }
    const { status, apiType } = checked;
    if (status === 'unknown') {
      if (!updateCredentialAccount(context, "last_checked_at = datetime('now')")) return stale;
      return { email: row.email, valid: false, status };
    }
    const updates = [`token_status = ?`];
    const params: unknown[] = [status];
    if (apiType) { updates.push(`api_type = ?`); params.push(apiType); }
    updates.push(`last_checked_at = datetime('now')`);
    if (!updateCredentialAccount(context, updates.join(', '), params)) return stale;
    return { email: row.email, valid: status === 'valid', status, apiType };
  };
  const orderedRows = [...noToken, ...withToken];
  const scope = body.emails?.length ? body.emails : ['*'];
  if (body.background === true) {
    c.header('Cache-Control', 'no-store');
    return c.json({ job: startBatchJob('outlook-check', scope, orderedRows, concurrency, processAccount) }, 202);
  }
  const results = await runSynchronousBatch('outlook-check', scope, orderedRows, concurrency, processAccount);

  return c.json({
    checked: results.length,
    valid: results.filter((r) => r.status === 'valid').length,
    invalid: results.filter((r) => r.status === 'invalid' || r.status === 'no_token').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
    results,
  });
});

outlookRoutes.post('/outlook/renew', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const concurrency = Math.max(1, parseInt(getSetting('batch_concurrency', '5'), 10) || 5);

  let sql = `SELECT ${CREDENTIAL_COLUMNS} FROM outlook_accounts`;
  if (body.emails?.length) {
    const placeholders = body.emails.map(() => '?').join(',');
    sql += ` WHERE email IN (${placeholders})`;
  }

  const rows = allRows<OutlookCredentialRow>(db, sql, ...(body.emails ?? []));

  const noToken: typeof rows = [];
  const withToken: typeof rows = [];
  for (const row of rows) {
    (row.client_id && row.refresh_token ? withToken : noToken).push(row);
  }

  const processAccount = async (row: (typeof rows)[number]) => {
    const context = credentialContext(row, 'manual-renew');
    const stale = { email: row.email, renewed: false, status: 'unknown' };
    if (!credentialsCurrent(context)) return stale;
    if (!row.client_id || !row.refresh_token) return { email: row.email, renewed: false, status: 'no_token' };
    try {
      const result = await renewToken(context);
      const capability = await checkToken(context, result.accessToken);
      if (capability.status === 'valid') {
        if (!updateCredentialAccount(context, "token_status = 'valid', api_type = ?, last_checked_at = datetime('now')", [capability.apiType])) return stale;
        return {
          email: row.email,
          renewed: Boolean(result.newRefreshToken),
          status: result.newRefreshToken ? 'renewed' : 'not_rotated',
          apiType: capability.apiType,
        };
      }
      if (capability.status === 'invalid') {
        if (!updateCredentialAccount(context, "token_status = 'invalid', last_checked_at = datetime('now')")) return stale;
      } else {
        if (!updateCredentialAccount(context, "last_checked_at = datetime('now')")) return stale;
      }
      return {
        email: row.email,
        renewed: Boolean(result.newRefreshToken),
        status: capability.status,
      };
    } catch (e) {
      if (e instanceof OAuthRejectedError) {
        if (!updateCredentialAccount(context, "token_status = 'invalid'")) return stale;
        return { email: row.email, renewed: false, status: 'invalid' };
      }
      // Network / throttling / 5xx — leave the stored status untouched.
      return { email: row.email, renewed: false, status: 'unknown' };
    }
  };
  const orderedRows = [...noToken, ...withToken];
  const scope = body.emails?.length ? body.emails : ['*'];
  if (body.background === true) {
    c.header('Cache-Control', 'no-store');
    return c.json({ job: startBatchJob('outlook-renew', scope, orderedRows, concurrency, processAccount) }, 202);
  }
  const results = await runSynchronousBatch('outlook-renew', scope, orderedRows, concurrency, processAccount);

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
    // Opt-in, matching the report path (`=== '1'`): unset means failures do
    // not record the service.
    recordFailService: getSetting('outlook_record_fail_service') === '1',
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
