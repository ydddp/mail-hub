import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { app, authHeaders } from './helpers/http.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../src/providers/base.js';
import { isMessageWithinInboxLifetime, parseInboxTimestamp } from '../src/inbox-lifecycle.js';
import { cleanupExpired } from '../src/app.js';
import { hashApiKey } from '../src/crypto.js';
import { MessageNotFoundError, UpstreamHttpError } from '../src/errors.js';
import * as imapCore from '../src/providers/imap-core.js';

/**
 * Pool providers (Outlook 1:1-but-reused, YYDS, IMAP catch-all) hand out
 * mailboxes that already contain someone else's mail. The inbox row's
 * created_at is the only boundary between "this tenant's mail" and history, so
 * every user-facing message surface must apply it. /code already did;
 * /messages did not, and leaked the previous owner's mail into the UI.
 */

class HistoryProvider extends BaseProvider {
  meta: ProviderMeta = {
    name: 'history',
    displayName: 'History Mail',
    type: 'api',
    tier: 'free',
    trustLevel: 5,
    rateLimit: { createPerMinute: 60, pollPerMinute: 60 },
    retention: 'test',
    features: { customUsername: true, pollInbox: true, realtime: false, attachments: false },
  };

  constructor(
    private readonly messages: Message[],
    private readonly details: Record<string, Partial<MessageDetail>> = {},
  ) {
    super();
  }

  async getDomains(): Promise<string[]> { return ['example.test']; }

  async createInbox(): Promise<InboxData> {
    return { address: 'pooled@example.test', authData: {}, provider: this.meta.name, apiBase: '' };
  }

  async getMessages(): Promise<Message[]> { return this.messages; }

  async getMessage(_inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const found = this.messages.find((m) => m.id === messageId);
    if (!found) throw new Error(`no such message ${messageId}`);
    return { ...found, text: 'body', ...this.details[messageId] };
  }
}

