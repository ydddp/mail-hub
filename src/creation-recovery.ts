import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { allRows, getDb, getRow } from './db.js';
import { NoAssetCreatedError, TemplateCreationRecoveryError } from './errors.js';
export { TemplateCreationRecoveryError } from './errors.js';
import type { InboxData } from './providers/base.js';
import type { TemplateProviderConfig } from './providers/template-provider.js';

export type CreationRecoveryPhase = 'attempting' | 'upstream_created' | 'auth_pending' | 'ready' | 'claimed' | 'outcome_unknown';

export interface CreationRecoveryRow {
  id: string; provider: string; phase: CreationRecoveryPhase; config_snapshot: string;
  config_fingerprint: string; api_base: string; variables_json: string;
  address: string; auth_data: string; created_at: string; updated_at: string;
  expires_at: string | null; requested_inbox_id: string | null;
  claimed_inbox_id: string | null; claimed_at: string | null; last_status: number | null;
  operation_id: string | null; operation_lease_until: string | null;
}

export class CreationRecoveryActionError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'CreationRecoveryActionError'; }
}

export interface CreationAuthOperation { id: string; leaseUntil: string }
export const CREATION_AUTH_TIMEOUT_MS = 15000;
export const CREATION_AUTH_LEASE_MS = 45000;

export function readCreationRecovery(provider: string, id: string): CreationRecoveryRow {
  const row = getRow<CreationRecoveryRow>(getDb(), 'SELECT * FROM creation_recoveries WHERE id = ? AND provider = ?', id, provider);
  if (!row) throw new CreationRecoveryActionError('Creation recovery not found', 404);
  return row;
}

export function creationRecoveryMetadata(row: CreationRecoveryRow) {
  const active = Boolean(row.operation_id && row.operation_lease_until && Date.parse(row.operation_lease_until) > Date.now());
  const unexpired = Boolean(row.expires_at && Date.parse(row.expires_at) > Date.now());
  return {
    id: row.id, provider: row.provider, phase: row.phase, address: row.address,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    claimedInboxId: row.claimed_inbox_id, lastStatus: row.last_status, operationActive: active,
    canRetry: !active && ['upstream_created', 'auth_pending'].includes(row.phase),
    canClaim: !active && unexpired && row.phase === 'ready' && row.claimed_inbox_id === null,
  };
}

export function listCreationRecoveries(provider: string) {
  return allRows<CreationRecoveryRow>(getDb(), `SELECT id, provider, phase, address, created_at, updated_at,
    expires_at, claimed_inbox_id, last_status, operation_id, operation_lease_until
    FROM creation_recoveries WHERE provider = ? ORDER BY created_at DESC, rowid DESC`, provider).map(creationRecoveryMetadata);
}

export function acquireCreationAuthentication(provider: string, id: string): { row: CreationRecoveryRow; operation?: CreationAuthOperation } {
  return getDb().transaction(() => {
    const row = readCreationRecovery(provider, id);
    if (row.phase === 'ready' || row.phase === 'claimed') return { row };
    if (!['upstream_created', 'auth_pending'].includes(row.phase)) throw new CreationRecoveryActionError('Creation outcome requires manual inspection', 409);
    const operation = { id: randomUUID(), leaseUntil: new Date(Date.now() + CREATION_AUTH_LEASE_MS).toISOString() };
    const now = new Date().toISOString();
    const result = getDb().prepare(`UPDATE creation_recoveries SET phase = 'auth_pending', operation_id = ?, operation_lease_until = ?, updated_at = ?
      WHERE id = ? AND phase IN ('upstream_created','auth_pending') AND claimed_inbox_id IS NULL
      AND (operation_id IS NULL OR operation_lease_until <= ?)`)
      .run(operation.id, operation.leaseUntil, now, id, now);
    if (result.changes !== 1) throw new CreationRecoveryActionError('Creation authentication is already in progress', 409);
    return { row: readCreationRecovery(provider, id), operation };
  }).immediate();
}

