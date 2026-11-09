import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../src/db.js';
import { fetchWithTimeout } from '../src/utils.js';

const proxy = vi.hoisted(() => ({ fetch: vi.fn(), agent: vi.fn() }));
vi.mock('undici', () => ({
  fetch: proxy.fetch,
  ProxyAgent: class { constructor(url: string) { proxy.agent(url); } },
}));

// The public options contract is exercised before retryMode exists in source.
type RetryOptions = RequestInit & { timeout?: number; retries?: number; retryMode?: 'safe' | 'never' };
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
  afterEach(() => {
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
});
