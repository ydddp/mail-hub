import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { getSetting } from './db.js';
import { config } from './config.js';
import { errorCode } from './errors.js';

function getEffectiveProxyUrl(): string {
  return getSetting('proxy_url') || config.proxyUrl;
}

let cachedProxyUrl = '';
let cachedDispatcher: Dispatcher | undefined;

export function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function formatSender(from: { name?: string; address?: string }): string {
  return from.name ? `${from.name} <${from.address}>` : (from.address || '');
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getProxyDispatcher(forceNew = false): Dispatcher | undefined {
  const proxyUrl = getEffectiveProxyUrl();
  if (!proxyUrl) {
    cachedProxyUrl = '';
    cachedDispatcher = undefined;
    return undefined;
  }
  if (proxyUrl !== cachedProxyUrl || forceNew) {
    cachedProxyUrl = proxyUrl;
    cachedDispatcher = new ProxyAgent(proxyUrl);
  }
  return cachedDispatcher;
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e && typeof e === 'object') {
    const code = errorCode(e);
    if (code && /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT)$/.test(code)) return true;
    if (e instanceof DOMException && e.name === 'TimeoutError') return true;
  }
  return false;
}

export async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeout?: number; retries?: number } = {},
): Promise<Response> {
  const { timeout = 15000, retries = 2, ...fetchOpts } = opts;
  const proxyUrl = getEffectiveProxyUrl();
  const maxRetries = proxyUrl ? Math.max(retries, 3) : retries;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const dispatcher = getProxyDispatcher(attempt > 0 && !!proxyUrl);
      if (dispatcher) {
        const undiciOpts = {
          ...(fetchOpts as Parameters<typeof undiciFetch>[1]),
          signal: AbortSignal.timeout(timeout),
          dispatcher,
        };
        return await undiciFetch(url, undiciOpts) as unknown as Response;
      }
      return await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      lastError = e;
      if (!isNetworkError(e) || attempt >= maxRetries) break;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}
