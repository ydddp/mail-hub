import { nanoid } from 'nanoid';
import { registry } from './providers/registry.js';
import { rateLimiter } from './rate-limiter.js';
import { allRows, getDb, getRow } from './db.js';
import { PROVIDER, type ProviderName, type BaseProvider, type InboxData } from './providers/base.js';
import { errorMessage, httpStatus, isTransientUpstreamError, retryAfterHeader } from './errors.js';

const PROVIDER_PAIRS: Partial<Record<string, ProviderName[]>> = {
  [PROVIDER.MAILTM]: [PROVIDER.MAILGW],
  [PROVIDER.MAILGW]: [PROVIDER.MAILTM],
  [PROVIDER.TEMPMAIL_LOL]: [PROVIDER.TEMPMAIL_ING],
  [PROVIDER.TEMPMAIL_ING]: [PROVIDER.TEMPMAIL_LOL],
};

interface DispatchOptions {
  for?: string;
  provider?: string;
  domain?: string;
  subdomain?: string;
  username?: string;
  duration?: number;
  needPolling?: boolean;
  ownerKey?: string;
}

interface DispatchResult {
  id: string;
  address: string;
  provider: string;
  expiresAt?: string;
  features: Record<string, boolean>;
}

interface ProviderScore {
  provider: BaseProvider;
  score: number;
  reason: string;
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
  const parts = domain.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (blockedSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function getBlockedDomains(service: string): Set<string> {
  const db = getDb();
  const rows = allRows<{ domain: string }>(db,
    `SELECT domain FROM blocks
     WHERE service = ? OR service = '*'`,
    service,
  );
  return new Set(rows.map((row) => row.domain));
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
  targetService?: string
): Promise<string | undefined> {
  if (requestedDomain) {
    if (isDomainBlocked(requestedDomain, blockedDomains)) {
      throw new Error(`Domain '${requestedDomain}' is blocked for this service`);
    }
    return requestedDomain;
  }

  if (provider.meta.type === 'alias') return undefined;
  if (canCreateWithoutPreselectedDomain(provider)) return undefined;

  const domains = await provider.getDomains(targetService ? { for: targetService } : undefined);
  const allowed = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
  if (allowed.length === 0) {
    throw new Error(`${provider.meta.name}: all domains blocked`);
  }
  return pickDomain(provider.meta.name, allowed);
}

function getProviderStats(name: string): { success: number; fail: number } {
  const db = getDb();
  const row = getRow<{ success_count: number; fail_count: number }>(
    db,
    `SELECT success_count, fail_count FROM provider_stats WHERE provider = ?`,
    name,
  );
  if (!row) return { success: 0, fail: 0 };
  return { success: row.success_count || 0, fail: row.fail_count || 0 };
}

function getAllProviderStats(): Map<string, { success: number; fail: number }> {
  const db = getDb();
  const rows = allRows<{ provider: string; success_count: number; fail_count: number }>(
    db,
    `SELECT provider, success_count, fail_count FROM provider_stats`,
  );
  return new Map(rows.map((r) => [r.provider, { success: r.success_count || 0, fail: r.fail_count || 0 }]));
}

async function scoreProviders(
  providers: BaseProvider[],
  blockedDomains: Set<string>,
  needPolling: boolean,
  targetService?: string
): Promise<ProviderScore[]> {
  const scored: ProviderScore[] = [];
  const allStats = getAllProviderStats();

  for (const p of providers) {
    if (needPolling && !p.meta.features.pollInbox) continue;

    const cfg = registry.getConfig(p.meta.name);
    if (!cfg.autoDispatch) continue;
    const stats = allStats.get(p.meta.name) ?? { success: 0, fail: 0 };
    const rateOk = rateLimiter.isCreateAvailable(p.meta.name);

    let score = p.meta.trustLevel * 10;
    if (cfg.priority) score += cfg.priority;
    if (rateOk) score += 15;
    score -= Math.min(stats.fail, 10) * 5;

    let domains: string[] = [];
    let unblocked: string[] = [];
    if (rateOk && !canCreateWithoutPreselectedDomain(p)) {
      try {
        domains = await p.getDomains(targetService ? { for: targetService } : undefined);
      } catch (e) {
        console.warn(`[dispatcher] getDomains failed for ${p.meta.name}:`, (e as Error)?.message);
      }
      unblocked = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
      if (unblocked.length > 0) score += 20;
    }

    let reason = `trust=${p.meta.trustLevel}`;
    if (!rateOk) reason += ', rate-limited';
    if (unblocked.length === 0 && domains.length > 0) reason += ', all-domains-blocked';
    if (stats.fail > 0) reason += `, fails=${stats.fail}`;

    scored.push({ provider: p, score, reason });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function saveInbox(
  id: string,
  inbox: InboxData,
  targetService?: string,
  ownerKey?: string
): void {
  const db = getDb();
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
  const createOpts: ProviderCreateOptions = {
    ...(domain ? { domain } : {}),
    ...(opts.for ? { for: opts.for } : {}),
    ...(opts.subdomain ? { subdomain: opts.subdomain } : {}),
    ...(opts.username ? { username: opts.username } : {}),
    ...(opts.duration ? { duration: opts.duration } : {}),
    inboxId: id,
  };
  if (!rateLimiter.tryRecordCreate(providerName)) {
    throw new Error(`Provider '${providerName}' is rate-limited`);
  }
  let inbox: InboxData;
  try {
    inbox = await provider.createInbox(createOpts);
  } catch (error) {
    // A create that failed deterministically (upstream 4xx other than 429)
    // produced no inbox, so refund the slot it reserved. 429 is left consumed:
    // recordProviderFailure sets a cooldown for it separately.
    const status = httpStatus(error, 0);
    if (status >= 400 && status < 500 && status !== 429) {
      rateLimiter.refundCreate(providerName);
    }
    throw error;
  }
  try {
    saveInbox(id, inbox, opts.for, opts.ownerKey);
  } catch (error) {
    await provider.releaseInbox(inbox, id).catch(() => {});
    throw error;
  }
  rateLimiter.recordCreateSuccess(providerName);
  return {
    id,
    address: inbox.address,
    provider: providerName,
    expiresAt: inbox.expiresAt,
    features: provider.meta.features,
  };
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  if (opts.for && /^(example\.(com|org|net)|test\.(com|org)|localhost)$/i.test(opts.for)) {
    throw new Error(`'${opts.for}' is an example domain, use a real target service`);
  }

  const enabledProviders = registry.getEnabled();
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
    const domain = opts.domain
      ? await selectAllowedDomain(p, opts.domain, blockedDomains, opts.for)
      : await selectAllowedDomain(p, undefined, blockedDomains, opts.for);

    try {
      return await tryCreateInbox(p, p.meta.name, opts, domain);
    } catch (error) {
      recordProviderFailure(p.meta.name, error);
      throw error;
    }
  }

  const blockedDomains = opts.for ? getBlockedDomains(opts.for) : new Set<string>();
  const scored = await scoreProviders(enabledProviders, blockedDomains, needPolling, opts.for);
  const errors: string[] = [];

  for (const { provider: p, reason } of scored) {
    if (!rateLimiter.isCreateAvailable(p.meta.name)) {
      const pairs = PROVIDER_PAIRS[p.meta.name] ?? [];
      for (const pairName of pairs) {
        const pair = registry.get(pairName);
        const pairCfg = registry.getConfig(pairName);
        if (pair && pairCfg.enabled && rateLimiter.isCreateAvailable(pairName)) {
          try {
            let domain: string | undefined;
            if (!canCreateWithoutPreselectedDomain(pair)) {
              let domains = await pair.getDomains(opts.for ? { for: opts.for } : undefined);
              domains = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
              if (domains.length === 0) continue;
              domain = domains.length ? pickDomain(pairName, domains) : undefined;
            }

            return await tryCreateInbox(pair, pairName, opts, domain);
          } catch (e) {
            errors.push(`${pairName}(pair): ${errorMessage(e)}`);
            recordProviderFailure(pairName, e);
            continue;
          }
        }
      }
      errors.push(`${p.meta.name}: rate-limited (${reason})`);
      continue;
    }

    try {
      let domain: string | undefined;
      if (!canCreateWithoutPreselectedDomain(p)) {
        let domains = await p.getDomains(opts.for ? { for: opts.for } : undefined);
        domains = domains.filter((d) => !isDomainBlocked(d, blockedDomains));

        if (domains.length === 0 && p.meta.type !== 'alias') {
          errors.push(`${p.meta.name}: all domains blocked`);
          continue;
        }
        domain = domains.length ? pickDomain(p.meta.name, domains) : undefined;
      }

      return await tryCreateInbox(p, p.meta.name, opts, domain);
    } catch (e) {
      errors.push(`${p.meta.name}: ${errorMessage(e)}`);
      recordProviderFailure(p.meta.name, e);
    }
  }

  throw new Error(
    `All providers exhausted.\n${errors.map((e) => `  - ${e}`).join('\n')}`
  );
}
