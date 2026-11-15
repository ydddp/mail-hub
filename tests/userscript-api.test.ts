import { describe, expect, it } from 'vitest';
import {
  ApiError,
  RequestAbortedError,
  RequestTimeoutError,
  createApiClient,
  normalizeBaseUrl,
} from '../userscript/src/api.js';
import type { HttpRequest, HttpResponse, HttpSend } from '../userscript/src/gm.js';

const KEY = 'mk_livekey_do_not_leak';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
}

function recorder(reply: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const sent: Sent[] = [];
  const send: HttpSend = async (req) => {
    sent.push({
      method: req.method,
      url: req.url,
      headers: { ...(req.headers ?? {}) },
      body: req.body,
      timeoutMs: req.timeoutMs,
    });
    return await reply(req);
  };
  return { sent, send };
}

function json(status: number, body: unknown, extra: Partial<HttpResponse> = {}): HttpResponse {
  return { status, responseText: JSON.stringify(body), headers: {}, ...extra };
}

function client(send: HttpSend) {
  return createApiClient({ baseUrl: 'https://mail.example.com', apiKey: KEY, send });
}

describe('normalizeBaseUrl', () => {
  it.each([
    ['mail.example.com', 'https://mail.example.com', false],
    ['  https://mail.example.com/  ', 'https://mail.example.com', false],
    ['https://mail.example.com/hub/', 'https://mail.example.com/hub', false],
    // Plain http to this machine never crosses a network, so it is not flagged
    // (2026-11-15: the warning read as nonsense on a local test server).
    ['http://localhost:3000', 'http://localhost:3000', false],
    ['http://127.0.0.1:3199', 'http://127.0.0.1:3199', false],
    ['http://[::1]:3000', 'http://[::1]:3000', false],
    ['http://mail.localhost:8080', 'http://mail.localhost:8080', false],
    // Anything else over http does cross a network: the key would travel in clear.
    ['http://192.168.1.10:8080/mail', 'http://192.168.1.10:8080/mail', true],
    ['http://mail.example.com', 'http://mail.example.com', true],
  ])('%j → %j (insecure=%s)', (input, baseUrl, insecure) => {
    expect(normalizeBaseUrl(input)).toEqual({ ok: true, baseUrl, insecure });
  });

  // A key in the URL is a key in logs, history and Referer. Refuse the whole
  // configuration instead of quietly stripping the secret.
  it.each([
    ['https://user:pw@mail.example.com', 'credentials'],
    ['https://user@mail.example.com', 'credentials'],
    ['https://mail.example.com/?key=abc', 'query'],
    ['https://mail.example.com/#frag', 'hash'],
    ['ftp://mail.example.com', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['', 'empty'],
    ['   ', 'empty'],
  ])('refuses %j with reason %s', (input, reason) => {
    expect(normalizeBaseUrl(input)).toMatchObject({ ok: false, reason });
  });
});

describe('request boundary', () => {
  it('creates an inbox with the normalized service and no provider in auto mode', async () => {
    const { sent, send } = recorder(() => json(201, {
      id: 'inbox-1', address: 'alpha@mailtm.example', provider: 'mailtm',
      expiresAt: '2026-11-14T00:00:00.000Z', features: { pollInbox: true },
    }));

    const created = await client(send).createInbox({ service: 'Discord.com', provider: null });

    expect(created).toMatchObject({ id: 'inbox-1', provider: 'mailtm' });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe('https://mail.example.com/api/inbox');
    expect(JSON.parse(sent[0].body!)).toEqual({ for: 'discord.com', needPolling: true });
  });

  it('sends the provider only when one was chosen explicitly', async () => {
    const { sent, send } = recorder(() => json(201, {
      id: 'inbox-2', address: 'beta@mailgw.example', provider: 'mailgw',
      expiresAt: null, features: { pollInbox: true },
    }));

    await client(send).createInbox({ service: 'discord.com', provider: 'mailgw' });

    expect(JSON.parse(sent[0].body!)).toEqual({ for: 'discord.com', needPolling: true, provider: 'mailgw' });
  });

  it('keeps the bearer token out of the URL and out of every query string', async () => {
    const { sent, send } = recorder(() => json(200, { providers: [] }));

    await client(send).listProviders();

    for (const request of sent) {
      expect(request.url).not.toContain(KEY);
      expect(request.url).not.toContain('mk_');
      expect(request.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('only ever talks to the configured origin', async () => {
    const { sent, send } = recorder(() => json(200, { codes: [], email: null, messageId: null, receivedAt: null }));

    await client(send).waitForCode({ inboxId: 'inbox-1', timeoutSeconds: 20, exclude: [] });

    expect(new URL(sent[0].url).origin).toBe('https://mail.example.com');
  });

  it('encodes opaque inbox ids instead of letting them alter the path', async () => {
    const { sent, send } = recorder(() => json(200, { ok: true }));

    await client(send).closeInbox('a/b c?d');

    expect(sent[0].method).toBe('DELETE');
    expect(sent[0].url).toBe('https://mail.example.com/api/inbox/a%2Fb%20c%3Fd');
  });
});

describe('code polling', () => {
  it('asks for a single long poll with the exclusions it was given', async () => {
    const { sent, send } = recorder(() => json(200, {
      codes: [{ type: 'numeric', value: '482913', confidence: 0.9, context: 'code' }],
      email: { from: 'no-reply@discord.com', subject: 'Your code' },
      messageId: 'm-1', receivedAt: '2026-11-13T10:00:00.000Z',
    }));

    const result = await client(send).waitForCode({
      inboxId: 'inbox-1', timeoutSeconds: 20, exclude: ['m-0', 'm-00'],
    });

    expect(result.codes[0].value).toBe('482913');
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0].url);
    expect(url.pathname).toBe('/api/inbox/inbox-1/code');
    expect(url.searchParams.get('wait')).toBe('true');
    expect(url.searchParams.get('timeout')).toBe('20');
    expect(url.searchParams.getAll('excludeMessageId')).toEqual(['m-0', 'm-00']);
  });

  it('refuses to overflow the server-side exclusion limit before sending', async () => {
    const { sent, send } = recorder(() => json(200, {}));
    const exclude = Array.from({ length: 21 }, (_, i) => `m-${i}`);

    await expect(client(send).waitForCode({ inboxId: 'inbox-1', timeoutSeconds: 20, exclude }))
      .rejects.toMatchObject({ kind: 'invalid' });
    expect(sent).toHaveLength(0);
  });

  it('treats an empty result as "no mail yet", not as a failure', async () => {
    const { send } = recorder(() => json(200, { codes: [], email: null, messageId: null, receivedAt: null }));

    const result = await client(send).waitForCode({ inboxId: 'inbox-1', timeoutSeconds: 20, exclude: [] });

    expect(result).toEqual({ codes: [], email: null, messageId: null, receivedAt: null });
  });
});

describe('messages', () => {
  it('lists messages and keeps opaque ids encoded', async () => {
    const { sent, send } = recorder(() => json(200, {
      messages: [{
        id: 'm/1', from: 'no-reply@discord.com', subject: '验证你的邮箱',
        excerpt: '你的验证码是 482913', receivedAt: '2026-11-13T10:00:00.000Z',
      }],
      status: 'active', address: 'alpha@mailtm.example', provider: 'mailtm',
    }));

    const messages = await client(send).listMessages('inbox-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm/1', subject: '验证你的邮箱' });
    expect(sent[0].url).toBe('https://mail.example.com/api/inbox/inbox-1/messages');
  });

  it('reads one message without letting its id change the path', async () => {
    const { sent, send } = recorder(() => json(200, {
      id: 'm/1', from: 'no-reply@discord.com', subject: '验证你的邮箱',
      excerpt: '你的验证码是 482913', receivedAt: '2026-11-13T10:00:00.000Z',
      text: '你的验证码是 482913', html: '<p>你的验证码是 482913</p>',
    }));

    const detail = await client(send).getMessage('inbox-1', 'm/1');

    expect(detail).toMatchObject({ id: 'm/1', text: '你的验证码是 482913' });
    expect(sent[0].url).toBe('https://mail.example.com/api/inbox/inbox-1/messages/m%2F1');
  });
});

describe('inbox status mapping', () => {
  // The inbox routes hand back database columns verbatim (`target_service`,
  // `created_at`, `expires_at`) unlike the camelCase create result. Reading the
  // wrong spelling degrades silently to null, so pin it.
  it('reads the snake_case fields the status routes actually return', async () => {
    const { send } = recorder((req) => req.url.includes('/api/inboxes')
      ? json(200, {
        inboxes: [{
          id: 'inbox-2', address: 'c@d.example', provider: 'mailgw', target_service: 'discord.com',
          status: 'active', created_at: '2026-11-13T00:00:00.000Z', expires_at: '2026-11-14T00:00:00.000Z',
        }],
        page: 1, pageSize: 50, total: 1,
      })
      : json(200, {
        id: 'inbox-1', address: 'a@b.example', provider: 'mailtm', target_service: 'discord.com',
        owner_key: 'hash', status: 'active', created_at: '2026-11-13T00:00:00.000Z',
        expires_at: '2026-11-14T00:00:00.000Z',
      }));

    const status = await client(send).getInbox('inbox-1');
    expect(status).toEqual({
      id: 'inbox-1', address: 'a@b.example', provider: 'mailtm', service: 'discord.com',
      status: 'active', expiresAt: '2026-11-14T00:00:00.000Z',
    });

    const [row] = await client(send).findInboxes('discord.com');
    expect(row).toMatchObject({
      service: 'discord.com', status: 'active',
      createdAt: '2026-11-13T00:00:00.000Z', expiresAt: '2026-11-14T00:00:00.000Z',
    });
  });
});

describe('failure classification', () => {
  it.each([
    [401, { error: 'Unauthorized' }, 'unauthorized'],
    [403, { error: 'Admin access required' }, 'forbidden'],
    [404, { error: 'Inbox not found' }, 'not-found'],
    [429, { error: 'Daily quota exceeded' }, 'quota'],
    [502, { error: 'upstream exploded' }, 'upstream'],
    [503, { error: 'no provider available' }, 'upstream'],
    [400, { error: 'Missing required field: for' }, 'invalid'],
    [500, { error: 'Provider not available' }, 'upstream'],
  ])('maps HTTP %i to %s', async (status, body, kind) => {
    const { send } = recorder(() => json(status as number, body));

    await expect(client(send).createInbox({ service: 'discord.com', provider: null }))
      .rejects.toMatchObject({ kind, status });
  });

  it('keeps the upstream retry hint on a poll rate limit', async () => {
    const { send } = recorder(() => json(429, { error: 'Poll rate limit exceeded', provider: 'mailtm' }, {
      headers: { 'retry-after': '2026-11-13T10:01:00.000Z' },
    }));

    const error = await client(send).waitForCode({ inboxId: 'inbox-1', timeoutSeconds: 20, exclude: [] })
      .catch((e: ApiError) => e);

    expect(error).toMatchObject({ kind: 'quota', retryAfter: '2026-11-13T10:01:00.000Z' });
  });

  it('does not read "no route" as a rejected signup', async () => {
    const { send } = recorder(() => { throw new TypeError('Failed to fetch'); });

    await expect(client(send).createInbox({ service: 'discord.com', provider: null }))
      .rejects.toMatchObject({ kind: 'network' });
  });

  it('separates our own deadline from an upstream answer', async () => {
    const { send } = recorder(() => { throw new RequestTimeoutError('timed out'); });

    await expect(client(send).waitForCode({ inboxId: 'inbox-1', timeoutSeconds: 20, exclude: [] }))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports caller cancellation as cancellation, not as a network error', async () => {
    const { send } = recorder(() => { throw new RequestAbortedError('aborted'); });

    await expect(client(send).waitForCode({ inboxId: 'inbox-1', timeoutSeconds: 20, exclude: [] }))
      .rejects.toMatchObject({ kind: 'aborted' });
  });

  it('discards a response that arrived from a foreign origin', async () => {
    const { send } = recorder(() => json(200, { ok: true }, { finalUrl: 'https://evil.example/collect' }));

    const error = await client(send).listProviders().catch((e: ApiError) => e);

    expect(error).toMatchObject({ kind: 'protocol' });
  });

  it('does not parse a body that is not the shape it expects', async () => {
    const { send } = recorder(() => ({ status: 200, responseText: '<html>login</html>', headers: {} }));

    await expect(client(send).listProviders()).rejects.toMatchObject({ kind: 'protocol' });
  });
});