function insertInbox(
  id: string,
  provider: string,
  createdAt: string,
  opts: { closedAt?: string | null; expiresAt?: string | null; status?: string; ownerKey?: string } = {},
): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, created_at, closed_at, expires_at, status, owner_key)
     VALUES (?, ?, 'pooled@example.test', '{}', '', ?, ?, ?, ?, ?)`,
  ).run(id, provider, createdAt, opts.closedAt ?? null, opts.expiresAt ?? null, opts.status ?? 'active', opts.ownerKey ? hashApiKey(opts.ownerKey) : null);
}

const PREVIOUS_TENANT: Message = {
  id: 'old-1',
  from: 'newsletter@spam.test',
  subject: "theo, here's how teams use Quotient",
  excerpt: '',
  receivedAt: '2026-07-23T03:10:13Z',
};
const CURRENT_TENANT: Message = {
  id: 'new-1',
  from: 'Anthropic <no-reply@mail.anthropic.com>',
  subject: 'Your login code is 123456',
  excerpt: '',
  receivedAt: '2026-07-26T14:02:30Z',
};

describe('pooled inbox history isolation', () => {
  // Removing current candidates cannot expose a previous tenant's older code.
  it.each(['latest', 'matching'])('keeps lifetime isolation when exclusion exhausts %s candidates', async selection => {
    const provider = new HistoryProvider([CURRENT_TENANT, PREVIOUS_TENANT]);
    if (selection === 'matching') provider.meta.name = 'outlook';
    registry.register(provider);
    insertInbox('excluded-history', provider.meta.name, '2026-07-26 14:02:18', { expiresAt: '2099-01-01' });
    if (selection === 'matching') {
      getDb().prepare(`UPDATE inboxes SET address = 'user@outlook.com', auth_data = '{"email":"user@outlook.com"}' WHERE id = 'excluded-history'`).run();
      getDb().prepare(`INSERT INTO outlook_accounts (email,password,client_id,refresh_token,assigned_inbox_id) VALUES ('user@outlook.com','p','c','r','excluded-history')`).run();
    }
    const details = vi.spyOn(provider, 'getMessage');
    const response = await app.request(`/api/inbox/excluded-history/code?selection=${selection}&excludeMessageId=new-1`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(EMPTY_CODE);
    expect(details).not.toHaveBeenCalled();
  });
  it('GET /messages hides mail that predates the inbox', async () => {
    registry.register(new HistoryProvider([CURRENT_TENANT, PREVIOUS_TENANT]));
    // created_at is stored by SQLite's datetime('now') — UTC, space-separated.
    insertInbox('iso-messages', 'history', '2026-07-26 14:02:18');

    const res = await app.request('/api/inbox/iso-messages/messages', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Message[] };

    expect(body.messages.map((m) => m.id)).toEqual(['new-1']);
    registry.unregister('history');
  });

  it('GET /messages/:mid refuses to open a pre-inbox message', async () => {
    registry.register(new HistoryProvider([CURRENT_TENANT, PREVIOUS_TENANT]));
    insertInbox('iso-detail', 'history', '2026-07-26 14:02:18');

    const leaked = await app.request('/api/inbox/iso-detail/messages/old-1', { headers: authHeaders() });
    expect(leaked.status).toBe(404);

    const own = await app.request('/api/inbox/iso-detail/messages/new-1', { headers: authHeaders() });
    expect(own.status).toBe(200);
    registry.unregister('history');
  });

  it('keeps messages whose timestamp is missing or unparseable', async () => {
    registry.register(new HistoryProvider([
      { id: 'no-date', from: 'a@b.test', subject: 'undated', excerpt: '', receivedAt: '' },
    ]));
    insertInbox('iso-undated', 'history', '2026-07-26 14:02:18');

    const res = await app.request('/api/inbox/iso-undated/messages', { headers: authHeaders() });
    const body = await res.json() as { messages: Message[] };

    expect(body.messages.map((m) => m.id)).toEqual(['no-date']);
    registry.unregister('history');
  });

  it('does not filter when created_at is unparseable', async () => {
    registry.register(new HistoryProvider([PREVIOUS_TENANT]));
    // created_at is NOT NULL, but a legacy/corrupt row can still hold a value
    // SQLite never produced. No boundary is knowable, so nothing is dropped.
    insertInbox('iso-nocreated', 'history', 'not-a-timestamp');

    const res = await app.request('/api/inbox/iso-nocreated/messages', { headers: authHeaders() });
    const body = await res.json() as { messages: Message[] };

    expect(body.messages.map((m) => m.id)).toEqual(['old-1']);
    registry.unregister('history');
  });

  it('still returns the inbox metadata envelope alongside filtered messages', async () => {
    const fake = new FakeProvider();
    registry.register(fake);
    insertInbox('iso-envelope', 'fake', '2020-01-01 00:00:00');

    const res = await app.request('/api/inbox/iso-envelope/messages', { headers: authHeaders() });
    const body = await res.json() as { messages: Message[]; status: string; address: string; provider: string };

    expect(body.status).toBe('active');
    expect(body.address).toBe('pooled@example.test');
    expect(body.provider).toBe('fake');
    expect(body.messages).toHaveLength(1);
    registry.unregister('fake');
  });
});

type ReadSurface = 'messages' | 'detail' | 'code';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class DeferredHistoryProvider extends HistoryProvider {
  readonly entered = deferred();
  readonly released = deferred();
  detailCalls = 0;

  constructor(messages: Message[], private readonly blocked: 'list' | 'detail', private readonly failure?: Error) {
    super(messages);
  }

  private async block(at: 'list' | 'detail'): Promise<void> {
    if (at !== this.blocked) return;
    this.entered.resolve();
    await this.released.promise;
    if (this.failure) throw this.failure;
  }

  override async getMessages(): Promise<Message[]> {
    await this.block('list');
    return super.getMessages();
  }

  override async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    this.detailCalls++;
    await this.block('detail');
    return super.getMessage(inbox, messageId);
  }
}

type LeaseMutation = 'close' | 'delete' | 'expiry' | 'new owner' | 'reassignment';
const LEASE_MUTATIONS: LeaseMutation[] = ['close', 'delete', 'expiry', 'new owner', 'reassignment'];
const EMPTY_CODE = { codes: [], email: null, messageId: null, receivedAt: null };

function insertRaceInbox(id: string): void {
  getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, 'race owner')`).run(hashApiKey('race-owner'));
  insertInbox(id, 'history', '2020-01-01 00:00:00', { expiresAt: '2099-01-01 00:00:00', ownerKey: 'race-owner' });
}

