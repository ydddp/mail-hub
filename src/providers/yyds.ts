import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail, type ProviderMeta } from './base.js';
import { allRows, getDb, getRow } from '../db.js';
import { fetchWithTimeout, formatSender, todayDateString } from '../utils.js';
import { createLogger } from '../logger.js';
import { errorMessage, logIgnoredError } from '../errors.js';
import type Database from 'better-sqlite3';

const API_BASE = 'https://maliapi.215.im/v1';
const DAILY_QUOTA = 20000;
const DOMAIN_CACHE_TTL_MS = 15 * 60 * 1000;
const log = createLogger('yyds');

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
      if (!res.ok) return this.readCachedDomains();
      const json = await res.json() as YydsResponse<YydsDomain[]>;
      if (!json.success || !json.data) return this.readCachedDomains();
      const domains = json.data
        .filter((d) => d.isPublic && d.isVerified && d.isMxValid)
        .map((d) => d.domain)
        .filter((domain): domain is string => Boolean(domain));
      if (domains.length > 0) this.writeCachedDomains(domains);
      return domains.length > 0 ? [...new Set(domains)] : this.readCachedDomains();
    } catch (error) {
      log.warn('failed to refresh YYDS domains, using cache', { error: errorMessage(error) });
      return this.readCachedDomains();
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

  async createInbox(opts?: { domain?: string; username?: string; subdomain?: string }): Promise<InboxData> {
    const selected = this.pickKey(true);
    if (!selected) throw new Error('YYDS 账号池中无可用 API Key（可能全部达到日配额或冷却中）');

    const domain = opts?.domain;
    const localPart = opts?.username ?? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const body: Record<string, string> = { localPart };
    if (domain) body.domain = domain;
    if (opts?.subdomain) body.subdomain = opts.subdomain;

    if (opts?.subdomain || selected.supportsWildcard !== 0) {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/accounts/wildcard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': selected.apiKey },
          body: JSON.stringify(body),
        });

        if (res.status === 403) {
          this.markWildcard(selected.apiKey, false);
        } else if (res.ok) {
          const json = await res.json() as YydsResponse<YydsAccount>;
          if (json.success && isCreatedAccount(json.data)) {
            if (selected.supportsWildcard === null) this.markWildcard(selected.apiKey, true);
            this.recordUsage(selected.apiKey);
            return {
              address: json.data.address,
              authData: {
                apiKey: selected.apiKey,
                accountId: json.data.id,
                tempToken: json.data.token,
                address: json.data.address,
              },
              provider: this.meta.name,
              apiBase: API_BASE,
              expiresAt: json.data.expiresAt,
            };
          }
        }
      } catch (e) {
        if (!(e instanceof TypeError)) log.warn('wildcard inbox attempt failed', { error: errorMessage(e) });
      }
    }

    const fallbackKey = selected.supportsWildcard === 0 ? selected : (this.pickKey(false) ?? selected);

    const res = await fetchWithTimeout(`${API_BASE}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': fallbackKey.apiKey },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch((error: unknown) => {
        logIgnoredError(log, 'failed to read YYDS create error response', error);
        return '';
      });
      throw new Error(`YYDS 创建邮箱失败: ${res.status} ${errText.slice(0, 100)}`);
    }

    const json = await res.json() as YydsResponse<YydsAccount>;
    if (!json.success || !isCreatedAccount(json.data)) {
      throw new Error(`YYDS 创建邮箱失败: ${json.error || 'unknown'}`);
    }

    this.recordUsage(fallbackKey.apiKey);
    return {
      address: json.data.address,
      authData: {
        apiKey: fallbackKey.apiKey,
        accountId: json.data.id,
        tempToken: json.data.token,
        address: json.data.address,
      },
      provider: this.meta.name,
      apiBase: API_BASE,
      expiresAt: json.data.expiresAt,
    };
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
    db.prepare(
      `UPDATE inboxes SET auth_data = ? WHERE address = ? AND provider = 'yyds'`,
    ).run(JSON.stringify(newAuthData), inbox.address);

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
      receivedAt: m.createdAt || '',
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
      receivedAt: m.createdAt || '',
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
