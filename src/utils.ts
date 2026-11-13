import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { getSetting } from './db.js';
import { config } from './config.js';
import { errorCode } from './errors.js';
import { abortable, budgetSignal, currentReadBudget, readDelay } from './read-budget.js';
import { classifyTransportFailure, httpTraces, setHttpPhase, type HttpOperation, type HttpTrace } from './http-diagnostics.js';
import { createLogger } from './logger.js';
import { randomUUID } from 'node:crypto';

function getEffectiveProxyUrl(): string {
  return getSetting('proxy_url') || config.proxyUrl;
}

let cachedProxyUrl = '';
interface AgentLease { dispatcher: Dispatcher; active: number; retired: boolean; closing: boolean }
let cachedDispatcher: AgentLease | undefined;
const log = createLogger('http');
function closeRetired(agent: AgentLease) {
  if (!agent.retired || agent.active || agent.closing) return;
  agent.closing = true;
  void agent.dispatcher.close().catch(error => log.warn('retired transport close failed', { error }));
}
function retireDispatcher() {
  if (cachedDispatcher) { cachedDispatcher.retired = true; closeRetired(cachedDispatcher); }
  cachedDispatcher = undefined;
}

export function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function formatSender(from: { name?: string; address?: string }): string {
  return from.name ? `${from.name} <${from.address}>` : (from.address || '');
}

// UTC calendar day for all daily counters; deliberately independent of display timezone.
export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getProxyDispatcher(failed?: AgentLease): AgentLease | undefined {
  const proxyUrl = getEffectiveProxyUrl();
  if (!proxyUrl) {
    cachedProxyUrl = '';
    retireDispatcher();
    return undefined;
  }
  if (!cachedDispatcher || proxyUrl !== cachedProxyUrl || (failed && failed === cachedDispatcher)) {
    retireDispatcher();
    cachedProxyUrl = proxyUrl;
    cachedDispatcher = { dispatcher: new ProxyAgent(proxyUrl), active: 0, retired: false, closing: false };
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

export async function runConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeout?: number; deadline?: number; retries?: number; retryMode?: 'safe' | 'never'; diagnostic?: HttpOperation } = {},
): Promise<Response> {
  const { timeout = 15000, deadline, signal: callerSignal, retries = 2, retryMode, diagnostic, ...fetchOpts } = opts;
  const total = budgetSignal({ deadline, signal: callerSignal ?? undefined });
  const requestId = currentReadBudget()?.requestId;
  const operationId = randomUUID();
  const method = (fetchOpts.method ?? 'GET').toUpperCase();
  // A disconnect can happen after the server committed a write. Only reads
  // retry by default; callers may opt in after verifying idempotent semantics.
  const mayRetry = retryMode !== 'never' && (retryMode === 'safe' || method === 'GET' || method === 'HEAD');
  const maxRetries = mayRetry && Number.isFinite(retries)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(retries)))
    : 0;
  let lastError: unknown;
  let handedOff = false;
  let failedAgent: AgentLease | undefined;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      total.signal.throwIfAborted();
      const started = Date.now();
      const budget = budgetSignal({ signal: total.signal, deadline: Math.min(total.deadline, Date.now() + timeout) });
      const trace: HttpTrace = { phase: 'connect', active: true, phaseStartedAt: started };
      let agent: AgentLease | undefined;
      let response: Response | undefined;
      let released = false;
      const release = () => {
        if (released) return;
        released = true; trace.active = false; budget.dispose();
        if (agent) { agent.active--; closeRetired(agent); }
      };
      const report = (error?: unknown) => {
        if (!diagnostic) return;
        if (error) classifyTransportFailure(error, trace);
        log[error || (response && !response.ok) ? 'warn' : 'info']('upstream attempt', {
          requestId, operationId, operation: diagnostic,
          attempt: attempt + 1, durationMs: Date.now() - started, transport: agent ? 'proxy' : 'direct',
          phase: trace.phase, phaseDurationMs: Date.now() - trace.phaseStartedAt, connectStatus: trace.connectStatus, status: response?.status,
          upstreamRequestId: response?.headers.get('request-id'), ...(error ? { error } : {}),
        });
      };
      try {
        agent = getProxyDispatcher(failedAgent);
        if (agent) agent.active++;
        response = await httpTraces.run(trace, () => abortable(budget.signal, async () => {
          if (agent) {
            const undiciOpts = {
              ...(fetchOpts as Parameters<typeof undiciFetch>[1]),
              signal: budget.signal,
              dispatcher: agent.dispatcher,
            };
            return await undiciFetch(url, undiciOpts) as unknown as Response;
          }
          return await fetch(url, { ...fetchOpts, signal: budget.signal });
        }));
        setHttpPhase(trace, 'response_headers');
        if (!response.body) { report(); release(); return response; }
        // Keep the original Response (including url/redirected and body methods).
        // Header-only callers are cleaned up on cancellation/attempt expiry too.
        const finish = (error?: unknown) => {
          if (released) return;
          budget.signal.removeEventListener('abort', onAbort);
          report(error); release(); total.dispose();
        };
        const onAbort = () => {
          if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
          finish(budget.signal.reason);
        };
        budget.signal.addEventListener('abort', onAbort, { once: true });
        for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
          const consume = response[method].bind(response);
          Object.defineProperty(response, method, { configurable: true, value: async () => {
            setHttpPhase(trace, 'body');
            try { const result = await abortable(budget.signal, consume); finish(); return result; }
            catch (error) { finish(error); throw error; }
          } });
        }
        const cancel = response.body.cancel.bind(response.body);
        Object.defineProperty(response.body, 'cancel', { configurable: true, value: async (reason?: unknown) => {
          try { await cancel(reason); } finally { finish(); }
        } });
        handedOff = true;
        return response;
      } catch (e) {
        report(e);
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        release();
        lastError = e;
        total.signal.throwIfAborted();
        if (!isNetworkError(e) || attempt >= maxRetries) break;
        failedAgent = agent;
        await readDelay(800 * (attempt + 1), total.signal);
      }
    }
    throw lastError;
  } finally { if (!handedOff) total.dispose(); }
}