export function appendCreationCredentials(id: string, operation: CreationAuthOperation, authData: Record<string, string>, status: number): void {
  const event = { operationId: operation.id, receivedAt: new Date().toISOString(), status, authData };
  // Independent of the lease: an old response can still contain usable paid
  // credentials. Append only this private checkpoint, never current metadata.
  const result = getDb().prepare(`UPDATE creation_recoveries SET credential_checkpoint_json = json_insert(credential_checkpoint_json, '$[#]', json(?)) WHERE id = ?`)
    .run(JSON.stringify(event), id);
  if (result.changes !== 1) throw new TemplateCreationRecoveryError(id);
}

export function finishCreationAuthentication(provider: string, id: string, operation: CreationAuthOperation,
  phase: 'auth_pending' | 'ready', authData: Record<string, string>, status?: number): CreationRecoveryRow {
  const now = new Date().toISOString();
  const result = getDb().prepare(`UPDATE creation_recoveries SET phase = ?, auth_data = ?, last_status = COALESCE(?, last_status),
    updated_at = ?, operation_id = NULL, operation_lease_until = NULL
    WHERE id = ? AND operation_id = ? AND operation_lease_until > ? AND claimed_inbox_id IS NULL`)
    .run(phase, JSON.stringify(authData), status ?? null, now, id, operation.id, now);
  if (result.changes !== 1) throw new CreationRecoveryActionError('Creation authentication operation is no longer current', 409);
  return readCreationRecovery(provider, id);
}

export function recoveryInboxData(row: CreationRecoveryRow): InboxData {
  return { address: row.address, provider: row.provider, apiBase: row.api_base,
    authData: JSON.parse(row.auth_data) as Record<string, string>, expiresAt: row.expires_at ?? undefined, creationRecoveryId: row.id };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
}

/** Display names, priorities and rate limits do not change credential semantics. */
export function creationConfigFingerprint(cfg: TemplateProviderConfig): string {
  return createHash('sha256').update(canonical({
    apiBase: cfg.apiBase, auth: cfg.auth, extraHeaders: cfg.extraHeaders ?? {},
    domains: cfg.domains, create: cfg.create, postCreate: cfg.postCreate ?? null,
    messages: cfg.messages, messageDetail: cfg.messageDetail, deleteInbox: cfg.deleteInbox ?? null,
  })).digest('hex');
}

