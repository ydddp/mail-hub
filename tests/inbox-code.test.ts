import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../src/providers/base.js';
import { registry } from '../src/providers/registry.js';
import { app, authHeaders } from './helpers/http.js';
import { MessageNotFoundError, UpstreamHttpError } from '../src/errors.js';
import { MESSAGE_RECIPIENTS } from '../src/providers/base.js';
import { rateLimiter } from '../src/rate-limiter.js';

class CodeTestProvider extends BaseProvider {
  meta: ProviderMeta = {
    name: 'code-test',
    displayName: 'Code Test Mail',
    type: 'api',
    tier: 'free',
    trustLevel: 5,
    rateLimit: { createPerMinute: 10, pollPerMinute: 10 },
    retention: 'test',
    features: {
      customUsername: true,
      pollInbox: true,
      realtime: false,
      attachments: false,
    },
  };

  constructor(
    private readonly messages: Message[],
    private readonly details: Record<string, MessageDetail>,
  ) {
    super();
  }

  async getDomains(): Promise<string[]> {
    return ['example.test'];
  }

  async createInbox(): Promise<InboxData> {
    return {
      address: 'user@example.test',
      authData: { token: 'test-token' },
      provider: this.meta.name,
      apiBase: 'https://example.test',
    };
  }

  async getMessages(): Promise<Message[]> {
    return this.messages;
  }

  async getMessage(_inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const detail = this.details[messageId];
    if (!detail) throw new Error(`Unknown message ${messageId}`);
    return detail;
  }
}

function insertCodeInbox(id: string): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  ).run(id, 'code-test', 'user@example.test', JSON.stringify({ token: 'test-token' }), 'https://example.test', '2026-06-05T00:00:00.000Z');
}