async function mutateLease(id: string, mutation: LeaseMutation): Promise<void> {
  if (mutation === 'close' || mutation === 'reassignment') {
    const response = await app.request(`/api/inbox/${id}`, { method: 'DELETE', headers: authHeaders('race-owner') });
    expect(response.status).toBe(200);
    if (mutation === 'reassignment') {
      insertInbox(`${id}-next`, 'history', new Date().toISOString(), { ownerKey: 'next-owner' });
    }
  } else if (mutation === 'new owner') {
    getDb().prepare(`UPDATE inboxes SET owner_key = ? WHERE id = ?`).run(hashApiKey('next-owner'), id);
  } else {
    getDb().prepare(`UPDATE inboxes SET expires_at = datetime('now', ?) WHERE id = ?`)
      .run(mutation === 'delete' ? '-40 days' : '-1 second', id);
    if (mutation === 'delete') await cleanupExpired();
    expect(getDb().prepare(`SELECT id FROM inboxes WHERE id = ?`).get(id) !== undefined).toBe(mutation !== 'delete');
  }
}

function raceMessage(beforeClose = false): Message {
  return {
    id: 'racing-mail', from: 'sender@test', subject: 'Your code is 778899', excerpt: '',
    receivedAt: new Date(Date.now() + (beforeClose ? -60_000 : 60_000)).toISOString(),
  };
}

function raceRequest(surface: ReadSurface, id: string): Promise<Response> {
  const suffix = surface === 'detail' ? 'messages/racing-mail' : surface;
  return app.request(`/api/inbox/${id}/${suffix}`, { headers: authHeaders('race-owner') });
}

async function expectRaceExcluded(response: Response, surface: ReadSurface, mutation: LeaseMutation): Promise<void> {
  if (mutation === 'delete' || mutation === 'new owner') {
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Inbox not found' });
  } else if (surface === 'detail') {
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Message not found' });
  } else {
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(surface === 'code' ? EMPTY_CODE : { messages: [], status: mutation === 'expiry' ? 'active' : 'closed' });
  }
}

describe.each<ReadSurface>(['messages', 'detail', 'code'])('%s in-flight lease changes', (surface) => {
  it.each(LEASE_MUTATIONS)('rechecks %s after the provider returns', async (mutation) => {
    const provider = new DeferredHistoryProvider([raceMessage()], surface === 'detail' ? 'detail' : 'list');
    registry.register(provider);
    const id = `race-${surface}`;
    insertRaceInbox(id);
    const pending = raceRequest(surface, id);
    await provider.entered.promise;
    await mutateLease(id, mutation);
    provider.released.resolve();

    await expectRaceExcluded(await pending, surface, mutation);
    if (surface === 'code') expect(provider.detailCalls).toBe(0);
  });

  it.each<LeaseMutation>(['delete', 'new owner'])('rechecks %s when the provider fails', async (mutation) => {
    const provider = new DeferredHistoryProvider([raceMessage()], surface === 'detail' ? 'detail' : 'list', new Error('upstream failed'));
    registry.register(provider);
    const id = `race-error-${surface}`;
    insertRaceInbox(id);
    const pending = raceRequest(surface, id);
    await provider.entered.promise;
    await mutateLease(id, mutation);
    provider.released.resolve();

    await expectRaceExcluded(await pending, surface, mutation);
  });

  it('keeps pre-close historical mail readable after a concurrent close', async () => {
    const provider = new DeferredHistoryProvider([raceMessage(true)], surface === 'detail' ? 'detail' : 'list');
    registry.register(provider);
    const id = `race-history-${surface}`;
    insertRaceInbox(id);
    const pending = raceRequest(surface, id);
    await provider.entered.promise;
    await mutateLease(id, 'close');
    provider.released.resolve();

    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json();
    if (surface === 'messages') expect(body).toMatchObject({ status: 'closed', messages: [expect.objectContaining({ id: 'racing-mail' })] });
    else expect(body).toMatchObject(surface === 'detail' ? { id: 'racing-mail' } : { messageId: 'racing-mail' });
  });
});

