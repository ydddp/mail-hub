import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

export type HttpOperation = 'oauth' | 'inbox' | 'junk' | 'detail' | 'token_check';
export interface HttpTrace {
  phase: 'connect' | 'proxy_connect' | 'tls' | 'response_headers' | 'body';
  connectStatus?: number;
  active: boolean;
  phaseStartedAt: number;
}
export function setHttpPhase(trace: HttpTrace, phase: HttpTrace['phase']) {
  if (trace.phase !== phase) { trace.phase = phase; trace.phaseStartedAt = Date.now(); }
}
export const httpTraces = new AsyncLocalStorage<HttpTrace>();
const requests = new WeakMap<object, HttpTrace>();
// Bind events to their own request at creation. Never use a global "current"
// request: late events from an aborted socket can belong to a different read.
channel('undici:request:create').subscribe((event: unknown) => {
  const { request } = event as { request: { method: string } };
  const trace = httpTraces.getStore();
  if (trace?.active) {
    requests.set(request, trace);
    if (request.method === 'CONNECT') setHttpPhase(trace, 'proxy_connect');
  }
});
channel('undici:client:sendHeaders').subscribe((event: unknown) => {
  const { request } = event as { request: { method: string } };
  const trace = requests.get(request);
  if (trace?.active && request.method !== 'CONNECT') setHttpPhase(trace, 'response_headers');
});
channel('undici:request:headers').subscribe((event: unknown) => {
  const { request, response } = event as { request: { method: string }; response: { statusCode: number } };
  const trace = requests.get(request);
  if (trace?.active && request.method === 'CONNECT') {
    trace.connectStatus = response.statusCode;
    setHttpPhase(trace, response.statusCode === 200 ? 'tls' : 'proxy_connect');
  }
});
channel('undici:proxy:connected').subscribe(() => {
  const trace = httpTraces.getStore();
  if (trace?.active) { trace.connectStatus = 200; setHttpPhase(trace, 'tls'); }
});

export function classifyTransportFailure(error: unknown, trace: HttpTrace): void {
  const seen = new Set<object>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current) && seen.size < 6;) {
    seen.add(current);
    const fields = Object.getOwnPropertyDescriptors(current);
    const code = fields.code?.value;
    if (typeof code === 'string' && /^(ERR_TLS_|CERT_|DEPTH_ZERO_|UND_ERR_PRX_TLS)/.test(code)) trace.phase = 'tls';
    // Undici reports a rejected tunnel only in this fixed-format message.
    // Extract the numeric status; never retain or log the message itself.
    const message = fields.message?.value;
    const match = typeof message === 'string' && /^Proxy response \(([1-5]\d\d)\) !== 200 when HTTP Tunneling$/.exec(message);
    if (match) { trace.connectStatus = Number(match[1]); trace.phase = 'proxy_connect'; }
    current = fields.cause?.value;
  }
}
