import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../userscript/src/api.js';
import { AssistantSession } from '../userscript/src/session.js';
import type {
  ApiClient,
  CodeResult,
  CreatedInbox,
  ProviderSummary,
  ReportResult,
} from '../userscript/src/api.js';
import { identityId, keyValueSessionStore, memorySessionStore, sessionKey } from '../userscript/src/storage.js';
import { memoryKeyValueStore } from '../userscript/src/gm.js';

/**
 * Ownership invariants that must hold for the whole lifetime of a session.
 * They are the reason the session freezes values at the moment they are
 * decided instead of re-deriving them when a request is finally sent.
 */

const PROVIDERS: ProviderSummary[] = [
  {
    name: 'mailtm', displayName: 'Mail.tm', enabled: true, autoDispatch: true, tier: 'free',
    features: { pollInbox: true }, rateStatus: { available: true, nextAvailableAt: null, cooldownReason: null },
  },
  {
    name: 'mailgw', displayName: 'Mail.gw', enabled: true, autoDispatch: true, tier: 'free',
    features: { pollInbox: true }, rateStatus: { available: true, nextAvailableAt: null, cooldownReason: null },
  },
];

interface Recorded {
  createBody: Record<string, unknown> | null;
  reportBody: Record<string, unknown> | null;
  reportUrl: string | null;
}

function fakeClient(recorded: Recorded, created: CreatedInbox = {
  id: 'inbox-1', address: 'alpha@mailtm.example', provider: 'mailtm',
  expiresAt: '2026-11-14T00:00:00.000Z', features: { pollInbox: true },
}): ApiClient {
  return {
    listProviders: async () => PROVIDERS,
    createInbox: async (input) => {
      recorded.createBody = { ...input } as Record<string, unknown>;
      return created;
    },
    getInbox: async (id) => ({ id, address: created.address, provider: created.provider, service: 'discord.com', status: 'active', expiresAt: created.expiresAt }),
    findInboxes: async () => [],
    waitForCode: async (): Promise<CodeResult> => ({ codes: [], email: null, messageId: null, receivedAt: null }),
    listMessages: async () => [],
    getMessage: async (inboxId, messageId) => ({
      id: messageId,
      from: 'no-reply@discord.com',
      subject: '验证你的邮箱',
      excerpt: '你的验证码是 482913',
      receivedAt: '2026-11-13T10:00:00.000Z',
      text: '',
      html: '<p>你的验证码是 <b>482913</b></p><img src="https://track.example/pixel.gif">',
    }),
    reportSuccess: async (id, service): Promise<ReportResult> => {
      recorded.reportBody = { id, service };
      recorded.reportUrl = `/api/inbox/${id}/report`;
      return { ok: true };
    },
    closeInbox: async () => ({ ok: true }),
  };
}

function newSession(recorded: Recorded, created?: CreatedInbox) {
  return new AssistantSession({
    client: fakeClient(recorded, created),
    store: memorySessionStore(),
    ownerId: 'owner-a',
    tabId: 'tab-1',
    now: () => 1_700_000_000_000,
  });
}

describe('session service ownership', () => {
  it('keeps reporting against the service it was created for after the page navigates', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const session = newSession(recorded);

    await session.createInbox({ service: 'discord.com', provider: null });
    expect(session.state.inbox?.service).toBe('discord.com');

    // The user followed a "Sign in with Google" jump. Nothing about the inbox
    // or its accounting may follow them there.
    session.notePage({ url: 'https://accounts.google.com/o/oauth2/auth', service: 'google.com' });
    expect(session.state.inbox?.service).toBe('discord.com');

    await session.reportSuccess();
    expect(recorded.reportBody).toEqual({ id: 'inbox-1', service: 'discord.com' });
  });
});