describe.each([
  { outcome: 'success', failure: undefined },
  { outcome: 'summary fallback', failure: new Error('temporary upstream error') },
  { outcome: '503 summary fallback', failure: new UpstreamHttpError('Detail unavailable', 503) },
  { outcome: '429 rejection', failure: new UpstreamHttpError('Detail limited', 429, '43') },
  { outcome: 'recipient rejection', failure: new MessageNotFoundError() },
])('/code detail $outcome lease changes', ({ failure }) => {
  it.each(LEASE_MUTATIONS)('rechecks %s after fetching detail', async (mutation) => {
    const provider = new DeferredHistoryProvider([raceMessage()], 'detail', failure);
    registry.register(provider);
    insertRaceInbox('race-code-detail');
    const pending = raceRequest('code', 'race-code-detail');
    await provider.entered.promise;
    await mutateLease('race-code-detail', mutation);
    provider.released.resolve();

    await expectRaceExcluded(await pending, 'code', mutation);
    expect(provider.detailCalls).toBe(1);
  });
});

it('/messages returns the current address and status after its provider wait', async () => {
  const provider = new DeferredHistoryProvider([raceMessage(true)], 'list');
  registry.register(provider);
  insertRaceInbox('race-metadata');
  const pending = raceRequest('messages', 'race-metadata');
  await provider.entered.promise;
  await mutateLease('race-metadata', 'close');
  getDb().prepare(`UPDATE inboxes SET address = 'current@example.test' WHERE id = 'race-metadata'`).run();
  provider.released.resolve();

  const response = await pending;
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: 'closed', address: 'current@example.test' });
});

async function readIds(surface: ReadSurface, inboxId: string, messageId: string): Promise<string[]> {
  const suffix = surface === 'messages' ? 'messages' : surface === 'detail' ? `messages/${messageId}` : 'code';
  const res = await app.request(`/api/inbox/${inboxId}/${suffix}`, { headers: authHeaders() });
  if (surface === 'messages') {
    expect(res.status).toBe(200);
    return ((await res.json()) as { messages: Message[] }).messages.map((message) => message.id);
  }
  if (surface === 'detail') return res.status === 200 ? [messageId] : [];
  expect(res.status).toBe(200);
  const body = await res.json() as { messageId: string | null };
  return body.messageId ? [body.messageId] : [];
}

