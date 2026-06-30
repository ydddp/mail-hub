import { BaseProvider, type ProviderMeta, type InboxData, type Message, type MessageDetail } from './base.js';
import { fetchWithTimeout, randomString } from '../utils.js';
import { createLogger } from '../logger.js';
import { errorMessage, UpstreamHttpError } from '../errors.js';

type JsonMap = Record<string, unknown>;
const log = createLogger('template-provider');

export interface TemplateProviderConfig {
  name: string;
  displayName: string;
  tier: 'free' | 'paid';
  trustLevel: number;
  rateLimit: { createPerMinute: number; pollPerMinute: number };
  retention: string;
  features: { customUsername: boolean; pollInbox: boolean; attachments: boolean };

  apiBase: string;
  auth: {
    type: 'bearer' | 'header' | 'query' | 'none';
    headerName?: string;
    queryParam?: string;
    value?: string;
  };
  extraHeaders?: Record<string, string>;

  domains: {
    mode: 'endpoint' | 'static' | 'from_create';
    list?: string[];
    path?: string;
    method?: string;
    body?: JsonMap;
    bodyType?: 'json' | 'form';
    resultPath?: string;
    domainField?: string;
    filter?: { field: string; equals: unknown };
  };

  create: {
    /** When true, skip the HTTP call and synthesize the inbox locally from username+domain. */
    skip?: boolean;
    path: string;
    method: string;
    body?: JsonMap;
    bodyType?: 'json' | 'form';
    responseMapping: {
      address: string;
      authData: Record<string, string>;
    };
    expiresIn?: number;
  };

  postCreate?: {
    path: string;
    method: string;
    body?: JsonMap;
    bodyType?: 'json' | 'form';
    responseMapping: {
      authData: Record<string, string>;
    };
  };

  messages: {
    path: string;
    method?: string;
    body?: JsonMap;
    bodyType?: 'json' | 'form';
    authFrom: 'provider' | 'inbox';
    authField?: string;
    resultPath?: string;
    itemMapping: {
      id: string;
      from: string;
      subject: string;
      excerpt: string;
      receivedAt: string;
      text?: string;
      html?: string;
    };
  };

  messageDetail: {
    fromList?: boolean;
    path: string;
    method?: string;
    body?: JsonMap;
    bodyType?: 'json' | 'form';
    authFrom: 'provider' | 'inbox';
    authField?: string;
    responseMapping: {
      id: string;
      from: string;
      subject: string;
      text?: string;
      html?: string;
      receivedAt: string;
    };
  };

  deleteInbox?: {
    path: string;
    method: string;
    authFrom: 'provider' | 'inbox';
    authField?: string;
  };
}

function serializeBody(body: JsonMap, bodyType: 'json' | 'form' | undefined): { body: string; contentType: string } {
  if (bodyType === 'form') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v != null) params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  return { body: JSON.stringify(body), contentType: 'application/json' };
}


export function resolvePath(obj: unknown, path: string): unknown {
  if (path === '$root') return obj;
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function interpolateBody(body: JsonMap, vars: Record<string, string>): JsonMap {
  const result: JsonMap = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string') result[k] = interpolate(v, vars);
    else if (v && typeof v === 'object' && !Array.isArray(v)) result[k] = interpolateBody(v as JsonMap, vars);
    else result[k] = v;
  }
  return result;
}


export class TemplateProvider extends BaseProvider {
  meta: ProviderMeta;
  private cfg: TemplateProviderConfig;
  private domainCache: { domains: string[]; expiresAt: number } | null = null;
  private static readonly DOMAIN_CACHE_MS = 5 * 60_000;

  constructor(cfg: TemplateProviderConfig) {
    super();
    this.cfg = cfg;
    this.meta = {
      name: cfg.name,
      displayName: cfg.displayName,
      type: 'api',
      tier: cfg.tier,
      trustLevel: cfg.trustLevel,
      rateLimit: cfg.rateLimit,
      retention: cfg.retention,
      features: { ...cfg.features, realtime: false },
    };
  }

  getDomainMode(): TemplateProviderConfig['domains']['mode'] {
    return this.cfg.domains.mode;
  }