describe('session provider ownership', () => {
  it('changes only the next dispatch when the provider selector moves', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const session = newSession(recorded);

    await session.createInbox({ service: 'discord.com', provider: 'mailtm' });
    expect(recorded.createBody).toMatchObject({ service: 'discord.com', provider: 'mailtm' });
    const firstAddress = session.state.inbox?.address;

    session.selectProvider('mailgw');
    expect(session.state.nextProvider).toBe('mailgw');
    expect(session.state.inbox?.provider).toBe('mailtm');
    expect(session.state.inbox?.address).toBe(firstAddress);

    // The next allocation is the only thing the selector can affect.
    await session.createInbox({ service: 'discord.com', provider: session.state.nextProvider });
    expect(recorded.createBody).toMatchObject({ provider: 'mailgw' });
  });

  it('keeps the old inbox when replacing it fails', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const session = newSession(recorded);
    await session.createInbox({ service: 'discord.com', provider: 'mailtm' });
    const before = session.state.inbox?.address;

    const failing = new AssistantSession({
      client: { ...fakeClient(recorded), createInbox: async () => { throw new Error('provider is down'); } },
      store: memorySessionStore(),
      ownerId: 'owner-a',
      tabId: 'tab-1',
      now: () => 1_700_000_000_000,
      initialState: session.state,
    });

    await expect(failing.createInbox({ service: 'discord.com', provider: 'mailgw' })).rejects.toThrow(/down/);
    expect(failing.state.inbox?.address).toBe(before);
    expect(failing.state.inbox?.provider).toBe('mailtm');
  });
});

describe('session polling outcomes', () => {
  it('separates "no mail yet" from "mail arrived but no code was recognised"', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const emptyThenMessage = new AssistantSession({
      client: {
        ...fakeClient(recorded),
        waitForCode: async (): Promise<CodeResult> => ({
          codes: [], email: null, messageId: null, receivedAt: null,
        }),
      },
      store: memorySessionStore(),
      ownerId: 'owner-a',
      tabId: 'tab-1',
      now: () => 1_700_000_000_000,
    });
    await emptyThenMessage.createInbox({ service: 'discord.com', provider: null });
    const empty = await emptyThenMessage.pollOnce(20);
    expect(empty).toMatchObject({ arrived: false, stale: false });
    expect(emptyThenMessage.state.seenMessageIds).toEqual([]);

    // The backend returns the message (subject/from/id) even when its extractor
    // finds nothing usable. Treating that as "no mail" is what left the panel
    // waiting forever on a real signup email.
    const arrivedSession = new AssistantSession({
      client: {
        ...fakeClient(recorded),
        waitForCode: async (): Promise<CodeResult> => ({
          codes: [],
          email: { from: 'no-reply@discord.com', subject: '验证你的邮箱' },
          messageId: 'm-1',
          receivedAt: '2026-11-13T10:00:00.000Z',
        }),
      },
      store: memorySessionStore(),
      ownerId: 'owner-a',
      tabId: 'tab-1',
      now: () => 1_700_000_000_000,
    });
    await arrivedSession.createInbox({ service: 'discord.com', provider: null });
    const arrived = await arrivedSession.pollOnce(20);

    expect(arrived).toMatchObject({ arrived: true, messageId: 'm-1' });
    expect(arrivedSession.state.phase).toBe('result');
    expect(arrivedSession.state.seenMessageIds).toEqual(['m-1']);
  });

  it('keeps the last message across a page navigation, and continuing hides it', async () => {
    // The site moves from "enter your email" to "enter the code" with a full
    // page load. The code that arrived meanwhile must still be there.
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const store = memorySessionStore();
    const client: ApiClient = {
      ...fakeClient(recorded),
      waitForCode: async (): Promise<CodeResult> => ({
        codes: [{ type: 'numeric', value: '482913', context: 'code 482913' }],
        email: { from: 'no-reply@discord.com', subject: '验证你的邮箱' },
        messageId: 'm-1',
        receivedAt: '2026-11-13T10:00:00.000Z',
      }),
    };
    const before = new AssistantSession({ client, store, ownerId: 'owner-a', tabId: null, now: () => 1 });
    await before.createInbox({ service: 'discord.com', provider: null });
    await before.pollOnce(20);
    await before.markResultUsed();

    const after = await AssistantSession.restore({ client, store, ownerId: 'owner-a', tabId: null, now: () => 2 });
    expect(after!.state.phase).toBe('result');
    expect(after!.state.lastResult).toMatchObject({
      messageId: 'm-1', subject: '验证你的邮箱', used: true,
      codes: [{ type: 'numeric', value: '482913', context: 'code 482913' }],
    });

    await after!.continuePolling();
    expect(after!.state.phase).toBe('polling');
    // Still on record (copyable), and still excluded from the next poll.
    expect(after!.state.lastResult?.messageId).toBe('m-1');
    expect(after!.state.seenMessageIds).toEqual(['m-1']);
  });

  it('a message after reporting does not undo the reported stage', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const session = new AssistantSession({
      client: {
        ...fakeClient(recorded),
        waitForCode: async (): Promise<CodeResult> => ({
          codes: [{ type: 'numeric', value: '111222' }], email: null, messageId: 'm-2', receivedAt: null,
        }),
      },
      store: memorySessionStore(), ownerId: 'owner-a', tabId: null, now: () => 1,
    });
    await session.createInbox({ service: 'discord.com', provider: null });
    await session.reportSuccess();
    await session.continuePolling();
    await session.pollOnce(20);
    expect(session.state.phase).toBe('reported');
    expect(session.state.lastResult?.codes[0].value).toBe('111222');
  });

  it('renders a message body as plain text and never returns markup', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const session = newSession(recorded);
    await session.createInbox({ service: 'discord.com', provider: null });

    const detail = await session.fetchMessage('m-1');

    expect(detail.bodyText).toContain('你的验证码是 482913');
    expect(detail.bodyText).not.toContain('<');
    // Tracking pixels must not survive as anything the panel could load.
    expect(detail.bodyText).not.toContain('track.example');
    expect(detail.subject).toBe('验证你的邮箱');
  });
});