describe.each<ReadSurface>(['messages', 'detail', 'code'])('%s lease end isolation', (surface) => {
  it('fails closed for the whole imprecise created_at second', async () => {
    const ambiguous: Message = {
      id: 'ambiguous-start', from: 'sender@test', subject: 'Code 101010', excerpt: '', receivedAt: '2026-07-26T14:02:00.100Z',
    };
    const safelyAfter: Message = {
      id: 'safe-start', from: 'sender@test', subject: 'Code 202020', excerpt: '', receivedAt: '2026-07-26T14:02:01.000Z',
    };
    registry.register(new HistoryProvider([ambiguous]));
    insertInbox(`strict-start-${surface}`, 'history', '2026-07-26 14:02:00', {
      expiresAt: '2099-01-01 00:00:00', status: 'active',
    });

    expect(await readIds(surface, `strict-start-${surface}`, 'ambiguous-start')).not.toContain('ambiguous-start');
    registry.register(new HistoryProvider([safelyAfter]));
    expect(await readIds(surface, `strict-start-${surface}`, 'safe-start')).toContain('safe-start');
    registry.unregister('history');
  });

  it.each([
    {
      label: 'closed_at',
      inbox: { closedAt: '2026-07-26 14:03:00', expiresAt: '2026-07-26 15:00:00', status: 'closed' },
    },
    {
      label: 'expires_at',
      inbox: { expiresAt: '2026-07-26 14:03:00', status: 'active' },
    },
    {
      label: 'expires_at before a delayed close',
      inbox: { closedAt: '2026-07-26 14:05:00', expiresAt: '2026-07-26 14:03:00', status: 'closed' },
    },
  ])('rejects mail at or after $label without upper-bound slack', async ({ inbox }) => {
    const beforeEnd: Message = {
      id: 'before-end', from: 'sender@test', subject: 'Code 111111', excerpt: '', receivedAt: '2026-07-26T14:02:59Z',
    };
    const atEnd: Message = {
      id: 'at-end', from: 'sender@test', subject: 'Code 222222', excerpt: '', receivedAt: '2026-07-26T14:03:00Z',
    };
    registry.register(new HistoryProvider([beforeEnd]));
    insertInbox(`end-${surface}-${inbox.status}`, 'history', '2026-07-26 14:02:00', inbox);

    const before = await readIds(surface, `end-${surface}-${inbox.status}`, 'before-end');
    registry.register(new HistoryProvider([atEnd]));
    const after = await readIds(surface, `end-${surface}-${inbox.status}`, 'at-end');

    expect(before).toContain('before-end');
    expect(after).not.toContain('at-end');
    registry.unregister('history');
  });

  it('keeps adjacent lease windows non-overlapping at the handoff instant', async () => {
    const handoff: Message = {
      id: 'handoff', from: 'sender@test', subject: 'Code 333333', excerpt: '', receivedAt: '2026-07-26T14:03:00Z',
    };
    const safelyNext: Message = {
      id: 'safely-next', from: 'sender@test', subject: 'Code 343434', excerpt: '', receivedAt: '2026-07-26T14:03:01Z',
    };
    registry.register(new HistoryProvider([handoff]));
    insertInbox(`previous-${surface}`, 'history', '2026-07-26 14:02:00', {
      closedAt: '2026-07-26 14:03:00', status: 'closed',
    });
    insertInbox(`next-${surface}`, 'history', '2026-07-26 14:03:00', {
      expiresAt: '2099-01-01 00:00:00', status: 'active',
    });

    expect(await readIds(surface, `previous-${surface}`, 'handoff')).not.toContain('handoff');
    expect(await readIds(surface, `next-${surface}`, 'handoff')).not.toContain('handoff');
    registry.register(new HistoryProvider([safelyNext]));
    expect(await readIds(surface, `next-${surface}`, 'safely-next')).toContain('safely-next');
    registry.unregister('history');
  });

  it.each([
    { label: 'missing', receivedAt: '' },
    { label: 'unparseable', receivedAt: 'not-a-date' },
  ])('fails closed for $label message dates after a lease has ended', async ({ receivedAt }) => {
    const message: Message = {
      id: 'unknown-date', from: 'sender@test', subject: 'Code 444444', excerpt: '', receivedAt,
    };
    registry.register(new HistoryProvider([message]));
    insertInbox(`unknown-${surface}-${receivedAt || 'missing'}`, 'history', '2026-07-26 14:02:00', {
      closedAt: '2026-07-26 14:03:00', status: 'closed',
    });

    expect(await readIds(surface, `unknown-${surface}-${receivedAt || 'missing'}`, 'unknown-date'))
      .not.toContain('unknown-date');
    registry.unregister('history');
  });

  it('fails closed for legacy closed rows with no usable end timestamp', async () => {
    const message: Message = {
      id: 'legacy', from: 'sender@test', subject: 'Code 555555', excerpt: '', receivedAt: '2026-07-26T14:02:30Z',
    };
    registry.register(new HistoryProvider([message]));
    insertInbox(`legacy-${surface}`, 'history', '2026-07-26 14:02:00', { status: 'closed' });

    expect(await readIds(surface, `legacy-${surface}`, 'legacy')).not.toContain('legacy');
    registry.unregister('history');
  });
});

