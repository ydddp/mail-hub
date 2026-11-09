import { BaseProvider, type ProviderMeta, type InboxData, type Message, type MessageDetail } from './base.js';
import { fetchWithTimeout, randomString } from '../utils.js';
import { randomSecret } from '../crypto.js';
import { createLogger } from '../logger.js';
import { httpStatus, MessageNotFoundError, NoAssetCreatedError, UpstreamHttpError } from '../errors.js';
import { providerTime, type TimestampFormat } from '../time.js';
import {
  acquireCreationAuthentication, appendCreationCredentials, appendCreationResponse, beginCreationRecovery,
  checkpointCreation, CREATION_AUTH_TIMEOUT_MS, creationRecoveryFailure, finishCreationAuthentication,
  recoveryInboxData, type CreationAuthOperation, type CreationRecoveryRow,
} from '../creation-recovery.js';
import { TemplateCreationRecoveryError } from '../errors.js';

type JsonMap = Record<string, unknown>;
const log = createLogger('template-provider');

function isMessageObject(value: unknown): value is JsonMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMessageId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

async function readMessageResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new UpstreamHttpError('Template message read failed', response.status, response.headers.get('Retry-After'));
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error('Template message response is invalid'); }
  if (isMessageObject(data) && (data.success === false || (Array.isArray(data.errors) && data.errors.length > 0))) {
    throw new Error('Template message response reports failure');
  }
  return data;
}

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
    timestampFormat?: TimestampFormat;
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
    timestampFormat?: TimestampFormat;
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

  private messageTime(item: unknown, path: string, format?: TimestampFormat): string {
    // Older builtin rows map mail_date (only HH:mm:ss). The API also returns
    // the complete Unix timestamp. Respect custom mappings on edited rows.
    if (this.cfg.name === 'guerrillamail' && (path === 'mail_date' || path === 'mail_timestamp')) {
      return providerTime(resolvePath(item, 'mail_timestamp'), 'unix_seconds');
    }
    // TempMail.lol's date is epoch milliseconds; persisted builtin rows from
    // older releases do not yet have timestampFormat. Never guess for other
    // providers or override an operator's explicit format.
    if (!format && this.cfg.name === 'tempmail-lol' && path === 'date') {
      return providerTime(resolvePath(item, path), 'unix_milliseconds');
    }
    return providerTime(resolvePath(item, path), format);
  }
  private domainCache: { domains: string[]; expiresAt: number } | null = null;
  private static readonly DOMAIN_CACHE_MS = 5 * 60_000;
  // Failed fetches are cached briefly so a dead upstream costs one timeout
  // per minute instead of stalling every dispatch.
  private static readonly DOMAIN_FAILURE_CACHE_MS = 60_000;

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
      // Discovery must never allocate an upstream inbox. The address is
      // decided by an explicit create; only configured domains are known here.
      return domains.list || [];
    }

    if (this.domainCache && this.domainCache.expiresAt > Date.now()) {
      return this.domainCache.domains;
    }

    const url = this.buildUrl(domains.path ?? '/domains', {}, 'provider');
    const headers = this.buildGlobalHeaders();
    const rawBody = domains.body ? interpolateBody(domains.body, {}) : undefined;
    const serialized = rawBody ? serializeBody(rawBody, domains.bodyType) : undefined;
    if (serialized) headers['Content-Type'] = serialized.contentType;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: domains.method || 'GET', headers, body: serialized?.body });
    } catch (error) {
      log.warn('template provider domain fetch failed', { provider: this.cfg.name, error: error });
      this.domainCache = { domains: [], expiresAt: Date.now() + TemplateProvider.DOMAIN_FAILURE_CACHE_MS };
      return [];
    }
    if (!res.ok) {
      this.domainCache = { domains: [], expiresAt: Date.now() + TemplateProvider.DOMAIN_FAILURE_CACHE_MS };
      return [];
    }
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

  async createInbox(opts?: { domain?: string; username?: string; inboxId?: string; duration?: number }): Promise<InboxData> {
    let domain = opts?.domain;
    if (!domain && this.cfg.domains.mode !== 'from_create') {
      const domains = await this.getDomains();
      domain = domains[Math.floor(Math.random() * domains.length)];
      if (!domain) throw new NoAssetCreatedError(`[${this.cfg.name}] No domains available`);
    }
    const username = opts?.username || randomString(10);
    // The password is the upstream account's only credential (mailtm/mailgw
    // register with it, then trade it for a bearer token), so it needs a
    // CSPRNG — randomString would leak the sequence. The username does not.
    const vars: Record<string, string> = { username, domain: domain || '', address: domain ? `${username}@${domain}` : '', password: randomSecret() };

    const { create } = this.cfg;
    // Persist the only password and the exact configuration before any create
    // network I/O. Never recreate an account to recover a lost token response.
    const recovery = beginCreationRecovery(this.cfg, vars, opts?.inboxId, opts?.duration);
    let address = vars.address;
    const authData: Record<string, string> = { ...vars };
    try {
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
        const res = await fetchWithTimeout(url, { ...fetchOpts, retryMode: 'never' });
        const body = await res.text();
        appendCreationResponse(recovery.id, 'create', res, body);
        // Preserve any issued credentials even when the upstream also reports
        // failure. Its HTTP status does not prove the create did not commit.
        let data: unknown;
        try { data = JSON.parse(body); } catch (cause) {
          if (!res.ok) throw new UpstreamHttpError('Template create failed', res.status, res.headers.get('Retry-After'));
          throw cause;
        }
        const mappedAddress = resolvePath(data, create.responseMapping.address);
        if (typeof mappedAddress === 'string' && mappedAddress.trim()) address = mappedAddress;
        this.mapCredentials(data, create.responseMapping.authData, authData);
        checkpointCreation(recovery.id, 'attempting', address, authData);
        if (!res.ok) throw new UpstreamHttpError('Template create failed', res.status, res.headers.get('Retry-After'));
        if ((create.responseMapping.address && !(typeof mappedAddress === 'string' && mappedAddress.trim())) || !address.trim()) {
          throw new Error('Template create response has no valid address');
        }
        this.validateCredentials(data, create.responseMapping.authData, authData, !this.cfg.postCreate);
      }
      if (!address.trim()) throw new Error('Template create response has no valid address');
      // Local templates have no response mapping to validate, but must still
      // have every credential their actual authenticated requests require.
      if (!this.cfg.postCreate) this.validateCredentials(undefined, {}, authData, true);
      checkpointCreation(recovery.id, 'upstream_created', address, authData);
    } catch (cause) {
      log.warn('template provider create failed', { provider: this.cfg.name, status: httpStatus(cause), error: cause });
      throw creationRecoveryFailure(recovery.id, cause, 'outcome_unknown');
    }

    if (this.cfg.postCreate) return this.authenticateRecovery(recovery.id);

    try { checkpointCreation(recovery.id, 'ready', address, authData); } catch (cause) {
      throw creationRecoveryFailure(recovery.id, cause, this.cfg.postCreate ? 'auth_pending' : 'outcome_unknown');
    }
    return {
      address,
      authData,
      provider: this.cfg.name,
      apiBase: this.cfg.apiBase,
      expiresAt: recovery.expiresAt,
      creationRecoveryId: recovery.id,
    };
  }

  /** The sole authentication entry point for both first creation and retry. */
  async authenticateRecovery(id: string): Promise<InboxData> {
    let acquired: ReturnType<typeof acquireCreationAuthentication>;
    try { acquired = acquireCreationAuthentication(this.cfg.name, id); }
    catch (cause) { throw new TemplateCreationRecoveryError(id, cause); }
    const { row, operation } = acquired;
    if (!operation) return recoveryInboxData(row);
    // Mutable live template configuration must never influence an old paid
    // account's credentials, endpoint, mapping, or lifetime.
    const snapshot = new TemplateProvider(JSON.parse(row.config_snapshot) as TemplateProviderConfig);
    return snapshot.authenticateOperation(row, operation);
  }

  private async authenticateOperation(row: CreationRecoveryRow, operation: CreationAuthOperation): Promise<InboxData> {
    const authData = JSON.parse(row.auth_data) as Record<string, string>;
    let status: number | undefined;
    try {
      const pc = this.cfg.postCreate;
      if (pc) {
        const originalVariables = JSON.parse(row.variables_json) as Record<string, string>;
        const vars = { ...authData, address: row.address, password: originalVariables.password };
        const headers = this.buildGlobalHeaders();
        const rawBody = pc.body ? interpolateBody(pc.body, vars) : undefined;
        const serialized = rawBody ? serializeBody(rawBody, pc.bodyType) : undefined;
        if (serialized) headers['Content-Type'] = serialized.contentType;
        // The signal created by fetchWithTimeout also bounds Response.text().
        // The persistent 45s lease outlives this fixed 15s network budget.
        const response = await fetchWithTimeout(this.buildUrl(pc.path, vars, 'provider'), {
          method: pc.method, headers, body: serialized?.body, retryMode: 'never', timeout: CREATION_AUTH_TIMEOUT_MS,
        });
        status = response.status;
        let body: string;
        try { body = await response.text(); } catch (cause) {
          if (!response.ok) throw new UpstreamHttpError('Template authentication failed', response.status, response.headers.get('Retry-After'));
          throw cause;
        }
        // Even a stale operation must retain an issued token. These two
        // append-only writes never change phase/auth_data/status/timestamps.
        appendCreationResponse(row.id, 'authenticate', response, body, operation);
        let data: unknown;
        try { data = JSON.parse(body); } catch (cause) {
          if (!response.ok) throw new UpstreamHttpError('Template authentication failed', response.status, response.headers.get('Retry-After'));
          throw cause;
        }
        this.mapCredentials(data, pc.responseMapping.authData, authData);
        appendCreationCredentials(row.id, operation, authData, response.status);
        if (!response.ok) throw new UpstreamHttpError('Template authentication failed', response.status, response.headers.get('Retry-After'));
        this.validateCredentials(data, pc.responseMapping.authData, authData, true);
      } else {
        this.validateCredentials(undefined, {}, authData, true);
      }
      return recoveryInboxData(finishCreationAuthentication(this.cfg.name, row.id, operation, 'ready', authData, status));
    } catch (cause) {
      let failure = cause;
      try { finishCreationAuthentication(this.cfg.name, row.id, operation, 'auth_pending', authData, status); }
      catch (fenceFailure) { failure = fenceFailure; }
      log.warn('template provider authentication failed', { provider: this.cfg.name, status: httpStatus(failure), error: failure });
      throw new TemplateCreationRecoveryError(row.id, failure);
    }
  }

  private mapCredentials(data: unknown, mapping: Record<string, string>, authData: Record<string, string>): void {
    for (const [key, path] of Object.entries(mapping)) {
      const value = resolvePath(data, path);
      // Numeric account IDs are common. Booleans/objects must never turn into
      // plausible-looking bearer tokens such as "true" or "[object Object]".
      if (typeof value === 'string') authData[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) authData[key] = String(value);
    }
  }

  private validateCredentials(data: unknown, mapping: Record<string, string>, authData: Record<string, string>, requireInboxAuth: boolean): void {
    const credentialFields = new Set<string>();
    // fromList detail performs no authenticated request of its own. Even when
    // postCreate will supply missing fields later, any actual credential the
    // current response maps must already have the correct raw string type.
    for (const endpoint of [this.cfg.messages, ...(this.cfg.messageDetail.fromList ? [] : [this.cfg.messageDetail]), this.cfg.deleteInbox]) {
      if (endpoint?.authFrom === 'inbox') credentialFields.add(endpoint.authField || 'token');
    }
    const required = new Set([...Object.keys(mapping), ...(requireInboxAuth ? credentialFields : [])]);
    for (const key of required) {
      // Validate the raw mapping so a number cannot become a valid token by
      // String coercion. Other finite numeric metadata remains compatible
      // regardless of its configured field name (IDs, expiry, quota, etc.).
      const value = mapping[key] ? resolvePath(data, mapping[key]) : authData[key];
      if (typeof value === 'string' && value.trim()) continue;
      if (!credentialFields.has(key) && typeof value === 'number' && Number.isFinite(value)) continue;
      throw new Error('Template response has no valid credential');
    }
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
    const data = await readMessageResponse(res);
    const items = resolvePath(data, messages.resultPath || '$root');
    if (!Array.isArray(items)) throw new Error('Template message list is invalid');
    const result = items.map((item) => {
      const id = isMessageObject(item) ? readMessageId(resolvePath(item, messages.itemMapping.id)) : undefined;
      if (id === undefined) throw new Error('Template message list item is invalid');
      return {
        id,
        from: String(resolvePath(item, messages.itemMapping.from) || ''),
        subject: String(resolvePath(item, messages.itemMapping.subject) || ''),
        excerpt: String(resolvePath(item, messages.itemMapping.excerpt) || '').slice(0, 200),
        receivedAt: this.messageTime(item, messages.itemMapping.receivedAt, messages.timestampFormat),
      };
    });
    // A partial/invalid response must never replace the last validated list.
    this.cacheMessages(inbox.address, items);
    return result;
  }

  private _lastMessagesByInbox = new Map<string, unknown[]>();
  private static readonly MESSAGE_CACHE_MAX = 200;

  /** LRU-capped: unbounded growth would leak memory over a long-running process. */
  private cacheMessages(address: string, items: unknown[]): void {
    const cache = this._lastMessagesByInbox;
    cache.delete(address);
    cache.set(address, items);
    if (cache.size > TemplateProvider.MESSAGE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

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
      if (!item) throw new MessageNotFoundError();
      const im = messages.itemMapping;
      return {
        id: messageId,
        from: String(resolvePath(item, im.from) || ''),
        subject: String(resolvePath(item, im.subject) || ''),
        excerpt: String(resolvePath(item, im.excerpt) || '').slice(0, 200),
        receivedAt: this.messageTime(item, im.receivedAt, messages.timestampFormat),
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
    const data = await readMessageResponse(res);
    const m = messageDetail.responseMapping;
    if (!isMessageObject(data) || !Object.values(m).some(path => {
      const value = resolvePath(data, path);
      return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
    })) throw new Error('Template message detail is invalid');
    return {
      id: readMessageId(resolvePath(data, m.id)) ?? messageId,
      from: String(resolvePath(data, m.from) || ''),
      subject: String(resolvePath(data, m.subject) || ''),
      excerpt: String((m.text && resolvePath(data, m.text)) || '').slice(0, 200),
      receivedAt: this.messageTime(data, m.receivedAt, messageDetail.timestampFormat),
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
    await fetchWithTimeout(url, { method: del.method, headers, retryMode: 'never' });
  }
}