describe('inbox code extraction', () => {
  // All tenant read surfaces distinguish upstream failures from own authentication failures.
  it.each([401, 403, 429, 503].flatMap(status => ['messages', 'messages/m1', 'code'].map(path => ({ status, path }))))
    ('maps upstream $status on $path without relabeling tenant authentication', async ({ status, path }) => {
    const provider = new CodeTestProvider([], {});
    vi.spyOn(provider, 'getMessages').mockRejectedValue(new UpstreamHttpError('Upstream read failed', status, '29'));
    vi.spyOn(provider, 'getMessage').mockRejectedValue(new UpstreamHttpError('Upstream read failed', status, '29'));
    registry.register(provider);
    insertCodeInbox('read-error');
    const response = await app.request(`/api/inbox/read-error/${path}`, { headers: authHeaders() });
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(response.headers.get('Retry-After')).toBe(status === 429 ? '29' : null);
    expect(await response.json()).toEqual({ error: 'Upstream read failed' });
    expect((await app.request(`/api/inbox/read-error/${path}`)).status).toBe(401);
  });

  // Summary extraction remains available for ordinary detail outages, but never for explicit denial.
  it.each([
    { failure: new UpstreamHttpError('Detail unavailable', 503), status: 200, code: '654321' },
    { failure: new Error('Network unavailable'), status: 200, code: '654321' },
    { failure: new UpstreamHttpError('Detail limited', 429, '31'), status: 429, code: undefined },
    { failure: new MessageNotFoundError(), status: 200, code: undefined },
  ])('retains the documented detail fallback verdict %#', async ({ failure, status, code }) => {
    const provider = new CodeTestProvider([{ id: 'm1', from: '', subject: 'Your code is 654321', excerpt: '', receivedAt: '2026-06-05T00:02:00Z' }], {});
    vi.spyOn(provider, 'getMessage').mockRejectedValue(failure);
    registry.register(provider);
    insertCodeInbox('detail-fallback');
    const response = await app.request('/api/inbox/detail-fallback/code', { headers: authHeaders() });
    expect(response.status).toBe(status);
    expect(response.headers.get('Retry-After')).toBe(status === 429 ? '31' : null);
    const body = await response.json() as { codes?: { value: string }[]; error?: string };
    if (code) expect(body.codes).toContainEqual(expect.objectContaining({ value: code }));
    else if (status === 429) expect(body).toEqual({ error: 'Detail limited' });
    else expect(body.codes).toEqual([]);
  });

  // Cancelled requests must not disclose a code after an awaited detail operation.
  it.each([undefined, new Error('Detail unavailable'), new UpstreamHttpError('Detail limited', 429, '31')])
    ('returns no code when cancelled during detail %#', async failure => {
    const message = { id: 'm1', from: '', subject: 'Your code is 654321', excerpt: '', receivedAt: '2026-06-05T00:02:00Z' };
    const provider = new CodeTestProvider([message], { m1: message });
    const controller = new AbortController();
    vi.spyOn(provider, 'getMessage').mockImplementation(async () => {
      controller.abort();
      if (failure) throw failure;
      return message;
    });
    registry.register(provider);
    insertCodeInbox('detail-abort');
    const response = await app.request('/api/inbox/detail-abort/code', { headers: authHeaders(), signal: controller.signal });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ codes: [], email: null, messageId: null, receivedAt: null });
    expect(response.headers.get('Retry-After')).toBeNull();
  });

  it('returns the selected message id and receivedAt with extracted codes', async () => {
    const receivedAt = '2026-06-05T00:02:00.000Z';
    registry.register(new CodeTestProvider([
      {
        id: 'msg-1',
        from: 'sender@example.test',
        subject: 'Your code is 654321',
        excerpt: '654321',
        receivedAt,
      },
    ], {
      'msg-1': {
        id: 'msg-1',
        from: 'sender@example.test',
        subject: 'Your code is 654321',
        excerpt: '654321',
        receivedAt,
        text: 'Use verification code 654321 to continue.',
      },
    }));
    insertCodeInbox('code-metadata');

    const res = await app.request('/api/inbox/code-metadata/code', { headers: authHeaders() });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      messageId: 'msg-1',
      receivedAt,
      email: {
        from: 'sender@example.test',
        subject: 'Your code is 654321',
      },
      codes: [
        expect.objectContaining({
          type: 'numeric',
          value: '654321',
        }),
      ],
    });
  });

  it.each(['2026-06-05T00:03:00.000Z', '2026-06-05T00:03:00', '2026-06-05 09:03:00+09:00'])
    ('does not return the same latest message again when since %s equals its receivedAt', async (since) => {
    const receivedAt = '2026-06-05T00:03:00.000Z';
    registry.register(new CodeTestProvider([
      {
        id: 'msg-repeat',
        from: 'sender@example.test',
        subject: 'Your code is 111222',
        excerpt: '111222',
        receivedAt,
      },
    ], {
      'msg-repeat': {
        id: 'msg-repeat',
        from: 'sender@example.test',
        subject: 'Your code is 111222',
        excerpt: '111222',
        receivedAt,
        text: 'Use verification code 111222.',
      },
    }));
    insertCodeInbox('code-since-repeat');

    const res = await app.request(`/api/inbox/code-since-repeat/code?since=${encodeURIComponent(since)}`, { headers: authHeaders() });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      codes: [],
      email: null,
      messageId: null,
      receivedAt: null,
    });
  });

  it.each(['not-a-date', '2026-06-05', '2026-02-30T00:00:00Z'])('rejects invalid since %s', async (since) => {
    registry.register(new CodeTestProvider([], {}));
    insertCodeInbox('code-invalid-since');

    const res = await app.request(`/api/inbox/code-invalid-since/code?since=${encodeURIComponent(since)}`, { headers: authHeaders() });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid since parameter' });
  });

  it('selects the newest absolute instant across mixed offsets and returns UTC', async () => {
    const messages = [
      {id:'older', receivedAt:'2026-06-05T10:00:00+09:00'},
      {id:'newer', receivedAt:'2026-06-05T02:00:00Z'},
    ].map(m => ({...m, from:'sender@example.test',subject:'Code 654321',excerpt:'654321'}));
    registry.register(new CodeTestProvider(messages, Object.fromEntries(messages.map(m => [m.id,{...m,text:'Code 654321'}]))));
    insertCodeInbox('code-offsets');
    const res = await app.request('/api/inbox/code-offsets/code', {headers:authHeaders()});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({messageId:'newer',receivedAt:'2026-06-05T02:00:00.000Z'});
  });
});

