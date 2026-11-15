import { t } from './i18n.js';
import type { MessageKey } from './i18n.js';
import type { HttpRequest, HttpResponse, HttpSend } from './gm.js';
import { normalizeService } from './service.js';

export { RequestAbortedError, RequestTimeoutError } from './gm.js';

/** Server-side limits for `excludeMessageId`, enforced here before sending. */
export const MAX_EXCLUDE_IDS = 20;
export const MAX_EXCLUDE_UNIT = 2048;
export const MAX_EXCLUDE_BYTES = 8192;
export const MAX_CODE_WAIT_SECONDS = 120;

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'quota'
  | 'upstream'
  | 'invalid'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'protocol';

/**
 * A failure classified by what the user can do about it. `network` and `timeout`
 * are never evidence that a signup failed, and `protocol` means the response
 * could not be trusted at all.
 */
export class ApiError extends Error {
  readonly name = 'ApiError';

  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
    /** Language-independent reason, for callers that branch on the cause. */
    readonly code?: 'exclusions-full',
  ) {
    super(message);
  }
}

export type BaseUrlReason = 'empty' | 'invalid' | 'scheme' | 'credentials' | 'query' | 'hash';

export type BaseUrlResult =
  | { ok: true; baseUrl: string; insecure: boolean }
  | { ok: false; reason: BaseUrlReason; message: string };

const BASE_URL_MESSAGES: Record<BaseUrlReason, MessageKey> = {
  empty: 'url.empty',
  invalid: 'url.invalid',
  scheme: 'url.scheme',
  credentials: 'url.credentials',
  query: 'url.query',
  hash: 'url.hash',
};

/**
 * Normalize the connection base. A bare host is treated as HTTPS; plain HTTP is
 * accepted only when written explicitly, and reported as insecure so the panel
 * can say so. Credentials, query strings and fragments are refused rather than
 * stripped, because a secret pasted there is a secret in a log.
 */
