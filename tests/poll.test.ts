import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { app, authHeaders } from './helpers/http.js';
import { FakeProvider } from './helpers/fake-provider.js';
import type { InboxData, Message, MessageDetail } from '../src/providers/base.js';
import { cleanupExpired } from '../src/app.js';
import { UpstreamHttpError } from '../src/errors.js';
import { hashApiKey } from '../src/crypto.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { TemplateProvider } from '../src/providers/template-provider.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';

function insertFakeInbox(id: string): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  ).run(id, 'fake', 'user@example.test', JSON.stringify({ token: 't' }), 'https://fake.test');
}

describe('poll rate limits', () => {
  // Every tenant read spends the provider's shared budget, including failed
  // details and the detail selected by /code; denials never fall back to mail.
  it.each([
    { name: 'mixed routes across inboxes', limit: 4, paths: ['messages', 'messages/message-1', 'code'], statuses: [200, 200, 200], lists: 2, details: 2 },
    { name: 'repeated direct details', limit: 2, paths: ['messages/message-1', 'messages/message-1'], statuses: [200, 200], lists: 0, details: 2 },
    { name: 'code list plus detail', limit: 2, paths: ['code'], statuses: [200], lists: 1, details: 1 },
    { name: 'code denied before detail', limit: 1, paths: ['code'], statuses: [429], lists: 1, details: 0 },
    { name: 'failed direct detail', limit: 1, paths: ['messages/message-1'], statuses: [502], lists: 0, details: 1, failure: 'detail' },
    { name: 'code summary after ordinary detail failure', limit: 2, paths: ['code'], statuses: [200], lists: 1, details: 1, failure: 'detail' },
    { name: 'failed list', limit: 1, paths: ['messages'], statuses: [502], lists: 1, details: 0, failure: 'list' },
  ])('charges every provider operation for $name', async ({ limit, paths, statuses, lists, details, failure }) => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 10, pollPerMinute: limit } });
    const list = vi.spyOn(provider, 'getMessages');
    const detail = vi.spyOn(provider, 'getMessage');
    if (failure === 'list') list.mockRejectedValue(new Error('List unavailable'));
    if (failure === 'detail') detail.mockRejectedValue(new Error('Detail unavailable'));
    registry.register(provider);
    for (const id of ['budget-a', 'budget-b']) {
      insertFakeInbox(id);
      getDb().prepare(`UPDATE inboxes SET created_at = '2020-01-01 00:00:00' WHERE id = ?`).run(id);
    }

    for (const [index, path] of paths.entries()) {
      const response = await app.request(`/api/inbox/budget-${index % 2 ? 'b' : 'a'}/${path}`, { headers: authHeaders() });
      expect(response.status).toBe(statuses[index]);
      if (path === 'code' && response.status === 200) {
        expect(await response.json()).toMatchObject({ messageId: 'message-1', codes: [expect.objectContaining({ value: '123456' })] });
      }
    }
    expect(rateLimiter.getPollStatus('fake').currentCount).toBe(limit);

    for (const path of ['messages', 'messages/message-1', 'code?wait=true&timeout=10']) {
      const denied = await app.request(`/api/inbox/budget-b/${path}`, { headers: authHeaders() });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toEqual({
        error: "Poll rate limit exceeded for provider 'fake'",
        provider: 'fake',
        retryAfter: expect.any(String),
      });
    }
    expect(list).toHaveBeenCalledTimes(lists);
    expect(detail).toHaveBeenCalledTimes(details);
    expect(rateLimiter.getPollStatus('fake').currentCount).toBe(limit);
  });

  // The charge is for the outer provider operation: a cached detail still
  // spends one read, and a fromList cache miss does not charge its nested list.
  it.each(['cold', 'warm'])('charges fromList %s-cache details once per tenant operation', async cache => {
    const config = structuredClone(BUILTIN_TEMPLATES[0].config);
    config.name = 'budget-template';
    config.apiBase = 'https://example.test';
    config.rateLimit.pollPerMinute = 2;
    config.messages.resultPath = '$root';
    config.messages.itemMapping = { id: 'id', from: 'from', subject: 'subject', excerpt: 'text', receivedAt: 'date', text: 'text' };
    config.messageDetail.fromList = true;
    const fetch = vi.fn(async () => Response.json([{ id: 'message-1', subject: 'Code 123456', text: 'Code 123456', date: new Date().toISOString() }]));
    vi.stubGlobal('fetch', fetch);
    try {
      const provider = new TemplateProvider(config);
      registry.register(provider);
      insertFakeInbox('budget-cache');
      getDb().prepare(`UPDATE inboxes SET provider = ?, created_at = '2020-01-01 00:00:00' WHERE id = 'budget-cache'`).run(config.name);
      const firstPath = cache === 'warm' ? 'messages' : 'messages/message-1';
      expect((await app.request(`/api/inbox/budget-cache/${firstPath}`, { headers: authHeaders() })).status).toBe(200);
      expect(rateLimiter.getPollStatus(config.name).currentCount).toBe(1);
      const cached = await app.request('/api/inbox/budget-cache/messages/message-1', { headers: authHeaders() });
      expect(cached.status).toBe(200);
      expect(await cached.json()).toMatchObject({ id: 'message-1', text: 'Code 123456' });
      expect(rateLimiter.getPollStatus(config.name).currentCount).toBe(2);
      expect((await app.request('/api/inbox/budget-cache/code', { headers: authHeaders() })).status).toBe(429);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns 429 for /messages after the provider poll limit is reached', async () => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 10, pollPerMinute: 2 } });
    registry.register(provider);
    insertFakeInbox('poll-messages');

    expect((await app.request('/api/inbox/poll-messages/messages', { headers: authHeaders() })).status).toBe(200);
    expect((await app.request('/api/inbox/poll-messages/messages', { headers: authHeaders() })).status).toBe(200);
    const limited = await app.request('/api/inbox/poll-messages/messages', { headers: authHeaders() });

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      provider: 'fake',
      retryAfter: expect.any(String),
    });
    expect(provider.messagesCount).toBe(2);
    registry.unregister('fake');
  });

  it('applies the same 429 behavior to /code wait polling', async () => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 10, pollPerMinute: 1 } });
    registry.register(provider);
    insertFakeInbox('poll-code');

    expect((await app.request('/api/inbox/poll-code/code', { headers: authHeaders() })).status).toBe(200);
    const limited = await app.request('/api/inbox/poll-code/code?wait=true&timeout=10', { headers: authHeaders() });

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      provider: 'fake',
      retryAfter: expect.any(String),
    });
    expect(provider.messagesCount).toBe(1);
    registry.unregister('fake');
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class WaitingProvider extends FakeProvider {
  readonly entered = deferred();
  readonly released = deferred();
  detailCalls = 0;

  constructor(private readonly blockCall?: number, private readonly rejectBlockedCall = false, private readonly blockedMessages: Message[] = [], private readonly blockedFailure = new Error('temporary provider error')) {
    super({ rateLimit: { createPerMinute: 60, pollPerMinute: 60 } });
  }

  override async getMessages(): Promise<Message[]> {
    this.messagesCount++;
    if (this.messagesCount === this.blockCall) {
      this.entered.resolve();
      await this.released.promise;
      if (this.rejectBlockedCall) throw this.blockedFailure;
      return this.blockedMessages;
    }
    return [];
  }

  override async getMessage(inbox: InboxData, id: string): Promise<MessageDetail> {
    this.detailCalls++;
    return super.getMessage(inbox, id);
  }
}

