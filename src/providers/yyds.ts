import { providerTime, toUtcIso } from '../time.js';
import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail, type ProviderDomainMode, type ProviderMeta } from './base.js';
import { allRows, getDb, getRow } from '../db.js';
import { fetchWithTimeout, formatSender, todayDateString } from '../utils.js';
import { createLogger } from '../logger.js';
import { errorMessage, logIgnoredError, UpstreamHttpError } from '../errors.js';
import type Database from 'better-sqlite3';

const API_BASE = 'https://maliapi.215.im/v1';
const DAILY_QUOTA = 20000;
const DOMAIN_CACHE_TTL_MS = 15 * 60 * 1000;
const log = createLogger('yyds');

/**
 * Upstream's real error taxonomy for a key whose scope is its own domain
 * (captured live, 2026-08-24):
 *
 *   POST /accounts          + public domain -> 403 api_key_domain_scope_forbidden
 *   POST /accounts/wildcard + public domain -> 400 wildcard_rule_not_enabled_for_domain
 *                                              (or 403 permission_denied, when that
 *                                               domain's wildcard rule belongs to
 *                                               someone else — ~1 domain in 8)
 *   POST /accounts(/wildcard) + unknown domain -> 400 domain_not_available
 *   POST /accounts/wildcard + no domain      -> 201, address on the key's own domain
 *
 * Only the first says "the key authenticated and was refused this domain",
 * which is the signature of a scope-restricted key — never a statement about
 * whether the key can use the wildcard endpoint. errorCode is authoritative
 * when present; the prose match is a fallback for older/other responses.
 */
const DOMAIN_SCOPE_ERROR_CODE = 'api_key_domain_scope_forbidden';
const DOMAIN_SCOPE_ERROR_TEXT = /domain\s+scope|scope\s+does\s+not\s+permit/i;

export function isDomainScopeError(body: string): boolean {
  try {
    const code = (JSON.parse(body) as { errorCode?: unknown }).errorCode;
    if (typeof code === 'string') return code === DOMAIN_SCOPE_ERROR_CODE;
  } catch {
    // Not JSON; fall through to the prose match.
  }
  return DOMAIN_SCOPE_ERROR_TEXT.test(body);
}

interface YydsDomain {
  domain?: string;
  isPublic?: boolean;
  isVerified?: boolean;
  isMxValid?: boolean;
}

interface YydsAccount {
  id?: string;
  address?: string;
  token?: string;
  expiresAt?: string;
}

interface YydsMessage {
  id?: string;
  from?: { name?: string; address?: string };
  subject?: string;
  createdAt?: string;
  text?: string;
  html?: string | string[];
}

interface YydsResponse<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

interface CreateFailure {
  /** HTTP status, or 0 for a 2xx response whose body reported failure. */
  status: number;
  errText: string;
  retryAfter: string | null;
}

function isCreatedAccount(account: YydsAccount | undefined): account is Required<Pick<YydsAccount, 'id' | 'address' | 'token'>> & YydsAccount {
  return Boolean(account?.id && account.address && account.token);
}

export class YydsProvider extends BaseProvider {
  meta: ProviderMeta = {
    name: PROVIDER.YYDS,
    displayName: 'YYDS Mail',
    type: 'api',
    tier: 'free',
    trustLevel: 3,
    rateLimit: { createPerMinute: 0, pollPerMinute: 0 },
    retention: '24h',
    features: {
      customUsername: true,
      pollInbox: true,
      realtime: false,
      attachments: true,
    },
  };

  private domainCache: { domains: string[]; expiresAt: number } | null = null;
  // After an upstream failure the DB fallback is memoized briefly so a dead
  // upstream costs one timeout per minute instead of stalling every dispatch.
  private static readonly DOMAIN_FAILURE_CACHE_MS = 60_000;

  private fallbackToCachedDomains(): string[] {
    const fallback = this.readCachedDomains();
    this.domainCache = { domains: fallback, expiresAt: Date.now() + YydsProvider.DOMAIN_FAILURE_CACHE_MS };
    return fallback;
  }

  private readCachedDomains(): string[] {
    const rows = allRows<{ domain: string }>(getDb(),
      `SELECT domain FROM yyds_domain_cache ORDER BY cached_at DESC, domain ASC`,
    );
    return rows.map((row) => row.domain);
  }