export function beginCreationRecovery(cfg: TemplateProviderConfig, variables: Record<string, string>, inboxId?: string, duration?: number): { id: string; expiresAt?: string } {
  const id = randomUUID();
  const startedAt = Date.now();
  const now = new Date(startedAt).toISOString();
  // Dispatch passes its sanitized duration. Preserve its existing semantics:
  // requested lifetime is capped only by an actual provider lifetime, and the
  // 24h default applies only when neither side specifies one. Freeze before
  // authentication so network delay/recovery cannot renew that lifetime.
  const requested = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : undefined;
  const lifetime = cfg.create.expiresIn
    ? Math.min(cfg.create.expiresIn, requested ?? cfg.create.expiresIn)
    : requested ?? 86400;
  const expiresAt = new Date(startedAt + lifetime * 1000).toISOString();
  try {
    getDb().prepare(`INSERT INTO creation_recoveries
      (id, provider, phase, config_snapshot, config_fingerprint, api_base, variables_json, address, auth_data, created_at, updated_at, expires_at, requested_inbox_id)
      VALUES (?, ?, 'attempting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cfg.name, JSON.stringify(cfg), creationConfigFingerprint(cfg), cfg.apiBase,
        JSON.stringify(variables), variables.address, JSON.stringify(variables), now, now, expiresAt ?? null, inboxId ?? null);
  } catch (cause) {
    // This is the only recovery failure with positive no-asset proof: the
    // durable write precedes every possible create network call.
    throw new NoAssetCreatedError('Template inbox creation could not be started', { cause });
  }
  return { id, expiresAt };
}

/** Raw bodies may themselves contain credentials, including on HTTP errors. */
export function appendCreationResponse(id: string, stage: 'create' | 'authenticate', response: Response, rawBody: string, operation?: CreationAuthOperation): void {
  const now = new Date().toISOString();
  const event = { stage, status: response.status, rawBody, receivedAt: now, ...(operation ? { operationId: operation.id } : {}) };
  const result = operation
    ? getDb().prepare(`UPDATE creation_recoveries SET response_history_json = json_insert(response_history_json, '$[#]', json(?)) WHERE id = ?`)
      .run(JSON.stringify(event), id)
    : getDb().prepare(`UPDATE creation_recoveries
      SET response_history_json = json_insert(response_history_json, '$[#]', json(?)), last_status = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(event), response.status, now, id);
  if (result.changes !== 1) throw new TemplateCreationRecoveryError(id);
}

export function checkpointCreation(id: string, phase: CreationRecoveryPhase, address: string, authData: Record<string, string>): void {
  const now = new Date().toISOString();
  const result = getDb().prepare(`UPDATE creation_recoveries
    SET phase = ?, address = ?, auth_data = ?, updated_at = ?,
      upstream_created_at = CASE WHEN ? = 'upstream_created' THEN COALESCE(upstream_created_at, ?) ELSE upstream_created_at END
    WHERE id = ? AND claimed_inbox_id IS NULL`)
    .run(phase, address, JSON.stringify(authData), now, phase, now, id);
  if (result.changes !== 1) throw new TemplateCreationRecoveryError(id);
}

export function creationRecoveryFailure(id: string, cause: unknown, phase: 'auth_pending' | 'outcome_unknown'): TemplateCreationRecoveryError {
  try {
    getDb().prepare(`UPDATE creation_recoveries SET phase = ?, updated_at = ? WHERE id = ? AND claimed_inbox_id IS NULL`)
      .run(phase, new Date().toISOString(), id);
  } catch {
    // The earlier committed checkpoint remains recoverable when SQLite itself
    // is unavailable. Never replace this safe error with raw DB/upstream text.
  }
  return new TemplateCreationRecoveryError(id, cause);
}

/** Must run inside the caller's inbox INSERT transaction. No FK: claim survives purge. */
export function claimCreationRecovery(id: string, inboxId: string, inbox: InboxData): void {
  const result = getDb().prepare(`UPDATE creation_recoveries
    SET phase = 'claimed', claimed_inbox_id = ?, claimed_at = ?, updated_at = ?
    WHERE id = ? AND phase = 'ready' AND claimed_inbox_id IS NULL AND provider = ? AND address = ? AND api_base = ?
      AND expires_at > ? AND (operation_id IS NULL OR operation_lease_until <= ?)`)
    .run(inboxId, new Date().toISOString(), new Date().toISOString(), id, inbox.provider, inbox.address, inbox.apiBase,
      new Date().toISOString(), new Date().toISOString());
  if (result.changes !== 1) throw new TemplateCreationRecoveryError(id);
}

export function claimCreationRecoveryForAdmin(provider: string, id: string) {
  return getDb().transaction(() => {
    const row = readCreationRecovery(provider, id);
    if (row.claimed_inbox_id) return { id: row.claimed_inbox_id, address: row.address, provider, expiresAt: row.expires_at, recovery: creationRecoveryMetadata(row) };
    if (row.phase !== 'ready') throw new CreationRecoveryActionError('Creation recovery is not ready to claim', 409);
    if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) throw new CreationRecoveryActionError('Creation recovery has expired', 410);
    const current = getRow<{ config_json: string; enabled: number }>(getDb(), 'SELECT config_json, enabled FROM template_providers WHERE name = ?', provider);
    const providerState = getRow<{ enabled: number }>(getDb(), 'SELECT enabled FROM provider_config WHERE provider = ?', provider);
    if (!current || current.enabled !== 1 || providerState?.enabled === 0) throw new CreationRecoveryActionError('Current template must be enabled to claim', 409);
    const raw = JSON.parse(current.config_json);
    if (creationConfigFingerprint((raw.config ?? raw) as TemplateProviderConfig) !== row.config_fingerprint) {
      throw new CreationRecoveryActionError('Current template differs from the creation snapshot', 409);
    }
    const inbox = recoveryInboxData(row);
    const inboxId = row.requested_inbox_id ?? nanoid(12);
    claimCreationRecovery(id, inboxId, inbox);
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data, api_base, owner_key, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(inboxId, provider, row.address, row.auth_data, row.api_base, row.created_at, row.expires_at);
    return { id: inboxId, address: row.address, provider, expiresAt: row.expires_at, recovery: creationRecoveryMetadata(readCreationRecovery(provider, id)) };
  }).immediate();
}