export function normalizeBaseUrl(input: string): BaseUrlResult {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty', message: t(BASE_URL_MESSAGES.empty) };

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid', message: t(BASE_URL_MESSAGES.invalid) };
  }

  const fail = (reason: BaseUrlReason): BaseUrlResult => ({ ok: false, reason, message: t(BASE_URL_MESSAGES[reason]) });
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('scheme');
  if (url.username || url.password) return fail('credentials');
  if (url.search) return fail('query');
  if (url.hash) return fail('hash');

  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.origin}${path}`, insecure: url.protocol === 'http:' && !isLoopbackHost(url.hostname) };
}

/** Hosts that resolve to this machine: plain http to them never leaves it. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

export interface ProviderRateStatus {
  available: boolean;
  nextAvailableAt: string | null;
  cooldownReason: string | null;
}

export interface ProviderSummary {
  name: string;
  displayName: string;
  enabled: boolean;
  autoDispatch: boolean;
  tier: 'free' | 'paid';
  features: { pollInbox: boolean };
  rateStatus: ProviderRateStatus;
}

export interface CreatedInbox {
  id: string;
  address: string;
  provider: string;
  expiresAt: string | null;
  features: Record<string, boolean>;
}

export interface InboxStatus {
  id: string;
  address: string;
  provider: string;
  /** Service recorded at creation; the server never re-derives it from us. */
  service: string | null;
  status: string;
  expiresAt: string | null;
}

export interface InboxRow {
  id: string;
  address: string;
  provider: string;
  service: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  status: string;
}

export interface ExtractedCode {
  type: 'numeric' | 'alphanumeric' | 'link';
  value: string;
  confidence?: number;
  context?: string;
}

export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  excerpt: string;
  receivedAt: string;
}

export interface MessageDetail extends MessageSummary {
  text: string | null;
  html: string | null;
}

export interface CodeResult {
  codes: ExtractedCode[];
  email: { from?: string; subject?: string; recipientAddress?: string | null } | null;
  messageId: string | null;
  receivedAt: string | null;
}

export interface ReportResult {
  ok: boolean;
  action?: string;
}

export interface CreateInboxInput {
  /** Already resolved service identifier; re-normalized before it is sent. */
  service: string;
  /** `null` means "自动分配 · 按服务顺序" and must not be sent as a field. */
  provider: string | null;
}

export interface WaitForCodeInput {
  inboxId: string;
  timeoutSeconds: number;
  exclude: string[];
}

export interface ApiClient {
  listProviders(): Promise<ProviderSummary[]>;
  createInbox(input: CreateInboxInput): Promise<CreatedInbox>;
  getInbox(id: string): Promise<InboxStatus>;
  findInboxes(service: string): Promise<InboxRow[]>;
  waitForCode(input: WaitForCodeInput): Promise<CodeResult>;
  listMessages(inboxId: string): Promise<MessageSummary[]>;
  getMessage(inboxId: string, messageId: string): Promise<MessageDetail>;
  reportSuccess(inboxId: string, service: string): Promise<ReportResult>;
  closeInbox(inboxId: string): Promise<ReportResult>;
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  send: HttpSend;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isExclusionWithinLimits(exclude: string[]): boolean {
  if (exclude.length > MAX_EXCLUDE_IDS) return false;
  let bytes = 0;
  for (const value of exclude) {
    // UTF-16 units, matching the server's `value.length` check.
    if (value.length > MAX_EXCLUDE_UNIT) return false;
    bytes += new TextEncoder().encode(value).length;
  }
  return bytes <= MAX_EXCLUDE_BYTES;
}

function statusToKind(status: number): ApiErrorKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'quota';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'invalid';
  return 'protocol';
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const baseOrigin = new URL(base).origin;

  function endpoint(path: string, query: Array<[string, string]> = []): string {
    const url = new URL(`${base}${path}`);
    // Defence in depth: a path that escaped the configured base would carry the
    // bearer token somewhere it was never meant to go.
    if (url.origin !== baseOrigin) throw new ApiError('protocol', '请求地址越过了配置的 Mail Hub');
    for (const [key, value] of query) url.searchParams.append(key, value);
    return url.toString();
  }

  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; payload: unknown; headers?: Record<string, string> }> {
    const request: HttpRequest = {
      method,
      url,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      timeoutMs,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    let response: HttpResponse;
    try {
      response = await options.send(request);
    } catch (error) {
      if (error instanceof Error && error.name === 'RequestAbortedError') {
        throw new ApiError('aborted', '请求已取消');
      }
      if (error instanceof Error && error.name === 'RequestTimeoutError') {
        throw new ApiError('timeout', '请求超时');
      }
      throw new ApiError('network', error instanceof Error ? error.message : '网络请求失败');
    }

    if (response.finalUrl) {
      let finalOrigin: string | null = null;
      try { finalOrigin = new URL(response.finalUrl).origin; } catch { finalOrigin = null; }
      if (finalOrigin !== baseOrigin) {
        throw new ApiError('protocol', '响应来自配置以外的地址，已丢弃');
      }
    }

    const kind = statusToKind(response.status);
    let payload: unknown = null;
    if (response.responseText) {
      try {
        payload = JSON.parse(response.responseText);
      } catch {
        if (!kind) throw new ApiError('protocol', '响应不是 JSON', response.status);
      }
    }

    if (kind) {
      const record = asRecord(payload);
      const message = typeof record?.error === 'string' ? record.error : `HTTP ${response.status}`;
      const retryAfter = kind === 'quota'
        ? headerValue(response.headers, 'retry-after')
          ?? (typeof record?.retryAfter === 'string' ? record.retryAfter : null)
        : undefined;
      throw new ApiError(kind, message, response.status, retryAfter);
    }

    return { status: response.status, payload, headers: response.headers };
  }

  return {
    async listProviders() {
      const { payload } = await request('GET', endpoint('/api/providers'), undefined, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const providers = asRecord(payload)?.providers;
      if (!Array.isArray(providers)) throw new ApiError('protocol', '提供商列表格式不符合预期');
      return providers.flatMap((entry): ProviderSummary[] => {
        const record = asRecord(entry);
        if (!record || typeof record.name !== 'string') return [];
        const features = asRecord(record.features);
        const rate = asRecord(record.rateStatus);
        return [{
          name: record.name,
          displayName: typeof record.displayName === 'string' ? record.displayName : record.name,
          enabled: record.enabled !== false,
          autoDispatch: record.autoDispatch !== false,
          tier: record.tier === 'paid' ? 'paid' : 'free',
          features: { pollInbox: features?.pollInbox === true },
          rateStatus: {
            available: rate?.available !== false,
            nextAvailableAt: typeof rate?.nextAvailableAt === 'string' ? rate.nextAvailableAt : null,
            cooldownReason: typeof rate?.cooldownReason === 'string' ? rate.cooldownReason : null,
          },
        }];
      });
    },

    async createInbox(input) {
      const service = normalizeService(input.service);
      if (!service) throw new ApiError('invalid', t('err.badService'));

      const body: Record<string, unknown> = { for: service, needPolling: true };
      if (input.provider) body.provider = input.provider;

      const { payload } = await request(
        'POST', endpoint('/api/inbox'), body, options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const record = asRecord(payload);
      if (!record || typeof record.id !== 'string' || typeof record.address !== 'string'
        || typeof record.provider !== 'string') {
        throw new ApiError('protocol', '创建结果格式不符合预期');
      }
      return {
        id: record.id,
        address: record.address,
        provider: record.provider,
        expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
        features: asRecord(record.features) as Record<string, boolean> ?? {},
      };
    },

    async getInbox(id) {
      const { payload } = await request(
        'GET', endpoint(`/api/inbox/${encodeURIComponent(id)}`), undefined, options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const record = asRecord(payload);
      if (!record || typeof record.id !== 'string' || typeof record.address !== 'string') {
        throw new ApiError('protocol', '邮箱状态格式不符合预期');
      }
      return {
        id: record.id,
        address: record.address,
        provider: typeof record.provider === 'string' ? record.provider : '',
        service: typeof record.target_service === 'string' ? record.target_service : null,
        status: typeof record.status === 'string' ? record.status : 'unknown',
        expiresAt: typeof record.expires_at === 'string' ? record.expires_at : null,
      };
    },

    async findInboxes(service) {
      const { payload } = await request('GET', endpoint('/api/inboxes', [
        ['for', service],
        ['status', 'active'],
      ]), undefined, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const rows = asRecord(payload)?.inboxes;
      if (!Array.isArray(rows)) throw new ApiError('protocol', '邮箱列表格式不符合预期');
      return rows.flatMap((entry): InboxRow[] => {
        const record = asRecord(entry);
        if (!record || typeof record.id !== 'string' || typeof record.address !== 'string') return [];
        return [{
          id: record.id,
          address: record.address,
          provider: typeof record.provider === 'string' ? record.provider : '',
          service: typeof record.target_service === 'string' ? record.target_service : null,
          createdAt: typeof record.created_at === 'string' ? record.created_at : null,
          expiresAt: typeof record.expires_at === 'string' ? record.expires_at : null,
          status: typeof record.status === 'string' ? record.status : 'unknown',
        }];
      });
    },

    async waitForCode(input) {
      if (!isExclusionWithinLimits(input.exclude)) {
        throw new ApiError('invalid', t('err.seenFull'), undefined, null, 'exclusions-full');
      }
      const timeout = Math.min(MAX_CODE_WAIT_SECONDS, Math.max(1, Math.trunc(input.timeoutSeconds) || 1));
      const query: Array<[string, string]> = [
        ['wait', 'true'],
        ['timeout', String(timeout)],
        ...input.exclude.map((id): [string, string] => ['excludeMessageId', id]),
      ];
      const { payload } = await request(
        'GET', endpoint(`/api/inbox/${encodeURIComponent(input.inboxId)}/code`, query),
        undefined, timeout * 1000 + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      );
      const record = asRecord(payload);
      if (!record) throw new ApiError('protocol', '收件结果格式不符合预期');
      const codes = Array.isArray(record.codes) ? record.codes.flatMap((entry): ExtractedCode[] => {
        const code = asRecord(entry);
        if (!code || typeof code.value !== 'string') return [];
        const type = code.type === 'numeric' || code.type === 'alphanumeric' || code.type === 'link'
          ? code.type : 'alphanumeric';
        return [{
          type,
          value: code.value,
          confidence: typeof code.confidence === 'number' ? code.confidence : undefined,
          context: typeof code.context === 'string' ? code.context : undefined,
        }];
      }) : [];
      const email = asRecord(record.email);
      return {
        codes,
        email: email ? {
          from: typeof email.from === 'string' ? email.from : undefined,
          subject: typeof email.subject === 'string' ? email.subject : undefined,
          recipientAddress: typeof email.recipientAddress === 'string' ? email.recipientAddress : null,
        } : null,
        messageId: typeof record.messageId === 'string' ? record.messageId : null,
        receivedAt: typeof record.receivedAt === 'string' ? record.receivedAt : null,
      };
    },

    async listMessages(inboxId) {
      const { payload } = await request(
        'GET', endpoint(`/api/inbox/${encodeURIComponent(inboxId)}/messages`), undefined,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const rows = asRecord(payload)?.messages;
      if (!Array.isArray(rows)) throw new ApiError('protocol', '邮件列表格式不符合预期');
      return rows.flatMap((entry): MessageSummary[] => {
        const record = asRecord(entry);
        if (!record || typeof record.id !== 'string') return [];
        return [{
          id: record.id,
          from: typeof record.from === 'string' ? record.from : '',
          subject: typeof record.subject === 'string' ? record.subject : '',
          excerpt: typeof record.excerpt === 'string' ? record.excerpt : '',
          receivedAt: typeof record.receivedAt === 'string' ? record.receivedAt : '',
        }];
      });
    },

    async getMessage(inboxId, messageId) {
      const { payload } = await request(
        'GET',
        endpoint(`/api/inbox/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`),
        undefined,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const record = asRecord(payload);
      if (!record || typeof record.id !== 'string') throw new ApiError('protocol', '邮件内容格式不符合预期');
      return {
        id: record.id,
        from: typeof record.from === 'string' ? record.from : '',
        subject: typeof record.subject === 'string' ? record.subject : '',
        excerpt: typeof record.excerpt === 'string' ? record.excerpt : '',
        receivedAt: typeof record.receivedAt === 'string' ? record.receivedAt : '',
        text: typeof record.text === 'string' ? record.text : null,
        html: typeof record.html === 'string' ? record.html : null,
      };
    },

    async reportSuccess(inboxId, service) {
      const normalized = normalizeService(service);
      if (!normalized) throw new ApiError('invalid', t('err.badService'));
      const { payload } = await request(
        'POST',
        endpoint(`/api/inbox/${encodeURIComponent(inboxId)}/report`),
        { success: true, service: normalized },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const record = asRecord(payload);
      return { ok: record?.ok !== false, action: typeof record?.action === 'string' ? record.action : undefined };
    },

    async closeInbox(inboxId) {
      const { payload } = await request(
        'DELETE', endpoint(`/api/inbox/${encodeURIComponent(inboxId)}`), undefined,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const record = asRecord(payload);
      return { ok: record?.ok !== false };
    },
  };
}