describe('restoring a persisted run', () => {
  it('reopens the same inbox after a page navigation instead of offering a new one', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const store = memorySessionStore();
    const before = new AssistantSession({
      client: fakeClient(recorded), store, ownerId: 'owner-a', tabId: null, now: () => 1,
    });
    await before.createInbox({ service: 'discord.com', provider: null });

    let createCalls = 0;
    const after = await AssistantSession.restore({
      client: {
        ...fakeClient(recorded),
        createInbox: async () => { createCalls += 1; throw new Error('must not allocate a second inbox'); },
      },
      store,
      ownerId: 'owner-a',
      tabId: null,
      now: () => 2,
    });

    expect(after?.state.inbox?.address).toBe(before.state.inbox?.address);
    expect(after?.state.inbox?.service).toBe('discord.com');
    expect(after?.state.phase).toBe('polling');
    expect(createCalls).toBe(0);
  });

  it('believes the server when a restored inbox is already closed', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const store = memorySessionStore();
    const before = new AssistantSession({
      client: fakeClient(recorded), store, ownerId: 'owner-a', tabId: null, now: () => 1,
    });
    await before.createInbox({ service: 'discord.com', provider: null });

    const after = await AssistantSession.restore({
      client: {
        ...fakeClient(recorded),
        getInbox: async (id) => ({
          id, address: 'alpha@mailtm.example', provider: 'mailtm',
          service: 'discord.com', status: 'closed', expiresAt: null,
        }),
      },
      store,
      ownerId: 'owner-a',
      tabId: null,
      now: () => 2,
    });

    await after!.verify();
    expect(after!.state.phase).toBe('closed');
  });

  it('keeps an unanswered create unanswered rather than re-sending it', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const store = memorySessionStore();
    const before = new AssistantSession({
      client: fakeClient(recorded), store, ownerId: 'owner-a', tabId: null, now: () => 1,
    });
    await before.createInbox({ service: 'discord.com', provider: null });
    // Rewrite the persisted phase to what a crash mid-create leaves behind.
    const persisted = (await store.load())!;
    await store.save({ ...persisted, phase: 'creating' });

    let createCalls = 0;
    const after = await AssistantSession.restore({
      client: {
        ...fakeClient(recorded),
        createInbox: async () => { createCalls += 1; throw new Error('must not retry'); },
      },
      store,
      ownerId: 'owner-a',
      tabId: null,
      now: () => 2,
    });

    expect(after?.state.phase).toBe('creating');
    expect(after?.state.inbox?.address).toBe(persisted.inbox?.address);
    expect(createCalls).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const CODE_EXISTS: CodeResult = {
  codes: [{ type: 'numeric', value: '482913' }],
  email: { from: 'no-reply@discord.com', subject: '验证你的邮箱' },
  messageId: 'm-late',
  receivedAt: '2026-11-13T10:00:00.000Z',
};

function counting(recorded: Recorded) {
  const calls = { create: 0, report: 0, close: 0 };
  const base = fakeClient(recorded);
  return {
    calls,
    client: {
      ...base,
      createInbox: async (input: Parameters<typeof base.createInbox>[0]) => {
        calls.create += 1;
        return await base.createInbox(input);
      },
      reportSuccess: async (id: string, service: string) => {
        calls.report += 1;
        return await base.reportSuccess(id, service);
      },
      closeInbox: async (id: string) => {
        calls.close += 1;
        return await base.closeInbox(id);
      },
    } as ApiClient,
  };
}

function sessionWith(client: ApiClient, extra: { store?: ReturnType<typeof memorySessionStore>; ownerId?: string } = {}) {
  return new AssistantSession({
    client,
    store: extra.store ?? memorySessionStore(),
    ownerId: extra.ownerId ?? 'owner-a',
    tabId: 'tab-1',
    now: () => 1_700_000_000_000,
  });
}

describe('no duplicate operations', () => {
  it('sends one create when the button is pressed twice', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const { calls, client } = counting(recorded);
    const session = sessionWith(client);

    const first = session.createInbox({ service: 'discord.com', provider: null });
    const second = session.createInbox({ service: 'discord.com', provider: null });
    await Promise.all([first, second]);

    expect(calls.create).toBe(1);
    expect(session.state.inbox?.address).toBe('alpha@mailtm.example');
  });

  it('does not reopen a closed inbox when a late poll answers', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const pending = deferred<CodeResult>();
    const { client } = counting(recorded);
    const session = sessionWith({ ...client, waitForCode: () => pending.promise });

    await session.createInbox({ service: 'discord.com', provider: null });
    const poll = session.pollOnce(20);
    await session.closeInbox();
    pending.resolve(CODE_EXISTS);

    const result = await poll;
    expect(result.stale).toBe(true);
    expect(session.state.phase).toBe('closed');
    expect(session.state.seenMessageIds).toEqual([]);
  });

  it('reports at most once, including after a refresh', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const { calls, client } = counting(recorded);
    const store = memorySessionStore();
    const session = sessionWith(client, { store });

    await session.createInbox({ service: 'discord.com', provider: null });
    await session.reportSuccess();
    const second = await session.reportSuccess();
    expect(second).toMatchObject({ action: 'already_reported' });

    const afterRefresh = await AssistantSession.restore({ client, store, ownerId: 'owner-a', tabId: 'tab-1', now: () => 2 });
    await afterRefresh!.reportSuccess();
    expect(calls.report).toBe(1);
  });

  it('does not auto-retry a report whose answer never arrived', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    let reportCalls = 0;
    const { client } = counting(recorded);
    const session = sessionWith({
      ...client,
      reportSuccess: async () => {
        reportCalls += 1;
        throw new ApiError('timeout', '请求超时');
      },
    });

    await session.createInbox({ service: 'discord.com', provider: null });
    await expect(session.reportSuccess()).rejects.toMatchObject({ kind: 'timeout' });
    expect(session.state.phase).toBe('report-unknown');

    // The next attempt is a no-op: the server may already have counted it.
    await session.reportSuccess();
    expect(reportCalls).toBe(1);
  });

  it('never closes the inbox when the report step is unconfirmed', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const { calls, client } = counting(recorded);
    const session = sessionWith({
      ...client,
      reportSuccess: async () => { throw new ApiError('timeout', '请求超时'); },
    });

    await session.createInbox({ service: 'discord.com', provider: null });
    await expect(session.finishSuccessfully()).rejects.toMatchObject({ kind: 'timeout' });

    expect(calls.close).toBe(0);
    expect(session.state.phase).toBe('report-unknown');
  });

  it('closes only after a confirmed report', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const { calls, client } = counting(recorded);
    const session = sessionWith(client);
    await session.createInbox({ service: 'discord.com', provider: null });

    await session.finishSuccessfully();

    expect(calls).toEqual({ create: 1, report: 1, close: 1 });
    expect(session.state.phase).toBe('closed');
    expect(session.state.reported).toBe(true);
  });

  it('lets a failed close be retried', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    let attempts = 0;
    const { client } = counting(recorded);
    const session = sessionWith({
      ...client,
      closeInbox: async () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError('network', '断网');
        return { ok: true };
      },
    });

    await session.createInbox({ service: 'discord.com', provider: null });
    await expect(session.closeInbox()).rejects.toMatchObject({ kind: 'network' });
    expect(session.state.phase).toBe('close-failed');

    await session.closeInbox();
    expect(session.state.phase).toBe('closed');
    expect(session.state.reported).toBe(false);
  });

  it('keeps two connections in separate partitions', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    // Mirror production: one GM store, one namespaced key per connection identity.
    const kv = memoryKeyValueStore();
    const storeFor = (apiKey: string) => keyValueSessionStore(
      kv, sessionKey(identityId('https://mail.example.com', apiKey), null),
    );

    const first = new AssistantSession({
      client: counting(recorded).client,
      store: storeFor('key-a'),
      ownerId: identityId('https://mail.example.com', 'key-a'),
      tabId: null,
      now: () => 1,
    });
    await first.createInbox({ service: 'discord.com', provider: null });

    const other = await AssistantSession.restore({
      client: fakeClient(recorded),
      store: storeFor('key-b'),
      ownerId: identityId('https://mail.example.com', 'key-b'),
      tabId: null,
      now: () => 2,
    });

    expect(other).toBeNull();
    // Switching back must still find the first run.
    const back = await AssistantSession.restore({
      client: fakeClient(recorded),
      store: storeFor('key-a'),
      ownerId: identityId('https://mail.example.com', 'key-a'),
      tabId: null,
      now: () => 3,
    });
    expect(back?.state.inbox?.address).toBe(first.state.inbox?.address);
  });
});