  private writeCachedDomains(domains: string[]): void {
    const uniqueDomains = [...new Set(domains)];
    const db = getDb();
    const replace = db.transaction(() => {
      db.prepare(`DELETE FROM yyds_domain_cache`).run();
      const insert = db.prepare(
        `INSERT INTO yyds_domain_cache (domain, cached_at) VALUES (?, datetime('now'))`,
      );
      for (const domain of uniqueDomains) insert.run(domain);
    });
    replace();
    this.domainCache = { domains: uniqueDomains, expiresAt: Date.now() + DOMAIN_CACHE_TTL_MS };
  }

  /**
   * A key an operator marked wildcard-capable is an own-domain key: its address
   * is minted by the create response (u1@d2f26c.mail.example.com) and its scope
   * rejects every public domain /v1/domains lists. Preselecting one of those is
   * a guaranteed 403, so tell dispatch the address comes from create instead.
   * Keys whose capability is still unknown keep 'endpoint': both the public
   * path and the wildcard probe need a domain to work with.
   */
  getDomainMode(): ProviderDomainMode {
    return this.hasOwnDomainKey() ? 'from_create' : 'endpoint';
  }

  private hasOwnDomainKey(): boolean {
    const db = getDb();
    // Same quota predicate as pickKey, and the same daily reset: a stale
    // daily_calls would report 'endpoint' on the first dispatch of a new day
    // and hand the own-domain key a public domain all over again.
    this.resetDailyIfNeeded(db);
    const row = getRow<{ count: number }>(db,
      `SELECT COUNT(*) AS count FROM yyds_accounts
       WHERE status = 'active' AND supports_wildcard = 1 AND daily_calls < ${DAILY_QUOTA}`,
    );
    return (row?.count ?? 0) > 0;
  }