  private buildGlobalHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.cfg.extraHeaders };
    const { auth } = this.cfg;
    if (auth.type === 'bearer' && auth.value) headers['Authorization'] = `Bearer ${auth.value}`;
    else if (auth.type === 'header' && auth.headerName && auth.value) headers[auth.headerName] = auth.value;
    return headers;
  }

  private buildInboxHeaders(inbox: InboxData, authField?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.cfg.extraHeaders };
    const token = inbox.authData[authField || 'token'] || '';
    headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  private buildUrl(path: string, vars: Record<string, string>, authFrom?: 'provider' | 'inbox', inbox?: InboxData, authField?: string): string {
    const base = inbox?.apiBase || this.cfg.apiBase;
    let url = base + interpolate(path, vars);
    if (authFrom === 'provider' && this.cfg.auth.type === 'query' && this.cfg.auth.queryParam && this.cfg.auth.value) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}${this.cfg.auth.queryParam}=${encodeURIComponent(this.cfg.auth.value)}`;
    }
    return url;
  }


  async getDomains(): Promise<string[]> {
    const { domains } = this.cfg;
    if (domains.mode === 'static') return domains.list || [];

    if (domains.mode === 'from_create') {
      try {
        const inbox = await this.createInbox();
        const domain = inbox.address.split('@')[1];
        return domain ? [domain] : [];
      } catch (error) {
        log.warn('failed to infer template provider domain from create call', { provider: this.cfg.name, error: errorMessage(error) });
        return [];
      }
    }

    if (this.domainCache && this.domainCache.expiresAt > Date.now()) {
      return this.domainCache.domains;
    }

    const url = this.buildUrl(domains.path ?? '/domains', {}, 'provider');
    const headers = this.buildGlobalHeaders();
    const rawBody = domains.body ? interpolateBody(domains.body, {}) : undefined;
    const serialized = rawBody ? serializeBody(rawBody, domains.bodyType) : undefined;
    if (serialized) headers['Content-Type'] = serialized.contentType;
    const res = await fetchWithTimeout(url, { method: domains.method || 'GET', headers, body: serialized?.body });
    if (!res.ok) return [];
    const data = await res.json();
    let items: unknown[] = [];
    const resolvedItems = resolvePath(data, domains.resultPath || '$root');
    if (!Array.isArray(resolvedItems)) return [];
    items = resolvedItems;
    if (domains.filter) {
      items = items.filter((item) => resolvePath(item, domains.filter!.field) === domains.filter!.equals);
    }
    const resolvedDomains = domains.domainField ? items
      .map((item) => resolvePath(item, domains.domainField!))
      .filter((domain): domain is string => typeof domain === 'string' && Boolean(domain))
      : items.filter((item): item is string => typeof item === 'string');
    this.domainCache = { domains: resolvedDomains, expiresAt: Date.now() + TemplateProvider.DOMAIN_CACHE_MS };
    return resolvedDomains;
  }

  async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    let domain = opts?.domain;
    if (!domain && this.cfg.domains.mode !== 'from_create') {
      const domains = await this.getDomains();
      domain = domains[Math.floor(Math.random() * domains.length)];
      if (!domain) throw new Error(`[${this.cfg.name}] No domains available`);
    }
    const username = opts?.username || randomString(10);
    const vars: Record<string, string> = { username, domain: domain || '', address: domain ? `${username}@${domain}` : '', password: randomString(12) };

    const { create } = this.cfg;

    let data: unknown = {};
    if (!create.skip) {
      const url = this.buildUrl(create.path, vars, 'provider');
      const headers = this.buildGlobalHeaders();
      const methodAllowsBody = create.method !== 'GET' && create.method !== 'HEAD';
      const rawBody = create.body ? interpolateBody(create.body, vars) : (methodAllowsBody ? { address: vars.address, password: vars.password } : undefined);
      const fetchOpts: RequestInit = { method: create.method, headers };
      if (rawBody) {
        const serialized = serializeBody(rawBody, create.bodyType);
        headers['Content-Type'] = serialized.contentType;
        fetchOpts.body = serialized.body;
      }
      const res = await fetchWithTimeout(url, fetchOpts);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.warn('template provider create failed', {
          provider: this.cfg.name,
          status: res.status,
          retryAfter: res.headers.get('Retry-After'),
          body: body.slice(0, 500),
        });
        throw new UpstreamHttpError(
          `[${this.cfg.name}] Create failed: ${res.status}`,
          res.status,
          res.headers.get('Retry-After'),
          body.slice(0, 500),
        );
      }
      data = await res.json();
    }

    const mappedAddress = create.skip ? null : resolvePath(data, create.responseMapping.address);
    const address = (typeof mappedAddress === 'string' && mappedAddress) || vars.address;
    const authData: Record<string, string> = { ...vars };
    for (const [key, path] of Object.entries(create.responseMapping.authData)) {
      const val = resolvePath(data, path);
      if (val != null) authData[key] = String(val);
    }

    if (this.cfg.postCreate) {
      const pc = this.cfg.postCreate;
      const pcVars = { ...authData, address };
      const pcUrl = this.buildUrl(pc.path, pcVars, 'provider');
      const pcHeaders = this.buildGlobalHeaders();
      const pcRawBody = pc.body ? interpolateBody(pc.body, pcVars) : undefined;
      const pcSerialized = pcRawBody ? serializeBody(pcRawBody, pc.bodyType) : undefined;
      if (pcSerialized) pcHeaders['Content-Type'] = pcSerialized.contentType;
      const pcRes = await fetchWithTimeout(pcUrl, { method: pc.method, headers: pcHeaders, body: pcSerialized?.body });
      if (pcRes.ok) {
        const pcData = await pcRes.json();
        for (const [key, path] of Object.entries(pc.responseMapping.authData)) {
          const val = resolvePath(pcData, path);
          if (val != null) authData[key] = String(val);
        }
      }
    }

    return {
      address,
      authData,
      provider: this.cfg.name,
      apiBase: this.cfg.apiBase,
      expiresAt: create.expiresIn ? new Date(Date.now() + create.expiresIn * 1000).toISOString() : undefined,
    };
  }


  async getMessages(inbox: InboxData): Promise<Message[]> {
    const { messages } = this.cfg;
    const vars = { ...inbox.authData, address: inbox.address };
    const url = this.buildUrl(messages.path, vars, messages.authFrom, inbox, messages.authField);
    const headers = messages.authFrom === 'inbox' ? this.buildInboxHeaders(inbox, messages.authField) : this.buildGlobalHeaders();
    const rawBody = messages.body ? interpolateBody(messages.body, vars) : undefined;
    const serialized = rawBody ? serializeBody(rawBody, messages.bodyType) : undefined;
    if (serialized) headers['Content-Type'] = serialized.contentType;
    const res = await fetchWithTimeout(url, { method: messages.method || 'GET', headers, body: serialized?.body });
    if (!res.ok) return [];
    const data = await res.json();
    const items = resolvePath(data, messages.resultPath || '$root');
    if (!Array.isArray(items)) return [];
    this._lastMessagesByInbox.set(inbox.address, items);
    return items.map((item) => ({
      id: String(resolvePath(item, messages.itemMapping.id) || ''),
      from: String(resolvePath(item, messages.itemMapping.from) || ''),
      subject: String(resolvePath(item, messages.itemMapping.subject) || ''),
      excerpt: String(resolvePath(item, messages.itemMapping.excerpt) || '').slice(0, 200),
      receivedAt: String(resolvePath(item, messages.itemMapping.receivedAt) || ''),
    }));
  }

  private _lastMessagesByInbox = new Map<string, unknown[]>();

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const { messageDetail, messages } = this.cfg;

    if (messageDetail.fromList) {
      const key = inbox.address;
      let cached = this._lastMessagesByInbox.get(key);
      if (!cached) {
        await this.getMessages(inbox);
        cached = this._lastMessagesByInbox.get(key);
      }
      const item = cached?.find((message) => String(resolvePath(message, messages.itemMapping.id)) === messageId);
      if (!item) throw new Error(`[${this.cfg.name}] Message not found: ${messageId}`);
      const im = messages.itemMapping;
      return {
        id: messageId,
        from: String(resolvePath(item, im.from) || ''),
        subject: String(resolvePath(item, im.subject) || ''),
        excerpt: String(resolvePath(item, im.excerpt) || '').slice(0, 200),
        receivedAt: String(resolvePath(item, im.receivedAt) || ''),
        text: im.text ? String(resolvePath(item, im.text) ?? '') : undefined,
        html: im.html ? String(resolvePath(item, im.html) ?? '') : undefined,
      };
    }

    const vars = { ...inbox.authData, address: inbox.address, messageId };
    const url = this.buildUrl(messageDetail.path, vars, messageDetail.authFrom, inbox, messageDetail.authField);
    const headers = messageDetail.authFrom === 'inbox' ? this.buildInboxHeaders(inbox, messageDetail.authField) : this.buildGlobalHeaders();
    const rawBody = messageDetail.body ? interpolateBody(messageDetail.body, vars) : undefined;
    const serialized = rawBody ? serializeBody(rawBody, messageDetail.bodyType) : undefined;
    if (serialized) headers['Content-Type'] = serialized.contentType;
    const res = await fetchWithTimeout(url, { method: messageDetail.method || 'GET', headers, body: serialized?.body });
    if (!res.ok) throw new Error(`[${this.cfg.name}] getMessage failed: ${res.status}`);
    const data = await res.json();
    const m = messageDetail.responseMapping;
    return {
      id: String(resolvePath(data, m.id) || messageId),
      from: String(resolvePath(data, m.from) || ''),
      subject: String(resolvePath(data, m.subject) || ''),
      excerpt: String((m.text && resolvePath(data, m.text)) || '').slice(0, 200),
      receivedAt: String(resolvePath(data, m.receivedAt) || ''),
      text: m.text ? String(resolvePath(data, m.text) ?? '') : undefined,
      html: m.html ? String(resolvePath(data, m.html) ?? '') : undefined,
    };
  }

  async deleteInbox(inbox: InboxData): Promise<void> {
    if (!this.cfg.deleteInbox) return;
    const del = this.cfg.deleteInbox;
    const vars = { ...inbox.authData, address: inbox.address };
    const url = this.buildUrl(del.path, vars, del.authFrom, inbox, del.authField);
    const headers = del.authFrom === 'inbox' ? this.buildInboxHeaders(inbox, del.authField) : this.buildGlobalHeaders();
    await fetchWithTimeout(url, { method: del.method, headers });
  }
}