it('/code revalidates the detailed message timestamp before extracting a code', async () => {
  const summary: Message = {
    id: 'changed-date', from: 'sender@test', subject: 'Code 666666', excerpt: '', receivedAt: '2026-07-26T14:02:30Z',
  };
  registry.register(new HistoryProvider([summary], {
    'changed-date': { receivedAt: '2026-07-26T14:03:01Z', text: 'Code 666666' },
  }));
  insertInbox('detail-recheck', 'history', '2026-07-26 14:02:00', {
    closedAt: '2026-07-26 14:03:00', status: 'closed',
  });

  const res = await app.request('/api/inbox/detail-recheck/code', { headers: authHeaders() });
  const body = await res.json() as { codes: unknown[]; messageId: string | null };
  expect(body.codes).toEqual([]);
  expect(body.messageId).toBeNull();
  registry.unregister('history');
});

/**
 * created_at is written by SQLite as UTC 'YYYY-MM-DD HH:MM:SS'. `new Date()` on
 * that shape applies the LOCAL zone, so on any non-UTC host the boundary shifts
 * by the offset — east of UTC it lands early and history leaks through, west of
 * it the tenant's own mail is hidden. Production runs UTC, which is why /code's
 * existing filter appeared to work.
 */
describe('parseInboxTimestamp', () => {
  it('reads SQLite datetime() output as UTC regardless of host timezone', () => {
    expect(parseInboxTimestamp('2026-07-26 14:02:18')).toBe(Date.UTC(2026, 6, 26, 14, 2, 18));
  });

  it('still honours an explicit timezone offset', () => {
    expect(parseInboxTimestamp('2026-07-26T14:02:18Z')).toBe(Date.UTC(2026, 6, 26, 14, 2, 18));
    expect(parseInboxTimestamp('2026-07-26T23:02:18+09:00')).toBe(Date.UTC(2026, 6, 26, 14, 2, 18));
  });

  it('returns 0 for missing or unparseable input', () => {
    expect(parseInboxTimestamp(undefined)).toBe(0);
    expect(parseInboxTimestamp('')).toBe(0);
    expect(parseInboxTimestamp('not a date')).toBe(0);
  });

  it('keeps the legacy numeric helper contract strictly lower-bounded', () => {
    const start = Date.UTC(2026, 6, 26, 14, 2, 0);
    expect(isMessageWithinInboxLifetime('2026-07-26T14:01:59Z', start)).toBe(false);
    expect(isMessageWithinInboxLifetime('2026-07-26T14:02:00Z', start)).toBe(true);
  });
});

