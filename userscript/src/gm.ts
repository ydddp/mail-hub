/**
 * The only place that touches the script manager's privileged APIs. Everything
 * else takes an injected adapter, so the request/storage/tab contracts can be
 * tested without a browser.
 */

export interface HttpRequest {
  method: string;
  /** Absolute URL. Callers build it from the configured base and nothing else. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  responseText: string;
  headers?: Record<string, string>;
  /** Where the manager says the response actually came from, when it reports it. */
  finalUrl?: string;
}

export type HttpSend = (req: HttpRequest) => Promise<HttpResponse>;

export interface KeyValueStore {
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface GmXhrResponse {
  status: number;
  responseText?: string;
  responseHeaders?: string;
  finalUrl?: string;
  error?: string;
}

export interface GmXhrDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  redirect?: 'follow' | 'error' | 'manual';
  onload?: (response: GmXhrResponse) => void;
  onerror?: (response: GmXhrResponse) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}

export interface GmApi {
  xmlhttpRequest?: (details: GmXhrDetails) => { abort?: () => void };
  getValue?: <T>(key: string, fallback: T) => Promise<T> | T;
  setValue?: (key: string, value: unknown) => Promise<void> | void;
  deleteValue?: (key: string) => Promise<void> | void;
  /** Per-tab script-manager state, used to survive a cross-origin navigation. */
  getTab?: <T = unknown>(callback: (state: T | null) => void) => void;
  saveTab?: (state: unknown, callback?: () => void) => void;
  registerMenuCommand?: (caption: string, onClick: () => void) => unknown;
}

/** Raised by the transport when the caller (not a deadline) cancelled. */
export class RequestAbortedError extends Error {
  readonly name = 'RequestAbortedError';
}

/** Raised when our own deadline elapsed before any response arrived. */
export class RequestTimeoutError extends Error {
  readonly name = 'RequestTimeoutError';
}

function toHeaderMap(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (raw ?? '').split(/[\r\n]+/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

/**
 * Destination policy: `url` is whatever the caller built, and the request is
 * made with `redirect: 'error'`. A redirect therefore fails the request instead
 * of re-sending the Authorization header to the redirect target. api.ts also
 * rejects a response whose `finalUrl` left the configured origin, in case the
 * manager ignored the option.
 */
export function createGmTransport(gm: GmApi): HttpSend {
  return (request) => new Promise<HttpResponse>((resolve, reject) => {
    if (!gm.xmlhttpRequest) {
      reject(new TypeError('GM_xmlhttpRequest is not available'));
      return;
    }

    let settled = false;
    const detach = () => request.signal?.removeEventListener('abort', abort);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      action();
    };

    const handle = gm.xmlhttpRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      data: request.body,
      timeout: request.timeoutMs,
      redirect: 'error',
      onload: (response) => finish(() => resolve({
        status: response.status,
        responseText: response.responseText ?? '',
        headers: toHeaderMap(response.responseHeaders),
        ...(response.finalUrl ? { finalUrl: response.finalUrl } : {}),
      })),
      onerror: (response) => finish(() => reject(new TypeError(response?.error ?? 'network error'))),
      ontimeout: () => finish(() => reject(new RequestTimeoutError('request timed out'))),
      onabort: () => finish(() => reject(new RequestAbortedError('request aborted'))),
    });

    function abort() {
      try { handle.abort?.(); } catch { /* already finished */ }
    }

    if (request.signal) {
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

async function settle<T>(value: Promise<T> | T): Promise<T> {
  return await value;
}

export function createGmKeyValueStore(gm: GmApi): KeyValueStore {
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      if (!gm.getValue) return fallback;
      const value = await settle(gm.getValue<T>(key, fallback));
      return value === undefined ? fallback : value;
    },
    async set(key, value) {
      await gm.setValue?.(key, value);
    },
    async remove(key) {
      await gm.deleteValue?.(key);
    },
  };
}

/** Non-persistent store; the default in tests and in pages without GM storage. */
export function memoryKeyValueStore(seed: Record<string, unknown> = {}): KeyValueStore {
  const values = new Map<string, unknown>(Object.entries(seed));
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      return (values.has(key) ? values.get(key) as T : fallback);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

export function detectGm(): GmApi | null {
  const scope = globalThis as unknown as Record<string, unknown>;
  const gm = scope.GM as GmApi | undefined;
  if (gm?.xmlhttpRequest) return gm;
  const xhr = scope.GM_xmlhttpRequest as GmApi['xmlhttpRequest'] | undefined;
  if (!xhr) return null;
  return {
    xmlhttpRequest: xhr,
    getValue: scope.GM_getValue as GmApi['getValue'],
    setValue: scope.GM_setValue as GmApi['setValue'],
    deleteValue: scope.GM_deleteValue as GmApi['deleteValue'],
    getTab: scope.GM_getTab as GmApi['getTab'],
    saveTab: scope.GM_saveTab as GmApi['saveTab'],
    registerMenuCommand: scope.GM_registerMenuCommand as GmApi['registerMenuCommand'],
  };
}

/**
 * Per-tab state from the script manager. It survives navigations inside the
 * tab, including to another site, which is what lets a run follow the user to
 * an OAuth page. Managers without it read as an empty object; the caller then
 * falls back to per-site enabling.
 */
export function readTabState(gm: GmApi, timeoutMs = 400): Promise<Record<string, unknown>> {
  const getTab = gm.getTab;
  if (!getTab) return Promise.resolve({});
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      resolve(value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {});
    };
    try { getTab((state) => finish(state)); } catch { finish({}); }
    setTimeout(() => finish({}), timeoutMs);
  });
}

export async function writeTabState(gm: GmApi, state: Record<string, unknown>): Promise<void> {
  const saveTab = gm.saveTab;
  if (!saveTab) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { saveTab(state, finish); } catch { finish(); }
    // Some managers never call back; saving is still done synchronously there.
    setTimeout(finish, 200);
  });
}
