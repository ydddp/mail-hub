import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../src/db.js';
import { fetchWithTimeout } from '../src/utils.js';

const proxy = vi.hoisted(() => ({ fetch: vi.fn(), agent: vi.fn(), closed: vi.fn() }));
vi.mock('undici', () => ({
  fetch: proxy.fetch,
  ProxyAgent: class { constructor(url: string) { proxy.agent(url); } async close() { proxy.closed(this); } },
}));

// The public options contract is exercised before retryMode exists in source.
type RetryOptions = RequestInit & { timeout?: number; deadline?: number; retries?: number; retryMode?: 'safe' | 'never' };
const request = (opts: RetryOptions) => fetchWithTimeout('https://upstream.test/operation', opts);

describe.each(['direct', 'proxy'])('HTTP retry safety through %s', (transport) => {
  let upstream: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    proxy.fetch.mockReset();
    proxy.agent.mockClear();
    setSetting('proxy_url', transport === 'proxy' ? 'http://proxy.test:8080' : '');
    upstream = transport === 'proxy' ? proxy.fetch : vi.fn();
    vi.stubGlobal('fetch', transport === 'direct' ? upstream : vi.fn(() => { throw new Error('proxy bypass'); }));
  });
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function settle(opts: RetryOptions) {
    const pending = request(opts).then(value => ({ value }), error => ({ error }));
    await vi.runAllTimersAsync();
    return pending;
  }

  it.each(['POST', 'post', 'PUT', 'PATCH', 'DELETE'])('does not duplicate a remote %s write after the response disconnects', async (method) => {
    let committedWrites = 0;
    const disconnected = new TypeError('response lost after remote commit');
    upstream.mockImplementation(async () => { committedWrites++; throw disconnected; });
    expect(await settle({ method, retries: 4 })).toEqual({ error: disconnected });
    expect(committedWrites).toBe(1);
  });

  it.each([undefined, 'GET', 'get', 'HEAD', 'head'])('bounds read retries for method %s', async (method) => {
    const disconnected = new TypeError('read disconnected');
    upstream.mockRejectedValue(disconnected);
    expect(await settle({ method })).toEqual({ error: disconnected });
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('honors an explicit zero retry budget', async () => {
    const disconnected = new TypeError('read disconnected');
    upstream.mockRejectedValue(disconnected);
    expect(await settle({ retries: 0 })).toEqual({ error: disconnected });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  // Caller cancellation must stop network work, including waits between reads.
  it.each(['before', 'headers', 'backoff', 'body'])('stops cancelled work during %s', async phase => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    let received: AbortSignal | undefined;
    upstream.mockImplementation(async (_url, opts) => {
      received = opts.signal;
      if (phase === 'backoff') throw new TypeError('network unavailable');
      if (phase === 'body') return new Response(new ReadableStream({ start() {} }));
      if (phase === 'before') return new Response('{}');
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    });
    if (phase === 'before') controller.abort(reason);
    const pending = request({ signal: controller.signal }).then(async response => response.text()).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(reason);
    expect(upstream).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
    // A failed attempt is already settled during backoff; only active I/O
    // must see abort. Backoff itself must still stop without another attempt.
    if (received && phase !== 'backoff') expect(received.aborted).toBe(true);
  });

  it.each(['headers', 'backoff', 'body'])('bounds %s with the total deadline', async phase => {
    upstream.mockImplementation(async (_url, opts) => {
      if (phase === 'backoff') throw new TypeError('network unavailable');
      if (phase === 'body') return new Response(new ReadableStream({ start() {} }));
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    });
    const pending = request({ deadline: Date.now() + 100, timeout: 15000 }).then(response => response.text()).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('allows an explicitly verified safe POST to retry within its budget', async () => {
    upstream.mockRejectedValueOnce(new TypeError('read-only query disconnected')).mockResolvedValue(new Response('{}'));
    expect(await settle({ method: 'POST', retryMode: 'safe', retries: 1 })).toHaveProperty('value');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('lets never override a GET retry budget', async () => {
    const disconnected = new TypeError('GET has side effects');
    upstream.mockRejectedValue(disconnected);
    expect(await settle({ method: 'GET', retryMode: 'never', retries: 5 })).toEqual({ error: disconnected });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -Infinity, -1, -0.5])('normalizes invalid retry budget %s to one attempt', async (retries) => {
    const disconnected = new TypeError('read disconnected');
    upstream.mockRejectedValueOnce(disconnected).mockResolvedValue(new Response('{}'));
    expect(await settle({ retries })).toEqual({ error: disconnected });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('rounds fractional retry budgets down', async () => {
    const disconnected = new TypeError('read disconnected');
    upstream.mockRejectedValue(disconnected);
    expect(await settle({ retries: 1.9 })).toEqual({ error: disconnected });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('does not pass operation controls to either fetch implementation', async () => {
    upstream.mockResolvedValue(new Response('{}'));
    await request({ timeout: 1234, retries: 0, retryMode: 'never', headers: { 'X-Test': 'kept' } });
    const options = upstream.mock.calls[0][1];
    expect(options).not.toHaveProperty('timeout');
    expect(options).not.toHaveProperty('retries');
    expect(options).not.toHaveProperty('retryMode');
    expect(options.headers).toEqual({ 'X-Test': 'kept' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a concurrent body usable while retiring a failed proxy connection', async () => {
    if (transport !== 'proxy') return;
    let complete!: () => void;
    upstream.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) {
      complete = () => { controller.enqueue(new TextEncoder().encode('retained')); controller.close(); };
    } })));
    const first = await request({});
    const oldAgent = upstream.mock.calls[0][1].dispatcher;
    upstream.mockRejectedValueOnce(new TypeError('connection reset')).mockResolvedValueOnce(new Response('{}'));
    const retry = request({ retries: 1 });
    await vi.advanceTimersByTimeAsync(801);
    await (await retry).text();
    expect(proxy.closed.mock.calls.some(([agent]) => agent === oldAgent)).toBe(false);
    complete();
    expect(await first.text()).toBe('retained');
    expect(proxy.closed.mock.calls.filter(([agent]) => agent === oldAgent)).toHaveLength(1);
  });

  it('does not strand an unread response when its caller cancels', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    await request({ signal: controller.signal });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
