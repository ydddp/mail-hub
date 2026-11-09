import { parseTimestamp } from './time.js';
import { nanoid } from 'nanoid';
import { registry } from './providers/registry.js';
import { rateLimiter } from './rate-limiter.js';
import { allRows, bumpServiceCreated, canonicalImapAddress, getDb } from './db.js';
import { PROVIDER, type BaseProvider, type InboxData } from './providers/base.js';
import { createLogger } from './logger.js';
import { errorMessage, httpStatus, ImapAddressConflictError, InvalidImapUsernameError, isImapAddressConflict, isTransientUpstreamError, NoAssetCreatedError, retryAfterHeader, TemplateCreationRecoveryError } from './errors.js';
import { EXAMPLE_SERVICE_RE, evaluateDispatch } from './dispatch-rules.js';
import { claimCreationRecovery } from './creation-recovery.js';

const log = createLogger('dispatcher');

interface DispatchOptions {
  for?: string;
  provider?: string;
  domain?: string;
  subdomain?: string;
  username?: string;
  account?: string;
  duration?: number;
  needPolling?: boolean;
  ownerKey?: string;
  alias?: boolean;
}

interface DispatchResult {
  id: string;
  address: string;
  provider: string;
  expiresAt: string;
  features: Record<string, boolean>;
}

// Every inbox gets an expiry so pool resources (Outlook accounts, YYDS slots)
// can never leak permanently when a client crashes without DELETE.
const DEFAULT_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_DURATION_S = 60;
const MAX_DURATION_S = 30 * 24 * 60 * 60;

function sanitizeDuration(duration: unknown): number | undefined {
  const n = Number(duration);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.max(Math.floor(n), MIN_DURATION_S), MAX_DURATION_S);
}

function resolveExpiresAt(providerExpiresAt: string | undefined, durationSeconds: number | undefined): string {
  const requestedMs = durationSeconds ? Date.now() + durationSeconds * 1000 : undefined;
  if (providerExpiresAt) {
    const upstreamMs = parseTimestamp(providerExpiresAt);
    // Upstream lifetime is authoritative; a shorter requested duration may tighten it.
    if (requestedMs && Number.isFinite(upstreamMs)) {
      return new Date(Math.min(upstreamMs, requestedMs)).toISOString();
    }
    if (Number.isFinite(upstreamMs)) return new Date(upstreamMs).toISOString();
  }
  return new Date(requestedMs ?? Date.now() + DEFAULT_INBOX_TTL_MS).toISOString();
}

// One slow domain endpoint must not stall every automatic create. The timeout
// error carries ETIMEDOUT so isTransientUpstreamError classifies it and the
// provider gets the standard transient cooldown instead of being retried
// first on the very next request.
const DOMAINS_TIMEOUT_MS = 5000;

class DomainsTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(ms: number) {
    super(`getDomains timed out after ${ms}ms`);
    this.name = 'DomainsTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DomainsTimeoutError(ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const domainCursor = new Map<string, number>();

function canCreateWithoutPreselectedDomain(provider: BaseProvider): boolean {
  return provider.getDomainMode() === 'from_create';
}

function recordProviderFailure(providerName: string, error: unknown): void {
  if (httpStatus(error, 0) === 429) {
    rateLimiter.recordRateLimitFailure(providerName, retryAfterHeader(error));
  } else if (isTransientUpstreamError(error)) {
    rateLimiter.recordTransientFailure(providerName);
  }
}

export function getDomainAtLevel(domain: string, level: number): string {
  const parts = domain.split('.');
  if (parts.length <= level) return domain;
  return parts.slice(-level).join('.');
}

function isDomainBlocked(domain: string, blockedSet: Set<string>): boolean {
  const normalizedDomain = canonicalBlockDomain(domain);
  const parts = normalizedDomain.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (blockedSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// Domains are user-entered (IMAP catch-alls especially) and can carry stray
// case or whitespace. Normalize both the candidate and the stored block list
// through the same funnel so a lowercase block rule cannot be bypassed by a
// mixed-case domain.
function canonicalBlockDomain(domain: string): string {
  return domain.trim().replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function getBlockedDomains(service: string): Set<string> {
  const db = getDb();
  const rows = allRows<{ domain: string }>(db,
    `SELECT domain FROM blocks
     WHERE service = ? OR service = '*'`,
    service,
  );
  return new Set(rows.map((row) => canonicalBlockDomain(row.domain)));
}

/**
 * The scoping passed to getDomains. Kept in one place because every call site
 * needs it identical — if one of them drops `alias`, a provider that filters by
 * prior service use reports zero domains and dispatch fails with
 * "all domains blocked" before createInbox is reached.
 */
function domainScope(targetService?: string, alias?: boolean): { for?: string; alias?: boolean } | undefined {
  if (!targetService && !alias) return undefined;
  return { ...(targetService ? { for: targetService } : {}), ...(alias ? { alias: true } : {}) };
}

function pickDomain(providerName: string, domains: string[]): string {
  const start = domainCursor.get(providerName) ?? Math.floor(Math.random() * domains.length);
  const domain = domains[start % domains.length];
  domainCursor.set(providerName, (start + 1) % domains.length);
  return domain;
}

async function selectAllowedDomain(
  provider: BaseProvider,
  requestedDomain: string | undefined,
  blockedDomains: Set<string>,
  targetService?: string,
  alias?: boolean
): Promise<string | undefined> {
  if (requestedDomain) {
    if (isDomainBlocked(requestedDomain, blockedDomains)) {
      throw new Error(`Domain '${requestedDomain}' is blocked for this service`);
    }
    return requestedDomain;
  }

  if (provider.meta.type === 'alias') return undefined;
  if (canCreateWithoutPreselectedDomain(provider)) return undefined;

  const domains = await provider.getDomains(domainScope(targetService, alias));
  // An empty list and a fully-blocked list are different failures. A pool
  // provider returns nothing when it has no account left to offer — often
  // because every one is already used for this service — and reporting that as
  // "all domains blocked" sends the operator hunting through the block list.
  if (domains.length === 0) {
    throw new Error(
      `${provider.meta.name}: no address available${targetService ? ` for ${targetService}` : ''}`,
    );
  }
  const allowed = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
  if (allowed.length === 0) {
    throw new Error(`${provider.meta.name}: all domains blocked`);
  }
  return pickDomain(provider.meta.name, allowed);
}

function saveInbox(
  id: string,
  inbox: InboxData,
  targetService?: string,
  ownerKey?: string
): void {
  const db = getDb();
  try {
    db.transaction(() => {
      if (inbox.creationRecoveryId) claimCreationRecovery(inbox.creationRecoveryId, id, inbox);
      db.prepare(
        `INSERT INTO inboxes (id, provider, address, auth_data, api_base, target_service, owner_key, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        inbox.provider,
        inbox.address,
        JSON.stringify(inbox.authData),
        inbox.apiBase,
        targetService ?? null,
        ownerKey ?? null,
        inbox.expiresAt ?? null
      );
    })();
  } catch (cause) {
    if (inbox.creationRecoveryId && !(cause instanceof TemplateCreationRecoveryError)) {
      throw new TemplateCreationRecoveryError(inbox.creationRecoveryId, cause);
    }
    throw cause;
  }
}

type ProviderCreateOptions = Parameters<BaseProvider['createInbox']>[0] & {
  duration?: number;
  needPolling?: boolean;
};

async function tryCreateInbox(
  provider: BaseProvider,
  providerName: string,
  opts: DispatchOptions,
  domain?: string
): Promise<DispatchResult> {
  const id = nanoid(12);
  const duration = sanitizeDuration(opts.duration);
  const createOpts: ProviderCreateOptions = {
    ...(domain ? { domain } : {}),
    ...(opts.for ? { for: opts.for } : {}),
    ...(opts.subdomain ? { subdomain: opts.subdomain } : {}),
    ...((providerName === PROVIDER.IMAP ? Object.hasOwn(opts, 'username') : !!opts.username) ? { username: opts.username } : {}),
    ...(opts.account ? { account: opts.account } : {}),
    ...(opts.alias ? { alias: true } : {}),
    ...(duration ? { duration } : {}),
    inboxId: id,
  };
  const reservationId = rateLimiter.reserveCreate(providerName);
  if (reservationId === null) {
    throw new Error(`Provider '${providerName}' is rate-limited`);
  }
  const refundFailedCreate = (error: unknown): void => {
    // A status code or generic error cannot establish whether a remote write
    // committed. Only create sites with positive no-asset proof may refund.
    if (error instanceof NoAssetCreatedError) {
      rateLimiter.refundCreate(providerName, reservationId);
    }
  };

  const randomImap = providerName === PROVIDER.IMAP && !Object.hasOwn(opts, 'username');
  const attempts = randomImap ? 8 : 1;
  let imapDomain: string | undefined;
  let inbox!: InboxData;
  let expiresAt!: string;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      inbox = await provider.createInbox(createOpts);
      if (randomImap) {
        const address = canonicalImapAddress(inbox.address);
        const actualDomain = address.slice(address.indexOf('@') + 1);
        if (imapDomain !== undefined && actualDomain !== imapDomain) {
          await provider.releaseInbox(inbox, id).catch(() => {});
          throw new ImapAddressConflictError();
        }
        // An unknown requested domain may use the provider's initial fallback.
        // Once resolved, a collision must never escape to another domain.
        imapDomain = actualDomain;
        createOpts.domain = imapDomain;
      }
    } catch (error) {
      refundFailedCreate(error);
      throw error;
    }
    expiresAt = resolveExpiresAt(inbox.expiresAt, duration);
    try {
      saveInbox(id, { ...inbox, expiresAt }, opts.for, opts.ownerKey);
      break;
    } catch (error) {
      await provider.releaseInbox(inbox, id).catch(() => {});
      if (providerName === PROVIDER.IMAP && isImapAddressConflict(error)) {
        // The trigger is authoritative when two prechecks raced. Retry the
        // entire local create + INSERT under the original reservation.
        if (randomImap && attempt + 1 < attempts) continue;
        const conflict = new ImapAddressConflictError();
        refundFailedCreate(conflict);
        throw conflict;
      }
      throw error;
    }
  }
  // Durable per-service counters survive inbox retention purges. A stats
  // failure must never undo an already-created inbox, so it stays outside
  // the saveInbox try/catch.
  if (opts.for) {
    try { bumpServiceCreated(opts.for); } catch (error) {
      log.warn('failed to bump service stats', { service: opts.for, error: error });
    }
  }
  rateLimiter.recordCreateSuccess(providerName);
  return {
    id,
    address: inbox.address,
    provider: providerName,
    expiresAt,
    features: provider.meta.features,
  };
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  // Normalize once so target_service is stored, block-matched, and counted
  // under a single canonical name (" x.com " and "x.com" must not diverge).
  opts = { ...opts, for: opts.for?.trim() || undefined };
  if (opts.for && EXAMPLE_SERVICE_RE.test(opts.for)) {
    throw new Error(`'${opts.for}' is an example domain, use a real target service`);
  }

  const needPolling = opts.needPolling !== false;

  if (opts.provider) {
    const p = registry.get(opts.provider);
    if (!p) throw new Error(`Provider '${opts.provider}' not found`);
    const cfg = registry.getConfig(p.meta.name);
    if (!cfg.enabled) throw new Error(`Provider '${opts.provider}' is disabled`);
    if (!rateLimiter.isCreateAvailable(p.meta.name)) {
      throw new Error(`Provider '${opts.provider}' is rate-limited`);
    }
    const blockedDomains = opts.for ? getBlockedDomains(opts.for) : new Set<string>();
    const domain = await selectAllowedDomain(p, opts.domain, blockedDomains, opts.for, opts.alias);

    try {
      return await tryCreateInbox(p, p.meta.name, opts, domain);
    } catch (error) {
      recordProviderFailure(p.meta.name, error);
      throw error;
    }
  }

  const blockedDomains = opts.for ? getBlockedDomains(opts.for) : new Set<string>();
  const { candidates } = evaluateDispatch({ service: opts.for, needPolling });
  const errors: string[] = [];

  for (const candidate of candidates) {
    if (!candidate.eligible) {
      errors.push(`${candidate.provider}: skipped (${candidate.reason})`);
      continue;
    }
    const p = registry.get(candidate.provider);
    if (!p) continue;

    // Domain fetch, block filter and create share one failure boundary: a
    // throw anywhere here records the error and moves on to the next
    // candidate. Only this provider's domains are fetched — never those of
    // providers further down the order that may never be reached.
    try {
      let domain: string | undefined;
      if (!canCreateWithoutPreselectedDomain(p) && p.meta.type !== 'alias') {
        const domains = (await withTimeout(p.getDomains(domainScope(opts.for, opts.alias)), DOMAINS_TIMEOUT_MS))
          .filter((d) => !isDomainBlocked(d, blockedDomains));
        if (domains.length === 0) {
          errors.push(`${p.meta.name}: no unblocked address available`);
          continue;
        }
        domain = pickDomain(p.meta.name, domains);
      }

      return await tryCreateInbox(p, p.meta.name, opts, domain);
    } catch (e) {
      if (e instanceof ImapAddressConflictError || e instanceof InvalidImapUsernameError) throw e;
      errors.push(`${p.meta.name}: ${errorMessage(e)}`);
      recordProviderFailure(p.meta.name, e);
    }
  }

  throw new Error(
    `All providers exhausted.\n${errors.map((e) => `  - ${e}`).join('\n')}`
  );
}