// Historical duplicate leases must stay isolated after close/restart, while
// adjacent reuse and ordinary closed history retain their existing contract.
describe('legacy IMAP overlapping lease history', () => {
  afterEach(() => vi.restoreAllMocks());

  function seed(overlap: boolean, expiredActive = false): Message {
    const db = getDb();
    db.exec('DROP TRIGGER IF EXISTS imap_active_address_insert; DROP TRIGGER IF EXISTS imap_active_address_update;');
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain)
      VALUES ('history-imap', 'mock.test', 993, 'local', 'local', 'example.test')`).run();
    const insert = db.prepare(`INSERT INTO inboxes
      (id, provider, address, auth_data, created_at, closed_at, expires_at, status, owner_key)
      VALUES (?, 'imap', ?, '{"imapAccountId":"history-imap"}', ?, ?, '2099-01-01 00:00:00', ?, ?)`);
    for (const owner of ['a', 'b']) db.prepare('INSERT INTO api_keys (key, name) VALUES (?, ?)').run(hashApiKey(`history-${owner}`), owner);
    insert.run('imap-history-a', ' Shared@ Example.TEST ', '2026-07-26 14:00:00', overlap ? null : '2026-07-26 14:01:00', overlap ? 'active' : 'closed', hashApiKey('history-a'));
    insert.run('imap-history-b', 'shared@example.test', '2026-07-26 14:01:00', null, 'active', hashApiKey('history-b'));
    if (expiredActive) db.prepare(`UPDATE inboxes SET status = 'active', closed_at = NULL,
      expires_at = '2026-07-26 14:01:00' WHERE id = 'imap-history-a'`).run();
    const message: Message = {
      id: '1', from: 'sender@test', subject: 'Code 765432', excerpt: '',
      receivedAt: overlap ? '2026-07-26T14:01:30Z' : '2026-07-26T14:00:30Z',
    };
    vi.spyOn(imapCore, 'fetchMessagesAcrossMailboxes').mockImplementation(async () => [message]);
    vi.spyOn(imapCore, 'fetchMessageDetailAcrossMailboxes').mockImplementation(async () => ({ ...message, text: 'Code 765432' }));
    initDb();
    return message;
  }

  const surfaces = ['messages', 'messages/1', 'code'];
  it.each(surfaces.flatMap(surface => ['close A', 'close both', 'restart'].map(stage => ({ surface, stage }))))
  ('keeps $surface denied after overlapping leases $stage', async ({ surface, stage }) => {
    seed(true);
    const read = (owner: string) => app.request(`/api/inbox/imap-history-${owner}/${surface}`, { headers: authHeaders(`history-${owner}`) });
    expect((await read('a')).status).toBe(404);
    expect((await read('b')).status).toBe(404);
    expect((await app.request('/api/inbox/imap-history-a', { method: 'DELETE', headers: authHeaders('history-a') })).status).toBe(200);
    if (stage !== 'close A') expect((await app.request('/api/inbox/imap-history-b', { method: 'DELETE', headers: authHeaders('history-b') })).status).toBe(200);
    if (stage === 'restart') { getDb().close(); initDb(); }
    for (const owner of ['a', 'b']) {
      const response = await read(owner);
      // Closed /code retains its existing empty-result contract when polling
      // cannot proceed. It must not recover a code from the ambiguous history.
      const closedCode = surface === 'code' && (owner === 'a' || stage !== 'close A');
      expect(response.status).toBe(closedCode ? 200 : 404);
      expect(await response.json()).toEqual(closedCode
        ? { codes: [], email: null, messageId: null, receivedAt: null }
        : { error: 'Message not found' });
    }
    expect(imapCore.fetchMessagesAcrossMailboxes).not.toHaveBeenCalled();
    expect(imapCore.fetchMessageDetailAcrossMailboxes).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM inboxes WHERE provider = 'imap'").get()).toEqual({ count: 2 });
  });

  it.each(surfaces.flatMap(surface => ['closed', 'expired active'].map(end => ({ surface, end }))))
  ('preserves adjacent reuse and normal $end history for $surface after restart', async ({ surface, end }) => {
    const message = seed(false, end === 'expired active');
    getDb().close(); initDb();
    for (const owner of ['a', 'b']) {
      message.receivedAt = owner === 'a' ? '2026-07-26T14:00:30Z' : '2026-07-26T14:01:30Z';
      const response = await app.request(`/api/inbox/imap-history-${owner}/${surface}`, { headers: authHeaders(`history-${owner}`) });
      expect(response.status).toBe(200);
      const body = await response.json();
      if (surface === 'messages') expect(body.messages).toHaveLength(1);
      else if (surface === 'code') expect(body.codes).toEqual(expect.arrayContaining([expect.objectContaining({ value: '765432' })]));
      else expect(body.text).toBe('Code 765432');
    }
  });
});