// Matching is an opt-in Outlook contract; legacy latest keeps its summary fallback.
describe('Outlook matching code selection', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function mail(id: string, text = 'Ordinary notification', second = 3): MessageDetail {
    return { id, from: 'sender@example.test', subject: text, text, excerpt: '', receivedAt: `2026-06-05T00:02:0${second}Z` };
  }

  function seed(messages: MessageDetail[], alias = false, limit = 30) {
    const provider = new CodeTestProvider(messages, Object.fromEntries(messages.map(message => [message.id, message])));
    provider.meta.name = 'outlook';
    provider.meta.rateLimit.pollPerMinute = limit;
    registry.register(provider);
    insertCodeInbox('matching');
    getDb().prepare(`UPDATE inboxes SET provider = 'outlook', address = ?, auth_data = ?, expires_at = '2099-01-01 00:00:00' WHERE id = 'matching'`)
      .run(alias ? 'user+current@outlook.com' : 'user@outlook.com', JSON.stringify({ email: 'user@outlook.com' }));
    getDb().prepare(`INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id) VALUES ('user@outlook.com', 'pw', 'cid', 'rt', 'matching')`).run();
    return provider;
  }

  function request(query = 'selection=matching') {
    return app.request(`/api/inbox/matching/code?${query}`, { headers: authHeaders() });
  }

  // IDs are subtraction only: they cannot become a detail-read target or loosen since.
  it.each([
    { query: 'selection=matching&excludeMessageId=A', expected: 'B' },
    { query: 'selection=matching&excludeMessageId=A&excludeMessageId=A', expected: 'B' },
    { query: 'selection=latest&excludeMessageId=A', expected: 'B' },
    { query: 'selection=matching&excludeMessageId=other-owner-id', expected: 'A' },
    { query: 'selection=matching&excludeMessageId=A&since=2026-06-05T00:02:02Z', expected: 'B' },
    { query: 'selection=matching&excludeMessageId=A&since=2026-06-05T00:02:03Z', expected: null },
  ])('subtracts IDs without losing equal-time codes: $query', async ({ query, expected }) => {
    const provider = seed([mail('A', 'Code 123456'), mail('B', 'Code 654321')]);
    const details = vi.spyOn(provider, 'getMessage');
    const response = await request(query);
    expect(response.status).toBe(200);
    expect((await response.json()).messageId).toBe(expected);
    expect(details.mock.calls.map(call => call[1])).toEqual(expected ? [expected] : []);
  });

  it.each([
    { ids: Array(20).fill('A'), status: 200 },
    { ids: Array(21).fill('A'), status: 400 },
    { ids: ['x'.repeat(2048)], status: 200 },
    { ids: ['x'.repeat(2049)], status: 400 },
    { ids: Array(4).fill('x'.repeat(2048)), status: 200 },
    { ids: [...Array(4).fill('x'.repeat(2048)), 'y'], status: 400 },
    { ids: ['界'.repeat(2048), '界'.repeat(682), 'xx'], status: 200 },
    { ids: ['界'.repeat(2048), '界'.repeat(682), 'xxx'], status: 400 },
  ])('enforces exclusion count, per-ID characters and total UTF-8 bytes %#', async ({ ids, status }) => {
    const provider = seed([]);
    const lists = vi.spyOn(provider, 'getMessages');
    const query = new URLSearchParams({ selection: 'matching' });
    ids.forEach(id => query.append('excludeMessageId', id));
    const response = await request(query.toString());
    expect(response.status).toBe(status);
    if (status === 400) {
      expect(await response.json()).toEqual({ error: 'Invalid excludeMessageId parameter' });
      expect(lists).not.toHaveBeenCalled();
    }
  });

  it.each([
    { query: '', id: 'notice', checked: undefined, complete: undefined },
    { query: 'selection=latest', id: 'notice', checked: undefined, complete: undefined },
    { query: 'selection=matching', id: 'code', checked: 2, complete: true },
    { query: 'selection=matching&type=numeric', id: 'code', checked: 2, complete: true },
  ])('selects the documented candidate for $query', async ({ query, id, checked, complete }) => {
    const provider = seed([mail('code', 'Your code is 654321', 2), mail('notice')]);
    const details = vi.spyOn(provider, 'getMessage');
    const response = await request(query);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messageId).toBe(id);
    expect(details).toHaveBeenCalledTimes(checked ?? 1);
    if (checked) expect(body.scan).toEqual({ checked, complete, reason: 'matched' });
    else expect(body).not.toHaveProperty('scan');
  });

  it.each([
    { type: 'numeric', text: 'Your code is 654321', value: '654321' },
    { type: 'alphanumeric', text: 'Your verification code is AB12CD', value: 'AB12CD' },
    { type: 'link', text: 'Verify: https://example.test/verify?token=abc', value: 'https://example.test/verify?token=abc' },
  ])('finds $type without changing the extractor', async ({ type, text, value }) => {
    seed([
      { ...mail('older', text, 2), ...(type === 'link' ? { html: '<a href="https://example.test/verify?token=abc">Verify</a>' } : {}) },
      { ...mail('newest', type === 'link' ? 'Your code is 123456' : 'Verify your account'),
        ...(type !== 'link' ? { html: '<a href="https://example.test/verify?token=new">Verify</a>' } : {}) },
    ]);
    const response = await request(`selection=matching&type=${type}`);
    expect(await response.json()).toMatchObject({ messageId: 'older', codes: [expect.objectContaining({ type, value })] });
  });

  it.each([
    { messages: [mail('z', 'Your code is 654321'), mail('A', 'Your code is 123456')], id: 'A', complete: false },
    { messages: [mail('only', 'Your code is 123456')], id: 'only', complete: true },
  ])('reports only the visited candidate window and stable code-unit ties %#', async ({ messages, id, complete }) => {
    seed(messages);
    expect(await (await request()).json()).toMatchObject({ messageId: id, scan: { checked: 1, complete, reason: 'matched' } });
  });

  it.each([false, true])('returns a bounded no-match result with wait=%s', async wait => {
    vi.useFakeTimers();
    const provider = seed([mail('notice')]);
    const details = vi.spyOn(provider, 'getMessage');
    const pending = request(`selection=matching&wait=${wait}&timeout=4`);
    await vi.advanceTimersByTimeAsync(4000);
    const response = await pending;
    expect(await response.json()).toEqual({ codes: [], email: null, messageId: null, receivedAt: null,
      scan: { checked: 1, complete: true, reason: wait ? 'timeout' : 'window_exhausted' } });
    expect(details).toHaveBeenCalledTimes(1);
  });

  it('stops before the sixth candidate and never claims that window is exhausted', async () => {
    const provider = seed(Array.from({ length: 6 }, (_, index) => mail(String(index), index === 5 ? 'Code 654321' : 'Notification', 8 - index)));
    const details = vi.spyOn(provider, 'getMessage');
    expect(await (await request()).json()).toMatchObject({ codes: [], scan: { checked: 5, complete: false, reason: 'scan_limit' } });
    expect(details).toHaveBeenCalledTimes(5);
  });

  it('waits for a code across growing notification windows without rereading checked IDs', async () => {
    vi.useFakeTimers();
    const provider = seed([]);
    const first = mail('first'); const second = mail('second', 'Notification', 4); const code = mail('code', 'Code 654321', 5);
    vi.spyOn(provider, 'getMessages').mockResolvedValueOnce([first]).mockResolvedValueOnce([second, first]).mockResolvedValue([code, second, first]);
    const details = vi.spyOn(provider, 'getMessage').mockImplementation(async (_inbox, id) => [first, second, code].find(message => message.id === id)!);
    const pending = request('selection=matching&wait=true&timeout=10');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await (await pending).json()).toMatchObject({ messageId: 'code', scan: { checked: 3, complete: true, reason: 'matched' } });
    expect(details.mock.calls.map(call => call[1])).toEqual(['first', 'second', 'code']);
  });

  it.each(['list', 'detail'])('honors the deadline including the awaited %s', async stage => {
    vi.useFakeTimers();
    const code = mail('code', 'Code 654321');
    const provider = seed([code]);
    const details = vi.spyOn(provider, 'getMessage');
    vi.spyOn(provider, stage === 'list' ? 'getMessages' : 'getMessage').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return stage === 'list' ? [code] : code;
    });
    const pending = request('selection=matching&timeout=1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await (await pending).json()).toMatchObject({ codes: [], scan: { reason: 'timeout', complete: false } });
    if (stage === 'list') expect(details).not.toHaveBeenCalled();
  });

  it.each(['list', 'detail'].flatMap(stage => ['close', 'reassign', 'owner', 'address'].map(mutation => ({ stage, mutation }))))
    ('rechecks isolation after $stage await during $mutation', async ({ stage, mutation }) => {
    const code = mail('code', 'Code 654321');
    const provider = seed([code]);
    const mutate = () => {
      if (mutation === 'close') getDb().prepare(`UPDATE inboxes SET status = 'closed', closed_at = datetime('now') WHERE id = 'matching'`).run();
      if (mutation === 'reassign') getDb().prepare(`UPDATE outlook_accounts SET assigned_inbox_id = 'another-inbox'`).run();
      if (mutation === 'owner') getDb().prepare(`UPDATE inboxes SET owner_key = 'another-owner' WHERE id = 'matching'`).run();
      if (mutation === 'address') getDb().prepare(`UPDATE inboxes SET address = 'user+changed@outlook.com' WHERE id = 'matching'`).run();
    };
    if (stage === 'list') vi.spyOn(provider, 'getMessages').mockImplementation(async () => { mutate(); return [code]; });
    else vi.spyOn(provider, 'getMessage').mockImplementation(async () => { mutate(); return code; });
    const response = await request();
    expect([200, 404]).toContain(response.status);
    const body = await response.json();
    expect(body.codes ?? []).toEqual([]);
    expect(body.messageId ?? null).toBeNull();
  });

  it.each([429, 503].flatMap(status => ['list', 'detail'].map(stage => ({ status, stage }))))
    ('stops on $stage $status without summary fallback or older-code masking', async ({ status, stage }) => {
    const provider = seed([mail('newest', 'Code 654321'), mail('older', 'Code 123456', 2)]);
    const details = vi.spyOn(provider, 'getMessage');
    vi.spyOn(provider, stage === 'list' ? 'getMessages' : 'getMessage').mockRejectedValue(new UpstreamHttpError('Mailbox unavailable', status, '23'));
    const response = await request();
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(await response.json()).toEqual({ error: 'Mailbox unavailable' });
    expect(response.headers.get('Retry-After')).toBe(status === 429 ? '23' : null);
    expect(details).toHaveBeenCalledTimes(stage === 'list' ? 0 : 1);
  });

  it('charges each candidate detail against the shared R10 budget', async () => {
    const provider = seed([mail('newest'), mail('older', 'Code 123456', 2)], false, 2);
    const details = vi.spyOn(provider, 'getMessage');
    const response = await request();
    expect(response.status).toBe(429);
    expect(details).toHaveBeenCalledTimes(1);
    expect(rateLimiter.getPollStatus('outlook').currentCount).toBe(2);
  });

  it.each(['list', 'detail'])('keeps alias recipient evidence scoped on %s', async stage => {
    const code = mail('code', 'Code 654321');
    code[MESSAGE_RECIPIENTS] = ['user+previous@outlook.com'];
    const provider = seed(stage === 'list' ? [code] : [{ ...code, [MESSAGE_RECIPIENTS]: ['user+current@outlook.com'] }], true);
    if (stage === 'detail') vi.spyOn(provider, 'getMessage').mockResolvedValue(code);
    expect((await (await request()).json()).codes).toEqual([]);
  });

  it.each([true, false])('reports only confirmed recipient evidence (known=%s)', async known => {
    const code = mail('code', 'Code 654321');
    if (known) code[MESSAGE_RECIPIENTS] = ['user@outlook.com'];
    seed([code]);
    expect(await (await request()).json()).toMatchObject({ email: { recipientAddress: known ? 'user@outlook.com' : null } });
  });

  it('retains the strict since lower bound in matching mode', async () => {
    const provider = seed([mail('same', 'Code 654321')]);
    const details = vi.spyOn(provider, 'getMessage');
    expect(await (await request('selection=matching&since=2026-06-05T00:02:03Z')).json()).toMatchObject({ codes: [], scan: { checked: 0, complete: true, reason: 'window_exhausted' } });
    expect(details).not.toHaveBeenCalled();
  });

  it.each(['selection=other', 'selection=', 'selection=matching&type=other', 'selection=matching&type=',
    'timeout=oops', 'timeout=0', 'timeout=-1', 'timeout=1.5', 'timeout=3tail', 'timeout='])
    ('rejects invalid arguments %s before upstream work', async query => {
    const provider = seed([]); const lists = vi.spyOn(provider, 'getMessages');
    expect((await request(query)).status).toBe(400);
    expect(lists).not.toHaveBeenCalled();
  });

  it('rejects matching for non-Outlook with a clear error', async () => {
    registry.register(new CodeTestProvider([], {})); insertCodeInbox('matching');
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Matching selection is only supported for Outlook' });
  });
});