  async getDomains(): Promise<string[]> {
    const db = getDb();
    const hasKeys = getRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM yyds_accounts WHERE status = 'active'`) ?? { count: 0 };
    if (hasKeys.count === 0) {
      return [];
    }

    if (this.domainCache && this.domainCache.expiresAt > Date.now()) {
      return this.domainCache.domains;
    }

    try {
      const res = await fetchWithTimeout(`${API_BASE}/domains`);
      if (!res.ok) return this.fallbackToCachedDomains();
      const json = await res.json() as YydsResponse<YydsDomain[]>;
      if (!json.success || !json.data) return this.fallbackToCachedDomains();
      const domains = json.data
        .filter((d) => d.isPublic && d.isVerified && d.isMxValid)
        .map((d) => d.domain)
        .filter((domain): domain is string => Boolean(domain));
      if (domains.length > 0) this.writeCachedDomains(domains);
      return domains.length > 0 ? [...new Set(domains)] : this.fallbackToCachedDomains();
    } catch (error) {
      log.warn('failed to refresh YYDS domains, using cache', { error: errorMessage(error) });
      return this.fallbackToCachedDomains();
    }
  }

  private lastResetDate = '';

  private resetDailyIfNeeded(db: Database.Database): void {
    const today = todayDateString();
    if (this.lastResetDate === today) return;
    db.prepare(`UPDATE yyds_accounts SET daily_calls = 0, daily_reset_at = ? WHERE daily_reset_at IS NULL OR daily_reset_at < ?`)
      .run(today, today);
    this.lastResetDate = today;
  }

  private recordApiCall(apiKey: string): void {
    const db = getDb();
    this.resetDailyIfNeeded(db);
    db.prepare(`UPDATE yyds_accounts SET daily_calls = daily_calls + 1, last_used_at = datetime('now') WHERE api_key = ?`)
      .run(apiKey);
  }

  private pickKey(preferWildcard: boolean): { apiKey: string; supportsWildcard: number | null } | null {
    const db = getDb();
    this.resetDailyIfNeeded(db);
    const quota = `AND daily_calls < ${DAILY_QUOTA}`;

    if (preferWildcard) {
      const known = getRow<{ api_key: string; supports_wildcard: number | null }>(db,
        `SELECT api_key, supports_wildcard FROM yyds_accounts
         WHERE status = 'active' AND supports_wildcard = 1 ${quota}
         ORDER BY last_used_at ASC NULLS FIRST LIMIT 1`,
      );
      if (known) return { apiKey: known.api_key, supportsWildcard: 1 };

      const unknown = getRow<{ api_key: string; supports_wildcard: number | null }>(db,
        `SELECT api_key, supports_wildcard FROM yyds_accounts
         WHERE status = 'active' AND supports_wildcard IS NULL ${quota}
         ORDER BY last_used_at ASC NULLS FIRST LIMIT 1`,
      );
      if (unknown) return { apiKey: unknown.api_key, supportsWildcard: null };
    }

    const available = getRow<{ api_key: string; supports_wildcard: number | null }>(db,
      `SELECT api_key, supports_wildcard FROM yyds_accounts
       WHERE status = 'active' ${quota}
       ORDER BY last_used_at ASC NULLS FIRST LIMIT 1`,
    );
    if (!available) return null;
    return { apiKey: available.api_key, supportsWildcard: available.supports_wildcard };
  }

  private recordUsage(apiKey: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE yyds_accounts SET inbox_count = inbox_count + 1, last_used_at = datetime('now'), daily_calls = daily_calls + 1 WHERE api_key = ?`,
    ).run(apiKey);
  }

  private markWildcard(apiKey: string, supports: boolean): void {
    const db = getDb();
    db.prepare(`UPDATE yyds_accounts SET supports_wildcard = ? WHERE api_key = ?`).run(supports ? 1 : 0, apiKey);
  }

  private async readErrorBody(res: Response): Promise<string> {
    return res.text().catch((error: unknown) => {
      logIgnoredError(log, 'failed to read YYDS create error response', error);
      return '';
    });
  }

  /** One create call, mapped to either an inbox or the upstream refusal. */
  private async createVia(
    path: '/accounts' | '/accounts/wildcard',
    apiKey: string,
    body: Record<string, string>,
    inboxId?: string,
  ): Promise<{ inbox: InboxData } | CreateFailure> {
    const res = await fetchWithTimeout(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = await res.json() as YydsResponse<YydsAccount>;
      if (json.success && isCreatedAccount(json.data)) {
        return {
          inbox: {
            address: json.data.address,
            authData: {
              apiKey,
              accountId: json.data.id,
              tempToken: json.data.token,
              address: json.data.address,
              ...(inboxId ? { inboxId } : {}),
            },
            provider: this.meta.name,
            apiBase: API_BASE,
            expiresAt: toUtcIso(json.data.expiresAt) ?? undefined,
          },
        };
      }
      // 2xx without an account: a body-level failure, not an HTTP one.
      return { status: 0, errText: json.error || 'unknown', retryAfter: null };
    }

    return { status: res.status, errText: await this.readErrorBody(res), retryAfter: res.headers.get('Retry-After') };
  }

  /**
   * Mint with no domain at all — the one request an own-domain key always
   * accepts, and the only one whose refusal says anything about the key rather
   * than about a domain. Success is the sole evidence that promotes a key, so
   * a key merely scoped to a subset of public domains is never mistaken for
   * one that owns a domain.
   */
  private async probeOwnDomain(
    apiKey: string,
    body: Record<string, string>,
    inboxId: string | undefined,
    mayDemote: boolean,
  ): Promise<InboxData | null> {
    const { domain: _refused, ...withoutDomain } = body;
    const result = await this.createVia('/accounts/wildcard', apiKey, withoutDomain, inboxId);
    if ('inbox' in result) {
      this.markWildcard(apiKey, true);
      this.recordUsage(apiKey);
      log.info('YYDS key promoted to own-domain', { address: result.inbox.address });
      return result.inbox;
    }
    // A domainless refusal is the only proof that this key cannot wildcard —
    // but only a deterministic one. 429/5xx/network say nothing.
    const deterministic = result.status >= 400 && result.status < 500 && result.status !== 429;
    if (mayDemote && deterministic) this.markWildcard(apiKey, false);
    return null;
  }

  async createInbox(opts?: { domain?: string; username?: string; subdomain?: string; inboxId?: string }): Promise<InboxData> {
    const selected = this.pickKey(true);
    if (!selected) throw new Error('YYDS 账号池中无可用 API Key（可能全部达到日配额或冷却中）');

    const localPart = opts?.username ?? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const body: Record<string, string> = { localPart };
    if (opts?.domain) body.domain = opts.domain;
    if (opts?.subdomain) body.subdomain = opts.subdomain;
    // Discovery state. Only an unclassified key may be re-routed onto its own
    // domain behind the caller's back, or have its flag written.
    const unknownKey = selected.supportsWildcard === null;

    if (opts?.subdomain || selected.supportsWildcard !== 0) {
      let scopeRefusal: CreateFailure | null = null;
      try {
        const attempt = await this.createVia('/accounts/wildcard', selected.apiKey, body, opts?.inboxId);
        if ('inbox' in attempt) {
          if (unknownKey) this.markWildcard(selected.apiKey, true);
          this.recordUsage(selected.apiKey);
          return attempt.inbox;
        }
        if (attempt.status === 429) {
          throw new UpstreamHttpError('YYDS 创建邮箱失败: 429', 429, attempt.retryAfter);
        }

        if (!body.domain) {
          // Nothing but the key was in this request, so the refusal is about
          // the key: it cannot mint on a domain of its own.
          if (unknownKey) this.markWildcard(selected.apiKey, false);
        } else if (unknownKey) {
          // The refusal is about the domain we were handed — 400
          // wildcard_rule_not_enabled_for_domain, or 403 permission_denied when
          // that domain's wildcard rule is someone else's. Neither says whether
          // THIS key owns a domain, so ask the question that does.
          const inbox = await this.probeOwnDomain(selected.apiKey, body, opts?.inboxId, true);
          if (inbox) return inbox;
        }

        // The public endpoint would refuse the same domain for the same reason.
        if (isDomainScopeError(attempt.errText)) scopeRefusal = attempt;
      } catch (e) {
        if (e instanceof UpstreamHttpError) throw e;
        if (!(e instanceof TypeError)) log.warn('wildcard inbox attempt failed', { error: errorMessage(e) });
      }

      // Report upstream's own words when it gave any, rather than a guess.
      // Either way the public endpoint is not tried: it would be refused for
      // exactly the same reason.
      if (scopeRefusal) throw this.upstreamError(scopeRefusal);
      if (selected.supportsWildcard === 1) {
        // Falling through would hand an own-domain key a public domain outside
        // its scope. Fail with a cause the operator can act on.
        throw new Error('YYDS 创建邮箱失败: 自有域名 Key 的 wildcard 接口未返回地址，公共域名不在该 Key 的授权范围内');
      }
    }

    const fallbackKey = selected.supportsWildcard === 0 ? selected : (this.pickKey(false) ?? selected);

    if (!body.domain) {
      // The public endpoint mints on a named domain. Dispatch only preselects
      // one when getDomainMode() is 'endpoint'; a direct provider call, or a
      // pool that changed mode mid-dispatch, arrives here with nothing.
      const domains = await this.getDomains();
      if (domains.length > 0) body.domain = domains[Math.floor(Math.random() * domains.length)];
    }

    const result = await this.createVia('/accounts', fallbackKey.apiKey, body, opts?.inboxId);
    if ('inbox' in result) {
      this.recordUsage(fallbackKey.apiKey);
      return result.inbox;
    }

    // Last resort for a key an earlier release latched to "no wildcard": the
    // scope refusal says it is restricted to domains of its own, so let it
    // prove that. Never demotes — the flag is already 0.
    if (result.status === 403 && isDomainScopeError(result.errText)
        && fallbackKey.supportsWildcard !== 1 && body.domain) {
      const inbox = await this.probeOwnDomain(fallbackKey.apiKey, body, opts?.inboxId, false);
      if (inbox) return inbox;
    }

    throw this.upstreamError(result);
  }

  private upstreamError(failure: CreateFailure): Error {
    if (failure.status === 0) return new Error(`YYDS 创建邮箱失败: ${failure.errText}`);
    return new UpstreamHttpError(
      `YYDS 创建邮箱失败: ${failure.status} ${failure.errText.slice(0, 100)}`,
      failure.status,
      failure.retryAfter,
      failure.errText.slice(0, 500),
    );
  }

  private async refreshToken(inbox: InboxData): Promise<string | null> {
    const res = await fetchWithTimeout(`${inbox.apiBase || API_BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${inbox.authData.tempToken}`,
      },
      body: JSON.stringify({ address: inbox.authData.address }),
    });
    if (!res.ok) return null;
    const json = await res.json() as YydsResponse<{ token?: string }>;
    if (!json.success || !json.data?.token) return null;

    const db = getDb();
    const newAuthData = { ...inbox.authData, tempToken: json.data.token };
    // Update by inbox id, not address: the same YYDS address can appear on both
    // the current row and closed history rows, and matching on address would
    // overwrite auth_data on all of them — writing this inbox's fresh token onto
    // a stale row (or clobbering a sibling lease's token).
    if (inbox.authData.inboxId) {
      db.prepare(
        `UPDATE inboxes SET auth_data = ? WHERE id = ? AND provider = 'yyds'`,
      ).run(JSON.stringify(newAuthData), inbox.authData.inboxId);
    }

    return json.data.token;
  }

  private authHeaders(inbox: InboxData): Record<string, string> {
    if (inbox.authData.apiKey) return { 'X-API-Key': inbox.authData.apiKey };
    return { Authorization: `Bearer ${inbox.authData.tempToken}` };
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    const base = inbox.apiBase || API_BASE;
    const addr = encodeURIComponent(inbox.authData.address || inbox.address);
    if (inbox.authData.apiKey) this.recordApiCall(inbox.authData.apiKey);

    let res = await fetchWithTimeout(`${base}/messages?address=${addr}`, {
      headers: this.authHeaders(inbox),
    });

    if (res.status === 401 && !inbox.authData.apiKey && inbox.authData.tempToken) {
      const newToken = await this.refreshToken(inbox);
      if (!newToken) throw new Error('YYDS token 已过期且刷新失败');
      res = await fetchWithTimeout(`${base}/messages?address=${addr}`, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
    }

    if (!res.ok) return [];
    const json = await res.json() as YydsResponse<{ messages?: YydsMessage[] }>;
    if (!json.success || !json.data?.messages) return [];

    return json.data.messages.map((m) => ({
      id: m.id || '',
      from: formatSender(m.from || {}),
      subject: m.subject || '',
      excerpt: '',
      receivedAt: providerTime(m.createdAt),
    }));
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const base = inbox.apiBase || API_BASE;
    const addr = encodeURIComponent(inbox.authData.address || inbox.address);
    if (inbox.authData.apiKey) this.recordApiCall(inbox.authData.apiKey);

    const res = await fetchWithTimeout(`${base}/messages/${messageId}?address=${addr}`, {
      headers: this.authHeaders(inbox),
    });
    if (!res.ok) throw new Error(`YYDS 获取邮件失败: ${res.status}`);

    const json = await res.json() as YydsResponse<YydsMessage>;
    if (!json.success || !json.data) throw new Error('YYDS 获取邮件失败');
    const m = json.data;

    return {
      id: m.id || messageId,
      from: formatSender(m.from || {}),
      subject: m.subject || '',
      excerpt: '',
      receivedAt: providerTime(m.createdAt),
      text: m.text || '',
      html: Array.isArray(m.html) ? m.html.join('') : (m.html || ''),
    };
  }

  async deleteInbox(inbox: InboxData): Promise<void> {
    const base = inbox.apiBase || API_BASE;
    const accountId = inbox.authData.accountId;
    if (!accountId) return;
    if (inbox.authData.apiKey) this.recordApiCall(inbox.authData.apiKey);
    await fetchWithTimeout(`${base}/accounts/${accountId}`, {
      method: 'DELETE',
      headers: this.authHeaders(inbox),
    }).catch((error: unknown) => {
      logIgnoredError(log, 'failed to delete YYDS inbox upstream', error, { accountId });
    });
  }

  async releaseInbox(inbox: InboxData): Promise<void> {
    if (!inbox.authData.apiKey) return;
    getDb().prepare(
      `UPDATE yyds_accounts SET inbox_count = MAX(0, inbox_count - 1) WHERE api_key = ?`
    ).run(inbox.authData.apiKey);
  }
}
