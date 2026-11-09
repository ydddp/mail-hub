import { createHash, randomUUID } from 'crypto';
import { getDb, getRow } from './db.js';

export type OutlookCredentialRow = {
  email: string;
  client_id: string;
  refresh_token: string;
  oauth_last_session_id: string | null;
  api_type?: string;
};

export type OutlookCredentialContext = {
  readonly operationId: string;
  readonly source: string;
  readonly email: string;
  readonly clientId: string;
  refreshToken: string;
  readonly oauthSessionId: string | null;
  readonly apiType: string;
};

export const CREDENTIAL_COLUMNS = 'email, client_id, refresh_token, oauth_last_session_id, api_type';
// A job can snapshot an already-started OAuth session with the old tokens.
// Protect its state independently of whether the credential tuple changes.
const CURRENT_GENERATION = `email = ? AND client_id = ? AND refresh_token = ? AND oauth_last_session_id IS ?
  AND COALESCE(token_status, '') != 'pending_oauth'
  AND NOT EXISTS (SELECT 1 FROM outlook_oauth_sessions s
    WHERE s.id = outlook_accounts.oauth_last_session_id AND s.status = 'exchanging')`;

export class StaleOutlookCredentialsError extends Error {
  constructor() { super('Outlook credentials changed or OAuth is pending; retry with a new operation'); }
}

export class OutlookCredentialStorageError extends Error {
  constructor() { super('Outlook private credential storage unavailable'); }
}

export function credentialContext(row: OutlookCredentialRow, source: string): OutlookCredentialContext {
  return { operationId: randomUUID(), source, email: row.email, clientId: row.client_id,
    refreshToken: row.refresh_token, oauthSessionId: row.oauth_last_session_id ?? null, apiType: row.api_type || '' };
}

export function currentCredentialContext(email: string, source: string): OutlookCredentialContext {
  const row = getRow<OutlookCredentialRow>(getDb(), `SELECT ${CREDENTIAL_COLUMNS} FROM outlook_accounts WHERE email = ?`, email);
  if (!row) throw new StaleOutlookCredentialsError();
  const context = credentialContext(row, source);
  assertCurrentCredentials(context);
  if (!context.clientId || !context.refreshToken) throw new Error('Outlook account is missing credentials');
  return context;
}

function generationValues(context: OutlookCredentialContext): Array<string | null> {
  return [context.email, context.clientId, context.refreshToken, context.oauthSessionId];
}

export function credentialsCurrent(context: OutlookCredentialContext): boolean {
  return Boolean(getRow(getDb(), `SELECT 1 FROM outlook_accounts WHERE ${CURRENT_GENERATION}`, ...generationValues(context)));
}

export function assertCurrentCredentials(context: OutlookCredentialContext): void {
  if (!credentialsCurrent(context)) throw new StaleOutlookCredentialsError();
}

/** Every business result, including timestamps, must consume its generation. */
export function updateCredentialAccount(context: OutlookCredentialContext, set: string, values: unknown[] = []): boolean {
  return getDb().prepare(`UPDATE outlook_accounts SET ${set} WHERE ${CURRENT_GENERATION}`)
    .run(...values, ...generationValues(context)).changes === 1;
}

export function purgeInvalidCredentialAccount(context: OutlookCredentialContext): number {
  return getDb().prepare(`DELETE FROM outlook_accounts WHERE ${CURRENT_GENERATION}
    AND account_type = 'short' AND token_status = 'invalid' AND assigned_inbox_id IS NULL`)
    .run(...generationValues(context)).changes;
}

export function extractIssuedCredentials(data: unknown): Record<string, string | number> {
  if (!data || typeof data !== 'object') return {};
  const input = data as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const key of ['access_token', 'refresh_token', 'token_type', 'scope']) {
    if (typeof input[key] === 'string' && input[key] !== '') result[key] = input[key];
  }
  for (const key of ['expires_in', 'ext_expires_in']) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = input[key];
  }
  return result;
}

function appendCheckpoint(context: OutlookCredentialContext, status: number | null, raw: string | null, credentials: Record<string, string | number>): void {
  try {
    getDb().prepare(`INSERT INTO outlook_credential_checkpoints
      (id, operation_id, email, issuing_client_id, origin_refresh_fingerprint, origin_oauth_session_id,
       source, http_status, received_at, credentials_json, raw_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), context.operationId, context.email, context.clientId,
        createHash('sha256').update(context.refreshToken).digest('hex'), context.oauthSessionId,
        context.source, status, new Date().toISOString(), JSON.stringify(credentials), raw);
  } catch { throw new OutlookCredentialStorageError(); }
}

/** Prove storage is available before a non-idempotent token POST. */
export function beginCredentialRequest(context: OutlookCredentialContext): void {
  appendCheckpoint(context, null, null, {});
}

/** Append before interpreting status, shape or freshness; never overwrite an asset. */
export function checkpointCredentialResponse(context: OutlookCredentialContext, status: number, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  appendCheckpoint(context, status, raw, extractIssuedCredentials(parsed));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