afterEach(() => { vi.useRealTimers(); });

type PollEnd = 'close' | 'expiry' | 'delete' | 'abort';

async function endPolling(id: string, end: PollEnd, controller: AbortController): Promise<void> {
  if (end === 'abort') {
    controller.abort();
  } else if (end === 'close') {
    expect((await app.request(`/api/inbox/${id}`, { method: 'DELETE', headers: authHeaders() })).status).toBe(200);
  } else {
    getDb().prepare(`UPDATE inboxes SET expires_at = datetime('now', ?) WHERE id = ?`)
      .run(end === 'delete' ? '-40 days' : '-1 second', id);
    if (end === 'delete') await cleanupExpired();
  }
}

describe('long polling lease end', () => {
  // A deadline reports the last completed poll; a successful [] clears an earlier outage.
  it.each([
    { outcomes: [[], new Error('Earlier failure'), new Error('Latest poll failed')], status: 502 },
    { outcomes: [[], new Error('Earlier failure'), []], status: 200 },
    { outcomes: [[], [], new Error('Latest poll failed')], status: 502 },
  ])('returns the last completed poll outcome %#', async ({ outcomes, status }) => {
    vi.useFakeTimers();
    const provider = new WaitingProvider();
    const poll = vi.spyOn(provider, 'getMessages');
    for (const outcome of outcomes) {
      if (outcome instanceof Error) poll.mockRejectedValueOnce(outcome);
      else poll.mockResolvedValueOnce(outcome);
    }
    registry.register(provider);
    insertFakeInbox('poll-outcomes');
    const pending = app.request('/api/inbox/poll-outcomes/code?wait=true&timeout=7', { headers: authHeaders() });
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    expect(response.status).toBe(status);
    expect(poll).toHaveBeenCalledTimes(3);
    if (status === 502) expect(await response.json()).toEqual({ error: 'Latest poll failed' });
    else expect(await response.json()).toEqual({ codes: [], email: null, messageId: null, receivedAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['upstream', 'local'])('terminates %s 429 during waiting without another outbound read', async kind => {
    vi.useFakeTimers();
    const provider = new WaitingProvider();
    if (kind === 'local') provider.meta.rateLimit.pollPerMinute = 1;
    const poll = vi.spyOn(provider, 'getMessages').mockResolvedValueOnce([])
      .mockRejectedValueOnce(new UpstreamHttpError('Upstream limited', 429, '37'));
    registry.register(provider);
    insertFakeInbox('retry-limited');
    const pending = app.request('/api/inbox/retry-limited/code?wait=true&timeout=10', { headers: authHeaders() });
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
    await vi.advanceTimersByTimeAsync(3000);
    // Advancing once more exposes an unwanted retry while keeping the test bounded.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    expect(response.status).toBe(429);
    expect(poll).toHaveBeenCalledTimes(kind === 'local' ? 1 : 2);
    if (kind === 'upstream') expect(response.headers.get('Retry-After')).toBe('37');
    else expect(await response.json()).toMatchObject({ provider: 'fake', retryAfter: expect.any(String) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not issue a read after sleeping past the deadline', async () => {
    vi.useFakeTimers();
    const provider = new WaitingProvider();
    registry.register(provider);
    insertFakeInbox('poll-deadline');
    const pending = app.request('/api/inbox/poll-deadline/code?wait=true&timeout=1', { headers: authHeaders() });
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).status).toBe(200);
    expect(provider.messagesCount).toBe(1);
    expect(provider.detailCalls).toBe(0);
  });

  // Owner/existence, lease and cancellation guards take precedence over a simultaneous 429.
  it.each([1, 2].flatMap(call => ['close', 'expiry', 'delete', 'abort', 'new owner'].map(end => ({ call, end }))))
    ('prioritizes $end over a throttled pending poll $call', async ({ call, end }) => {
    vi.useFakeTimers();
    const provider = new WaitingProvider(call, true, [], new UpstreamHttpError('Upstream limited', 429, '41'));
    registry.register(provider);
    insertFakeInbox('limited-guard');
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, 'poll owner')`).run(hashApiKey('poll-owner'));
    getDb().prepare(`UPDATE inboxes SET owner_key = ? WHERE id = 'limited-guard'`).run(hashApiKey('poll-owner'));
    const controller = new AbortController();
    const pending = app.request('/api/inbox/limited-guard/code?wait=true&timeout=10', { headers: authHeaders('poll-owner'), signal: controller.signal });
    if (call === 2) {
      await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
      await vi.advanceTimersByTimeAsync(3000);
    }
    await provider.entered.promise;
    if (end === 'new owner') getDb().prepare(`UPDATE inboxes SET owner_key = ? WHERE id = 'limited-guard'`).run(hashApiKey('next-owner'));
    else await endPolling('limited-guard', end as PollEnd, controller);
    provider.released.resolve();
    const response = await pending;
    expect(response.status).toBe(end === 'delete' || end === 'new owner' ? 404 : 200);
    if (response.status === 200) expect(await response.json()).toEqual({ codes: [], email: null, messageId: null, receivedAt: null });
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(provider.messagesCount).toBe(call);
    expect(provider.detailCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<PollEnd>(['close', 'expiry'])('does not start a detail request when a waiting retry returns historical mail after %s', async (end) => {
    vi.useFakeTimers();
    const provider = new WaitingProvider(2, false, [{
      id: 'historical', from: 'sender@test', subject: 'Code 778899', excerpt: '',
      receivedAt: new Date(Date.now() - 60_000).toISOString(),
    }]);
    registry.register(provider);
    insertFakeInbox('retry-historical');
    getDb().prepare(`UPDATE inboxes SET created_at = '2020-01-01 00:00:00' WHERE id = 'retry-historical'`).run();
    const controller = new AbortController();
    const pending = app.request('/api/inbox/retry-historical/code?wait=true&timeout=10', { headers: authHeaders(), signal: controller.signal });
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
    await vi.advanceTimersByTimeAsync(3000);
    await provider.entered.promise;
    await endPolling('retry-historical', end, controller);
    provider.released.resolve();
    await vi.advanceTimersByTimeAsync(15000);

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ codes: [], email: null, messageId: null, receivedAt: null });
    expect(provider.messagesCount).toBe(2);
    expect(provider.detailCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<PollEnd>(['close', 'expiry', 'delete', 'abort'])('stops outbound polling after %s during sleep', async (end) => {
    vi.useFakeTimers();
    const provider = new WaitingProvider();
    registry.register(provider);
    insertFakeInbox('sleep-end');
    const controller = new AbortController();
    const pending = app.request('/api/inbox/sleep-end/code?wait=true&timeout=1', { headers: authHeaders(), signal: controller.signal });
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
    await endPolling('sleep-end', end, controller);
    await vi.advanceTimersByTimeAsync(3000);

    const response = await pending;
    expect(response.status).toBe(end === 'delete' ? 404 : 200);
    expect(provider.messagesCount).toBe(1);
    expect(provider.detailCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { call: 1, failure: false, end: 'close' },
    { call: 1, failure: false, end: 'expiry' },
    { call: 1, failure: false, end: 'delete' },
    { call: 1, failure: false, end: 'abort' },
    { call: 1, failure: true, end: 'close' },
    { call: 1, failure: true, end: 'expiry' },
    { call: 1, failure: true, end: 'delete' },
    { call: 1, failure: true, end: 'abort' },
    { call: 2, failure: false, end: 'close' },
    { call: 2, failure: false, end: 'expiry' },
    { call: 2, failure: false, end: 'delete' },
    { call: 2, failure: false, end: 'abort' },
    { call: 2, failure: true, end: 'close' },
    { call: 2, failure: true, end: 'expiry' },
    { call: 2, failure: true, end: 'delete' },
    { call: 2, failure: true, end: 'abort' },
  ] as const)('stops after $end while provider call $call is pending (failure=$failure)', async ({ call, failure, end }) => {
    vi.useFakeTimers();
    const provider = new WaitingProvider(call, failure);
    registry.register(provider);
    insertFakeInbox('provider-end');
    const controller = new AbortController();
    const pending = app.request('/api/inbox/provider-end/code?wait=true&timeout=10', { headers: authHeaders(), signal: controller.signal });
    if (call === 2) {
      await vi.waitFor(() => { expect(vi.getTimerCount()).toBeGreaterThan(0); });
      await vi.advanceTimersByTimeAsync(3000);
    }
    await provider.entered.promise;
    await endPolling('provider-end', end, controller);
    provider.released.resolve();
    await vi.advanceTimersByTimeAsync(15000);

    const response = await pending;
    expect(response.status).toBe(end === 'delete' ? 404 : 200);
    expect(provider.messagesCount).toBe(call);
    expect(provider.detailCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