describe('exclusion cap', () => {
  // The cap lives in the request builder, so this uses the real client: the
  // point is that a long-lived inbox is refused locally, not by the server.
  function realClient() {
    const json = (status: number, body: unknown) => ({
      status, responseText: JSON.stringify(body), headers: {},
    });
    return createApiClient({
      baseUrl: 'https://mail.example.com',
      apiKey: 'mk_test',
      send: async (request) => (request.method === 'POST'
        ? json(201, {
          id: 'inbox-1', address: 'alpha@mailtm.example', provider: 'mailtm',
          expiresAt: null, features: { pollInbox: true },
        })
        : json(200, { codes: [], email: null, messageId: null, receivedAt: null })),
    });
  }

  it('stops on a full exclusion list and only continues after an explicit reset', async () => {
    const store = memorySessionStore();
    const session = sessionWith(realClient(), { store });
    await session.createInbox({ service: 'discord.com', provider: null });

    // 21 distinct ids: one past what GET /code accepts.
    const persisted = (await store.load())!;
    await store.save({
      ...persisted,
      seenMessageIds: Array.from({ length: 21 }, (_, index) => `m-${index}`),
    });

    const capped = await AssistantSession.restore({
      client: realClient(), store, ownerId: 'owner-a', tabId: 'tab-1', now: () => 2,
    });

    await expect(capped!.pollOnce(20)).rejects.toMatchObject({ kind: 'invalid' });
    expect(capped!.state.seenMessageIds).toHaveLength(21);

    await capped!.resetSeen();
    expect(capped!.state.seenMessageIds).toEqual([]);

    const result = await capped!.pollOnce(20);
    expect(result.stale).toBe(false);
  });
});

describe('two tabs sharing one connection', () => {
  it('does not report twice when the other tab reported first', async () => {
    const recorded: Recorded = { createBody: null, reportBody: null, reportUrl: null };
    const { calls, client } = counting(recorded);
    const store = memorySessionStore();

    const tabA = new AssistantSession({
      client, store, ownerId: 'owner-a', tabId: null, now: () => 1,
    });
    await tabA.createInbox({ service: 'discord.com', provider: null });

    // Tab B opened before A reported, so its in-memory copy says "unreported".
    const tabB = await AssistantSession.restore({
      client, store, ownerId: 'owner-a', tabId: null, now: () => 2,
    });
    expect(tabB!.state.reported).toBe(false);

    await tabA.reportSuccess();
    const result = await tabB!.reportSuccess();

    expect(result).toMatchObject({ action: 'already_reported' });
    expect(tabB!.state.reported).toBe(true);
    expect(calls.report).toBe(1);
  });
});
