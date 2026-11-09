import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { canonicalImapAddress, getDb, initDb, IMAP_ADDRESS_KEY_SQL } from '../src/db.js';
import { config } from '../src/config.js';
import { hashApiKey } from '../src/crypto.js';
import { assertTestPath } from './helpers/test-storage.js';
import * as usernames from '../src/username-generator.js';
import * as utils from '../src/utils.js';
import { ImapProvider, generateUniqueUsername } from '../src/providers/imap.js';
import * as imapProvider from '../src/providers/imap.js';
import { MessageNotFoundError } from '../src/errors.js';
import {
  decodeBody,
  decodeMailboxMessageId,
  describeImapError,
  encodeMailboxMessageId,
  fetchMessageDetail,
  fetchMessageDetailAcrossMailboxes,
  fetchMessagesAcrossMailboxes,
  fetchMessagesBySearch,
  selectBodyParts,
} from '../src/providers/imap-core.js';
import { randomUsername } from '../src/username-generator.js';
import type { InboxData } from '../src/providers/base.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';

const JUNK_PATH = '垃圾邮件';

const imapMockState = vi.hoisted(() => ({
  connectCount: 0,
  searchResult: [] as number[],
  // The receiving server's spam folder. Empty by default so every case that
  // predates junk support keeps describing an INBOX-only mailbox.
  junkSearchResult: [] as number[],
  lockPaths: [] as string[],
  fetchRanges: [] as number[][],
  searches: [] as Record<string, unknown>[],
  // Ordinary fixtures belong to x; isolation cases override these explicitly.
  envelopeTo: undefined as { address: string }[] | undefined,
  envelopeCc: undefined as { address: string }[] | undefined,
  omitEnvelope: false,
  missingUids: [] as string[],
  // getMessage fixtures
  bodyStructure: undefined as unknown,
  partContents: {} as Record<string, { content: Buffer; charset?: string }>,
  downloadCalls: [] as string[],
  envelopeDate: '2020-01-01T00:00:00.000Z',
  internalDate: '2026-07-26T21:03:47.000Z',
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    private selected = 'INBOX';
    async connect(): Promise<void> {
      imapMockState.connectCount++;
    }
    once(): void {}
    async logout(): Promise<void> {}
    async list(): Promise<Array<{ path: string; specialUse?: string }>> {
      return [
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: '就職', specialUse: undefined },
        { path: '垃圾邮件', specialUse: '\\Junk' },
      ];
    }
    async getMailboxLock(path = 'INBOX'): Promise<{ release(): void }> {
      this.selected = path;
      imapMockState.lockPaths.push(path);
      return { release() {} };
    }
    async search(criteria: Record<string, unknown>): Promise<number[]> {
      imapMockState.searches.push(criteria);
      return this.selected === '垃圾邮件'
        ? [...imapMockState.junkSearchResult]
        : [...imapMockState.searchResult];
    }
    async *fetch(range: number[]): AsyncGenerator<unknown> {
      imapMockState.fetchRanges.push(range);
      for (const uid of range) {
        yield {
          uid,
          internalDate: new Date(imapMockState.internalDate),
          envelope: imapMockState.omitEnvelope ? undefined : {
            from: [{ address: 'sender@example.test' }],
            to: imapMockState.envelopeTo,
            cc: imapMockState.envelopeCc,
            subject: `mail-${uid}`,
            date: new Date(imapMockState.envelopeDate),
          },
        };
      }
    }
    async fetchOne(id: string, query: Record<string, unknown>): Promise<unknown> {
      // Requesting fixed body parts is the defect this suite locks out: a part
      // that does not exist fails the entire FETCH, not just that part.
      if (query?.bodyParts) throw new Error('Command failed');
      if (imapMockState.bodyStructure === undefined || imapMockState.missingUids.includes(id)) return undefined;
      return {
        uid: 1,
        internalDate: new Date(imapMockState.internalDate),
        envelope: imapMockState.omitEnvelope ? undefined : {
          from: [{ address: 'sender@example.test' }],
          to: imapMockState.envelopeTo,
          cc: imapMockState.envelopeCc,
          subject: 'probe',
          date: new Date(imapMockState.envelopeDate),
        },
        bodyStructure: imapMockState.bodyStructure,
      };
    }
    async download(_range: string, part: string): Promise<{ meta: { charset?: string }; content: AsyncIterable<Buffer> }> {
      imapMockState.downloadCalls.push(part);
      const found = imapMockState.partContents[part];
      if (!found) throw new Error('Command failed');
      return {
        meta: { charset: found.charset },
        content: (async function* () { yield found.content; })(),
      };
    }
    async mailboxOpen(): Promise<void> {}
  }
  return { ImapFlow: FakeImapFlow };
});

function imapInbox(accountId: string, address: string): InboxData {
  return { address, authData: { imapAccountId: accountId, username: 'x', domain: 'example.com' }, provider: 'imap', apiBase: '' };
}

it('keeps IMAP connection errors out of activity and process logs while returning the admin diagnostic', async () => {
  const marker = 'opaque-imap-password-95';
  getDb().prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('log-safe-imap', 'imap.test', 993, 'user', ?, 'example.test')`).run(marker);
  const testSpy = vi.spyOn(imapProvider, 'testImapConnection').mockResolvedValue({ ok: false, error: marker });
  const output: string[] = [];
  const spies = [process.stdout, process.stderr].map(stream => vi.spyOn(stream, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; }));
  try {
    const response = await app.request('/api/imap/accounts/log-safe-imap/test', { method: 'POST', headers: jsonHeaders(), body: '{}' });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ ok: false });
    expect(data.error).toContain(marker);
    const activity = getDb().prepare('SELECT text FROM activity_log').all() as { text: string }[];
    expect(activity).toEqual([{ text: 'IMAP connection test FAILED for account log-safe-imap' }]);
    expect(output.join('') + JSON.stringify(activity)).not.toContain(marker);
  } finally { spies.forEach(spy => spy.mockRestore()); testSpy.mockRestore(); }
});

// envelopeTo is module-level mock state. Resetting it inside a test body only
// runs when that test's assertions pass, so one real failure would pin the
// recipient for every later test and bury the cause in a cascade.
beforeEach(() => {
  imapMockState.envelopeTo = [{ address: 'x@example.com' }];
  imapMockState.envelopeCc = undefined;
  imapMockState.omitEnvelope = false;
  imapMockState.missingUids = [];
  imapMockState.searches = [];
  imapMockState.downloadCalls = [];
  imapMockState.envelopeDate = '2020-01-01T00:00:00.000Z';
  imapMockState.internalDate = '2026-07-26T21:03:47.000Z';
  imapMockState.searchResult = [];
  imapMockState.junkSearchResult = [];
  imapMockState.lockPaths = [];
});

const RECIPIENT_CASES = [
  { name: 'exact To', to: ['bob.smith4@example.com'], allowed: true },
  { name: 'case-insensitive To', to: ['BOB.SMITH4@EXAMPLE.COM'], allowed: true },
  { name: 'exact Cc', to: ['other@example.com'], cc: ['bob.smith4@example.com'], allowed: true },
  { name: 'case-insensitive Cc', cc: ['BOB.SMITH4@EXAMPLE.COM'], allowed: true },
  { name: 'another tenant in To', to: ['bob.smith42@example.com'], allowed: false },
  { name: 'another tenant in Cc', cc: ['bob.smith42@example.com'], allowed: false },
  { name: 'missing recipients', allowed: false },
  { name: 'empty recipients', to: [], cc: [], allowed: false },
  { name: 'missing envelope', omitEnvelope: true, allowed: false },
] satisfies { name: string; to?: string[]; cc?: string[]; omitEnvelope?: boolean; allowed: boolean }[];

function setRecipients(c: { to?: string[]; cc?: string[]; omitEnvelope?: boolean }): void {
  imapMockState.envelopeTo = c.to?.map((address) => ({ address }));
  imapMockState.envelopeCc = c.cc?.map((address) => ({ address }));
  imapMockState.omitEnvelope = c.omitEnvelope ?? false;
}

describe('ImapProvider polling', () => {
  // A supplied scope is never an administrator whole-mailbox request. These
  // entries also cover direct helpers and junk discovery before connection.
  it.each([
    { label: 'strict missing', recipient: undefined, strictRecipient: true },
    { label: 'strict empty', recipient: '', strictRecipient: true },
    { label: 'strict whitespace', recipient: ' \t\n', strictRecipient: true },
    { label: 'explicit empty', recipient: '', strictRecipient: false },
    { label: 'explicit whitespace', recipient: ' \t\n', strictRecipient: false },
  ].flatMap(scope => ['list direct', 'detail direct', 'list across', 'detail INBOX', 'detail Junk'].map(entry => ({ ...scope, entry }))))
  ('rejects invalid recipient scope before transport: $label / $entry', async ({ recipient, strictRecipient, entry }) => {
    imapMockState.searchResult = [1];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('private Code: 654321') } };
    const creds = { poolKey: `invalid-scope:${strictRecipient}:${recipient}:${entry}`, host: 'mock.invalid', port: 993, user: 'local', password: 'local', tls: true };
    const opts = { recipient, strictRecipient };
    const before = imapMockState.connectCount;
    const result = entry === 'list direct' ? fetchMessagesBySearch(creds, { all: true }, opts)
      : entry === 'detail direct' ? fetchMessageDetail(creds, '1', opts)
      : entry === 'list across' ? fetchMessagesAcrossMailboxes(creds, { all: true }, opts)
      : fetchMessageDetailAcrossMailboxes(creds, encodeMailboxMessageId(entry === 'detail Junk' ? JUNK_PATH : 'INBOX', '1'), opts);
    await expect(result).rejects.toThrow(MessageNotFoundError);
    expect(imapMockState.connectCount).toBe(before);
    expect(imapMockState.lockPaths).toEqual([]);
    expect(imapMockState.searches).toEqual([]);
    expect(imapMockState.downloadCalls).toEqual([]);
  });

  it('keeps omitted recipient scope available for administrator whole-mailbox helpers', async () => {
    imapMockState.searchResult = [1];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('private Code: 654321') } };
    const creds = { poolKey: 'omitted-scope-admin', host: 'mock.invalid', port: 993, user: 'local', password: 'local', tls: true };
    expect(await fetchMessagesBySearch(creds, { all: true })).toHaveLength(1);
    expect((await fetchMessageDetail(creds, '1')).text).toBe('private Code: 654321');
    expect(await fetchMessagesAcrossMailboxes(creds, { all: true })).toHaveLength(1);
    expect((await fetchMessageDetailAcrossMailboxes(creds, encodeMailboxMessageId(JUNK_PATH, '1'))).text).toBe('private Code: 654321');
  });

  it.each(['', ' \t\n'].flatMap(address => ['messages', 'messages/1', 'code'].map(path => ({ address, path }))))
  ('rejects a blank legacy catch-all scope through the tenant $path route: $address', async ({ address, path }) => {
    const owner = 'empty-scope-owner';
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, 'scope owner')`).run(hashApiKey(owner));
    getDb().prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain)
      VALUES ('blank-scope-account', 'mock.invalid', 993, 'local', 'local', 'example.com')`).run();
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data, owner_key, created_at)
      VALUES ('blank-scope-inbox', 'imap', ?, ?, ?, datetime('now', '-1 minute'))`)
      .run(address, JSON.stringify({ imapAccountId: 'blank-scope-account' }), hashApiKey(owner));
    imapMockState.internalDate = new Date().toISOString();
    imapMockState.searchResult = [1];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('private Code: 654321') } };
    const before = imapMockState.connectCount;
    const response = await app.request(`/api/inbox/blank-scope-inbox/${path}`, { headers: authHeaders(owner) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Message not found' });
    expect(imapMockState.connectCount).toBe(before);
    expect(imapMockState.downloadCalls).toEqual([]);
  });

  it('uses IMAP internalDate instead of a conflicting envelope date for list and detail', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('internal-date', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [1];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('body') } };

    const provider = new ImapProvider();
    const inbox = imapInbox('internal-date', 'x@example.com');
    const listed = await provider.getMessages(inbox);
    const detail = await provider.getMessage(inbox, '1');

    expect(listed[0].receivedAt).toBe(imapMockState.internalDate);
    expect(detail.receivedAt).toBe(imapMockState.internalDate);
    expect(listed[0].receivedAt).not.toBe(imapMockState.envelopeDate);
    expect(detail.receivedAt).not.toBe(imapMockState.envelopeDate);
  });

  it('fetches only the newest messages in one batched fetch call', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('pool-limit', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = Array.from({ length: 30 }, (_, i) => i + 1);
    imapMockState.fetchRanges = [];

    const p = new ImapProvider();
    const messages = await p.getMessages(imapInbox('pool-limit', 'x@example.com'));

    expect(messages).toHaveLength(20);
    // Oldest first, the order the SPA reverses to show newest at the top.
    expect(decodeMailboxMessageId(messages[0].id)).toEqual({ mailbox: 'INBOX', uid: '11' });
    expect(decodeMailboxMessageId(messages[19].id)).toEqual({ mailbox: 'INBOX', uid: '30' });
    expect(imapMockState.fetchRanges).toHaveLength(1);
    expect(imapMockState.fetchRanges[0]).toHaveLength(20);
  });

  it('shares one connection across concurrent polls of the same account', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('pool-share', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [1];
    imapMockState.envelopeTo = [{ address: 'y@example.com' }];
    const before = imapMockState.connectCount;

    const p = new ImapProvider();
    const inbox = imapInbox('pool-share', 'y@example.com');
    await Promise.all([p.getMessages(inbox), p.getMessages(inbox)]);

    expect(imapMockState.connectCount - before).toBe(1);
  });

  it.each(RECIPIENT_CASES)('lists only verifiably addressed catch-all mail: $name', async (c) => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('substr', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [1];
    imapMockState.junkSearchResult = [2];
    setRecipients(c);

    const p = new ImapProvider();
    const messages = await p.getMessages(imapInbox('substr', 'bob.smith4@example.com'));

    // SEARCH is a substring prefilter, while To/Cc prove tenant ownership.
    // The old sparse-envelope assertion exposed private mail to every tenant
    // sharing the catch-all, so missing evidence must now exclude the mail.
    expect(messages.map((message) => message.id)).toEqual(c.allowed ? [
      encodeMailboxMessageId('INBOX', '1'), encodeMailboxMessageId(JUNK_PATH, '2'),
    ] : []);
    expect(imapMockState.searches).toEqual([
      { or: [{ to: 'bob.smith4@example.com' }, { cc: 'bob.smith4@example.com' }] },
      { or: [{ to: 'bob.smith4@example.com' }, { cc: 'bob.smith4@example.com' }] },
    ]);
  });

  it.each(RECIPIENT_CASES)('independently verifies guessed catch-all detail ids: $name', async (c) => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('detail-leak', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('code 123456') } };
    setRecipients(c);

    // Filtering the listing is not enough: a UID names a message in the whole
    // catch-all mailbox. Bcc-only or sparse envelopes cannot identify which
    // tenant owns the body; the old fail-open assertion leaked that body.
    const p = new ImapProvider();
    for (const id of ['1', encodeMailboxMessageId('INBOX', '1'), encodeMailboxMessageId(JUNK_PATH, '1')]) {
      const result = p.getMessage(imapInbox('detail-leak', 'bob.smith4@example.com'), id);
      if (c.allowed) await expect(result).resolves.toMatchObject({ id, text: 'code 123456' });
      else await expect(result).rejects.toThrow(MessageNotFoundError);
    }
    expect(imapMockState.downloadCalls).toHaveLength(c.allowed ? 3 : 0);
  });

  // Production, 2026-08-23: four aliases received verification codes with the
  // code in the subject line, and Gmail filed all four under 垃圾邮件. The
  // provider read INBOX only, every poll reported an empty mailbox, and the
  // caller gave up while the codes sat there unread. Forwarding into a mailbox
  // the sender does not own breaks DMARC alignment by construction, so junked
  // verification mail is the ordinary case rather than a freak one.
  it('reads a verification mail the receiving server filed under Junk', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('junk-listing', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [];
    imapMockState.junkSearchResult = [9];
    imapMockState.envelopeTo = [{ address: 'spam.filed@example.com' }];

    const messages = await new ImapProvider().getMessages(imapInbox('junk-listing', 'spam.filed@example.com'));

    expect(messages).toHaveLength(1);
    expect(decodeMailboxMessageId(messages[0].id)).toEqual({ mailbox: JUNK_PATH, uid: '9' });
    expect(imapMockState.lockPaths).toEqual(['INBOX', JUNK_PATH]);
  });

  it('reads a junk message body from the folder its id names', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('junk-detail', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.junkSearchResult = [9];
    imapMockState.envelopeTo = [{ address: 'spam.filed@example.com' }];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('code 448271') } };

    const provider = new ImapProvider();
    const inbox = imapInbox('junk-detail', 'spam.filed@example.com');
    const [listed] = await provider.getMessages(inbox);
    imapMockState.lockPaths = [];

    const detail = await provider.getMessage(inbox, listed.id);

    expect(detail.text).toBe('code 448271');
    // A bare UID would have opened INBOX and served whatever uid 9 is there.
    expect(imapMockState.lockPaths).toEqual([JUNK_PATH]);
    expect(detail.id).toBe(listed.id);
  });

  it('refuses a message id naming a folder the listing never reads', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('folder-escape', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('private mail') } };

    // The shared mailbox behind iCloud is the operator's own account, whose
    // other folders hold their personal mail. An id arrives straight off the
    // request path, so the mailbox it names is checked, not trusted.
    await expect(
      new ImapProvider().getMessage(imapInbox('folder-escape', 'x@example.com'), encodeMailboxMessageId('就職', '7')),
    ).rejects.toThrow(/Invalid IMAP message id/);
    expect(imapMockState.lockPaths).toEqual([]);
  });

  it.each([
    ['bare UID', '1', '999'],
    ['INBOX-qualified UID', encodeMailboxMessageId('INBOX', '1'), encodeMailboxMessageId('INBOX', '999')],
    ['junk-qualified UID', encodeMailboxMessageId(JUNK_PATH, '1'), encodeMailboxMessageId(JUNK_PATH, '999')],
  ])('reports unverifiable recipients exactly like an unknown UID: %s', async (_name, id, unknownId) => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('detail-oracle', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.partContents = { '1': { content: Buffer.from('private code 654321') } };
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.missingUids = ['999'];

    const p = new ImapProvider();
    const inbox = imapInbox('detail-oracle', 'bob.smith4@example.com');

    const absent: unknown = await p.getMessage(inbox, unknownId).catch((error: unknown) => error);
    expect(absent).toBeInstanceOf(MessageNotFoundError);

    // Distinguishing the two would turn the endpoint into an oracle for which
    // UIDs are live in the shared mailbox.
    for (const c of RECIPIENT_CASES.filter((entry) => !entry.allowed)) {
      setRecipients(c);
      const forbidden: unknown = await p.getMessage(inbox, id).catch((error: unknown) => error);
      expect(forbidden).toBeInstanceOf(MessageNotFoundError);
      expect(forbidden).toMatchObject({ name: 'MessageNotFoundError', message: (absent as Error).message });
    }
    expect(imapMockState.downloadCalls).toEqual([]);
  });
});

describe('ImapProvider', () => {
  it('has correct meta', () => {
    const p = new ImapProvider();
    expect(p.meta.name).toBe('imap');
    expect(p.meta.type).toBe('api');
    expect(p.meta.trustLevel).toBe(10);
    expect(p.meta.features.pollInbox).toBe(true);
    expect(p.meta.features.customUsername).toBe(true);
  });

  it('returns empty domains when no accounts configured', async () => {
    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).toEqual([]);
  });

  it('throws on createInbox when no accounts configured', async () => {
    const p = new ImapProvider();
    await expect(p.createInbox()).rejects.toThrow('No active IMAP accounts configured');
  });

  it('returns domains from active accounts', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).toContain('example.com');
  });

  it('createInbox generates address under account domain', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const inbox = await p.createInbox({ domain: 'example.com' });
    // Contract changed on purpose: generated usernames are now human-shaped
    // (mark.reyes52 / d_watson91 / juliahoffman), so the old flat [a-z0-9]+
    // pattern no longer describes a correct address.
    expect(inbox.address).toMatch(/^[a-z]+([._][a-z]+)?[0-9]{0,2}@example\.com$/);
    expect(inbox.provider).toBe('imap');
    expect(inbox.authData.imapAccountId).toBe('t1');
    expect(inbox.authData.domain).toBe('example.com');
    expect(inbox.authData.password).toBeUndefined();
    expect(inbox.authData.host).toBeUndefined();
  });

  it('createInbox supports custom username', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const inbox = await p.createInbox({ domain: 'example.com', username: 'testuser' });
    expect(inbox.address).toBe('testuser@example.com');
  });

  it('inactive accounts are excluded from domains', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain, status) VALUES ('t2', 'imap2.test.com', 993, 'u2', 'p2', 'disabled.com', 'inactive')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).not.toContain('disabled.com');
    expect(domains).toContain('example.com');
  });

  it('deduplicates domains from multiple accounts', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t3', 'imap3.test.com', 993, 'u3', 'p3', 'example.com')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    const exampleCount = domains.filter(d => d === 'example.com').length;
    expect(exampleCount).toBe(1);
  });
});

// Structures observed on real mail through Cloudflare Email Routing -> Gmail.
// The previous implementation hardcoded bodyParts ['1','2'], which 502'd on
// single-part mail and, under multipart/mixed, returned raw MIME as the text
// and an attachment's payload as the html.
const STRUCTURE_CASES = [
  {
    name: 'single-part text/plain reads part 1 and never asks for a part that does not exist',
    structure: { type: 'text/plain', parameters: { charset: 'utf-8' } },
    parts: { '1': { content: Buffer.from('Your verification code is 483920\r\n'), charset: 'utf-8' } },
    expectText: 'Your verification code is 483920\r\n',
    expectHtml: undefined,
    expectDownloads: ['1'],
  },
  {
    name: 'single-part text/html maps the whole body to html',
    structure: { type: 'text/html', parameters: { charset: 'utf-8' } },
    parts: { '1': { content: Buffer.from('<p>code 111222</p>'), charset: 'utf-8' } },
    expectText: undefined,
    expectHtml: '<p>code 111222</p>',
    expectDownloads: ['1'],
  },
  {
    name: 'multipart/alternative reads text from 1 and html from 2',
    structure: {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', parameters: { charset: 'utf-8' } },
        { part: '2', type: 'text/html', parameters: { charset: 'utf-8' } },
      ],
    },
    parts: {
      '1': { content: Buffer.from('code 751634'), charset: 'utf-8' },
      '2': { content: Buffer.from('<b>code 751634</b>'), charset: 'utf-8' },
    },
    expectText: 'code 751634',
    expectHtml: '<b>code 751634</b>',
    expectDownloads: ['1', '2'],
  },
  {
    name: 'multipart/mixed reads the nested 1.1/1.2 and skips the attachment at 2',
    structure: {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', parameters: { charset: 'utf-8' } },
            { part: '1.2', type: 'text/html', parameters: { charset: 'utf-8' } },
          ],
        },
        { part: '2', type: 'text/plain', disposition: 'attachment' },
      ],
    },
    parts: {
      '1.1': { content: Buffer.from('code 206518'), charset: 'utf-8' },
      '1.2': { content: Buffer.from('<b>code 206518</b>'), charset: 'utf-8' },
      '2': { content: Buffer.from('attachment payload'), charset: 'utf-8' },
    },
    expectText: 'code 206518',
    expectHtml: '<b>code 206518</b>',
    expectDownloads: ['1.1', '1.2'],
  },
];

describe('ImapProvider.getMessage body extraction', () => {
  it.each(STRUCTURE_CASES)('$name', async (c) => {
    const accountId = `struct-${STRUCTURE_CASES.indexOf(c)}`;
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES (?, 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run(accountId);
    imapMockState.bodyStructure = c.structure;
    imapMockState.partContents = c.parts;
    imapMockState.downloadCalls = [];

    const p = new ImapProvider();
    const msg = await p.getMessage(imapInbox(accountId, 'x@example.com'), '42');

    expect(msg.text).toBe(c.expectText);
    expect(msg.html).toBe(c.expectHtml);
    expect(imapMockState.downloadCalls).toEqual(c.expectDownloads);
    // Raw MIME must never leak into the body or the excerpt.
    expect(msg.text ?? '').not.toContain('Content-Type:');
    expect(msg.excerpt).not.toContain('Content-Type:');
  });

  it('decodes a non-utf8 body using the part charset', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('charset-acct', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    // "中文" in GBK; a blind toString('utf8') turns this into mojibake.
    const gbk = Buffer.concat([Buffer.from('code 123456 '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]);
    imapMockState.bodyStructure = { type: 'text/plain', parameters: { charset: 'gbk' } };
    imapMockState.partContents = { '1': { content: gbk, charset: 'gbk' } };
    imapMockState.downloadCalls = [];

    const p = new ImapProvider();
    const msg = await p.getMessage(imapInbox('charset-acct', 'x@example.com'), '42');

    expect(msg.text).toBe('code 123456 中文');
  });
});

describe('decodeMailboxMessageId', () => {
  it.each([
    // Ids handed out before mailboxes were part of them, and UIDs an operator
    // types into the admin viewer's URL, can only ever have meant INBOX.
    ['a bare UID', '7', { mailbox: 'INBOX', uid: '7' }],
    ['a mailbox-qualified id', encodeMailboxMessageId(JUNK_PATH, '9'), { mailbox: JUNK_PATH, uid: '9' }],
    ['a mailbox whose name contains a quote', encodeMailboxMessageId('a"b', '1'), { mailbox: 'a"b', uid: '1' }],
  ])('accepts %s', (_name, id, expected) => {
    expect(decodeMailboxMessageId(id, { allowBareUid: true })).toEqual(expected);
  });

  it.each([
    // `1:*` is a SELECT-wide range: imapflow would happily fetch the newest
    // message in the mailbox for a caller who owns none of it.
    ['a UID range', encodeMailboxMessageId('INBOX', '1:*')],
    ['the UID wildcard', encodeMailboxMessageId('INBOX', '*')],
    ['a zero UID', encodeMailboxMessageId('INBOX', '0')],
    ['a UID past the 32-bit ceiling', encodeMailboxMessageId('INBOX', '4294967296')],
    ['a generation-qualified scan id without opt-in', encodeMailboxMessageId('INBOX', '7', '11')],
    ['a payload that is not JSON', 'imap:bm90LWpzb24'],
    ['a JSON payload of the wrong shape', `imap:${Buffer.from('{"mailbox":"INBOX"}').toString('base64url')}`],
    ['a bare non-numeric id', 'INBOX'],
  ])('rejects %s', (_name, id) => {
    expect(() => decodeMailboxMessageId(id, { allowBareUid: true })).toThrow(/Invalid IMAP message id/);
  });

  it('never accepts a bare UID for a provider that has always qualified its ids', () => {
    expect(() => decodeMailboxMessageId('7')).toThrow(/Invalid IMAP message id/);
  });
});

describe('selectBodyParts', () => {
  it('returns nothing for a non-text single part', () => {
    expect(selectBodyParts({ type: 'application/pdf' })).toEqual({});
  });

  it('returns nothing when every leaf is an attachment', () => {
    expect(selectBodyParts({
      type: 'multipart/mixed',
      childNodes: [{ part: '1', type: 'text/plain', disposition: 'attachment' }],
    })).toEqual({});
  });

  it('keeps the first candidate when a structure holds several text parts', () => {
    expect(selectBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/plain' },
        { part: '3', type: 'text/html' },
      ],
    })).toEqual({ text: '1', html: '3' });
  });

  it('handles a missing structure', () => {
    expect(selectBodyParts(undefined)).toEqual({});
  });
});

describe('decodeBody', () => {
  it('falls back to utf8 for an unknown charset label', () => {
    expect(decodeBody(Buffer.from('hello'), 'not-a-real-charset')).toBe('hello');
  });

  it('returns an empty string for an empty buffer', () => {
    expect(decodeBody(Buffer.alloc(0), 'utf-8')).toBe('');
  });
});

describe('randomUsername', () => {
  const SAMPLES = Array.from({ length: 3000 }, () => randomUsername());

  it.each([
    ['is a mail-safe local part', (u: string) => expect(u).toMatch(/^[a-z]+([._][a-z]+)?[0-9]{0,2}$/)],
    ['never leads with a separator', (u: string) => expect(u).not.toMatch(/^[._]/)],
    ['never trails with a separator', (u: string) => expect(u).not.toMatch(/[._]$/)],
    ['never doubles a separator', (u: string) => expect(u).not.toMatch(/[._]{2}/)],
    ['stays a plausible length', (u: string) => {
      expect(u.length).toBeGreaterThanOrEqual(4);
      expect(u.length).toBeLessThanOrEqual(24);
    }],
  ])('every sample %s', (_name, assert) => {
    for (const u of SAMPLES) assert(u);
  });

  it('mixes all three separator shapes rather than settling on one', () => {
    expect(SAMPLES.some((u) => /^[a-z]+[0-9]{0,2}$/.test(u))).toBe(true);
    expect(SAMPLES.some((u) => u.includes('.'))).toBe(true);
    expect(SAMPLES.some((u) => u.includes('_'))).toBe(true);
  });

  it('mixes full first names with single initials', () => {
    const separated = SAMPLES.filter((u) => /[._]/.test(u)).map((u) => u.split(/[._]/)[0]);
    expect(separated.some((given) => given.length === 1)).toBe(true);
    expect(separated.some((given) => given.length > 1)).toBe(true);
  });

  it('adds a digit suffix only some of the time', () => {
    const withDigits = SAMPLES.filter((u) => /[0-9]$/.test(u)).length;
    expect(withDigits).toBeGreaterThan(0);
    expect(withDigits).toBeLessThan(SAMPLES.length);
  });
});

describe('generateUniqueUsername', () => {
  afterEach(() => vi.restoreAllMocks());
  const holdAddress = (id: string, address: string, status: string): void => {
    getDb().prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, status) VALUES (?, 'imap', ?, '{}', ?)`,
    ).run(id, address, status);
  };

  it('skips a username a live inbox already holds', () => {
    holdAddress('held', 'taken@example.com', 'active');
    const draws = ['taken', 'taken', 'free'];
    let i = 0;
    expect(generateUniqueUsername('example.com', () => draws[i++])).toBe('free');
  });

  it('reuses an address once the holding inbox is closed', () => {
    holdAddress('gone', 'taken@example.com', 'closed');
    expect(generateUniqueUsername('example.com', () => 'taken')).toBe('taken');
  });

  it('only treats a collision on the same domain as a collision', () => {
    holdAddress('other', 'taken@other.com', 'active');
    expect(generateUniqueUsername('example.com', () => 'taken')).toBe('taken');
  });

  it('falls back to a random suffix when every draw collides', () => {
    holdAddress('held', 'taken@example.com', 'active');
    expect(generateUniqueUsername('example.com', () => 'taken')).toMatch(/^taken[a-z0-9]{4}$/);
  });

  it('checks suffix collisions too and stops after a finite number of draws', () => {
    holdAddress('base', 'taken@example.com', 'active');
    holdAddress('suffix', 'takenabcd@example.com', 'active');
    const suffix = vi.spyOn(utils, 'randomString').mockReturnValue('abcd');
    expect(() => generateUniqueUsername('example.com', () => 'taken')).toThrow(/conflict/i);
    expect(suffix.mock.calls.length).toBeGreaterThan(0);
    expect(suffix.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('compares canonical IMAP addresses and ignores other providers', () => {
    holdAddress('mixed', '  Taken@EXAMPLE.COM\t', 'active');
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data) VALUES ('other-provider', 'fake', 'free@example.com', '{}')`).run();
    const draws = ['TAKEN', 'FREE'];
    expect(generateUniqueUsername(' Example.COM ', () => draws.shift()!)).toBe('free');
  });
});

describe('IMAP canonical active address claims', () => {
  afterEach(() => vi.restoreAllMocks());

  const account = (): void => {
    getDb().prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('claim-account', 'imap.test', 993, 'physical-user', 'physical-password', ' Example.COM ')`).run();
  };
  const hold = (id: string, provider: string, address: string, status = 'active'): void => {
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data, status) VALUES (?, ?, ?, '{}', ?)`).run(id, provider, address, status);
  };

  it('canonicalizes specified and generated usernames and operator domains without changing credentials', async () => {
    account();
    const provider = new ImapProvider();
    expect(await provider.getDomains()).toEqual(['example.com']);
    const specified = await provider.createInbox({ username: '  Alice  ', domain: ' EXAMPLE.COM ' });
    expect(specified).toMatchObject({ address: 'alice@example.com', authData: { username: 'alice', domain: 'example.com', imapAccountId: 'claim-account' } });
    vi.spyOn(usernames, 'randomUsername').mockReturnValue('  BoB  ');
    expect((await provider.createInbox()).address).toBe('bob@example.com');
    expect(getDb().prepare(`SELECT user, password, domain FROM imap_accounts`).get()).toEqual({ user: 'physical-user', password: 'physical-password', domain: ' Example.COM ' });
  });

  it.each(['', '  ', 'a@b', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u001fb', 'a\u007fb', null, false, 0, {}, [], undefined].map((username) => ({ username })))('rejects invalid provided username $username', async ({ username }) => {
    account();
    await expect(new ImapProvider().createInbox({ username } as { username: string })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects canonical INSERT and address/provider/status UPDATE collisions only for active IMAP rows', () => {
    hold('first', 'imap', '  Alice@EXAMPLE.COM\t');
    expect(() => hold('second', 'imap', 'alice@example.com')).toThrow(/IMAP.*conflict/i);
    hold('other', 'fake', 'alice@example.com');
    hold('closed', 'imap', 'alice@example.com', 'closed');
    hold('rename', 'imap', 'free@example.com');
    for (const sql of [
      `UPDATE inboxes SET provider = 'imap' WHERE id = 'other'`,
      `UPDATE inboxes SET status = 'active' WHERE id = 'closed'`,
      `UPDATE inboxes SET address = 'ALICE@EXAMPLE.COM' WHERE id = 'rename'`,
    ]) expect(() => getDb().exec(sql)).toThrow(/IMAP.*conflict/i);
    getDb().exec(`UPDATE inboxes SET status = 'closed' WHERE id = 'first'`);
    getDb().exec(`UPDATE inboxes SET status = 'active' WHERE id = 'closed'`);
    expect(getDb().prepare(`SELECT status FROM inboxes WHERE id = 'closed'`).get()).toEqual({ status: 'active' });
    hold('non-imap-duplicate', 'fake', 'alice@example.com');
  });

  it.each([' ', '\t\n', '\u00a0', '\u2000\u200a', '\u2028\u2029', '\u202f', '\u3000', '\ufeff'])('compares legacy domain padding %j identically in JS and SQLite', (padding) => {
    const address = `${padding}ALICE${padding}@${padding}Example.COM${padding}`;
    expect(canonicalImapAddress(address)).toBe('alice@example.com');
    hold('legacy-padded', 'imap', address);
    expect(getDb().prepare(`SELECT ${IMAP_ADDRESS_KEY_SQL} AS address FROM inboxes WHERE id = 'legacy-padded'`).get()).toEqual({ address: 'alice@example.com' });
    expect(() => hold('canonical', 'imap', 'alice@example.com')).toThrow(/conflict/i);
  });

  it('reads a single legacy address with domain padding using the canonical recipient', async () => {
    account();
    hold('padded-single', 'imap', ' Alice@ Example.COM ');
    imapMockState.searchResult = [1];
    imapMockState.envelopeTo = [{ address: 'alice@example.com' }];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('body') } };
    const inbox = imapInbox('claim-account', ' Alice@ Example.COM ');
    const provider = new ImapProvider();
    expect(await provider.getMessages(inbox)).toHaveLength(1);
    expect((await provider.getMessage(inbox, '1')).text).toBe('body');
  });

  // Two legitimate owners may claim these distinct SQLite identities. Each
  // owner's list, guessed detail and code must use that same identity rule.
  it.each([
    ['ASCII To', ['K@EXAMPLE.COM'], undefined, 'ascii'],
    ['Unicode To', ['\u212A@EXAMPLE.COM'], undefined, 'unicode'],
    ['ASCII Cc', ['other@example.com'], ['K@EXAMPLE.COM'], 'ascii'],
    ['Unicode Cc', ['other@example.com'], ['\u212A@EXAMPLE.COM'], 'unicode'],
  ] as const)('keeps two owners with distinct Unicode claims isolated: %s', async (_name, to, cc, recipientOwner) => {
    account();
    const claims = [] as Array<{ id: string; address: string; owner: string }>;
    for (const [owner, username] of [['ascii', 'k'], ['unicode', '\u212A']]) {
      const key = `fold-owner-${owner}`;
      getDb().prepare('INSERT INTO api_keys (key, name) VALUES (?, ?)').run(hashApiKey(key), owner);
      const response = await app.request('/api/inbox', {
        method: 'POST', headers: jsonHeaders(key),
        body: JSON.stringify({ for: 'target.test', provider: 'imap', username }),
      });
      expect(response.status).toBe(201);
      claims.push({ ...await response.json() as { id: string; address: string }, owner });
    }
    expect(claims.map((claim) => claim.address)).toEqual(['k@example.com', '\u212A@example.com']);
    expect(getDb().prepare(`SELECT ${IMAP_ADDRESS_KEY_SQL} AS address FROM inboxes ORDER BY address`).all())
      .toEqual([{ address: 'k@example.com' }, { address: '\u212A@example.com' }]);
    getDb().exec(`UPDATE inboxes SET created_at = datetime('now', '-1 minute')`);
    imapMockState.internalDate = new Date().toISOString();
    imapMockState.searchResult = [1];
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('Code: 123456') } };
    setRecipients({ to: [...to], cc: cc ? [...cc] : undefined });

    for (const claim of claims) {
      const allowed = claim.owner === recipientOwner;
      const headers = jsonHeaders(`fold-owner-${claim.owner}`);
      const downloadsBefore = imapMockState.downloadCalls.length;
      const list = await app.request(`/api/inbox/${claim.id}/messages`, { headers });
      expect(list.status).toBe(200);
      expect((await list.json() as { messages: unknown[] }).messages).toHaveLength(allowed ? 1 : 0);
      const detail = await app.request(`/api/inbox/${claim.id}/messages/1`, { headers });
      expect(detail.status).toBe(allowed ? 200 : 404);
      const code = await app.request(`/api/inbox/${claim.id}/code`, { headers });
      expect(code.status).toBe(200);
      expect(await code.json()).toMatchObject(allowed
        ? { codes: expect.arrayContaining([expect.objectContaining({ value: '123456' })]) }
        : { codes: [], email: null, messageId: null });
      if (!allowed) expect(imapMockState.downloadCalls).toHaveLength(downloadsBefore);
    }
  });

  it.each(['active', 'closed', 'restart'])('preserves legacy duplicate lease isolation when %s before upstream access', async stage => {
    account();
    getDb().close();
    // Only this suite's isolated DB is opened before initDb installs guards.
    const legacy = new Database(assertTestPath(config.dbPath));
    legacy.exec(`DROP TRIGGER IF EXISTS imap_active_address_insert; DROP TRIGGER IF EXISTS imap_active_address_update;`);
    const insert = legacy.prepare(`INSERT INTO inboxes (id, provider, address, auth_data) VALUES (?, 'imap', ?, '{}')`);
    insert.run('legacy-a', ' Alice@ Example.COM ');
    insert.run('legacy-b', 'alice@example.com');
    legacy.exec("UPDATE inboxes SET created_at = '2026-07-26 14:00:00' WHERE id = 'legacy-a'; UPDATE inboxes SET created_at = '2026-07-26 14:01:00' WHERE id = 'legacy-b';");
    legacy.close();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    initDb();
    spy.mockRestore();
    const warning = output.map((line) => JSON.parse(line)).find((entry) => entry.msg === 'ambiguous active IMAP addresses');
    expect(warning).toMatchObject({ groupCount: 1, inboxCount: 2, groups: [{ address: 'alice@example.com', count: 2, inboxIds: ['legacy-a', 'legacy-b'] }] });
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM inboxes`).get()).toEqual({ count: 2 });
    getDb().exec(`UPDATE inboxes SET owner_key = 'changed', target_service = 'updated' WHERE id = 'legacy-a'`);
    const before = imapMockState.connectCount;
    const provider = new ImapProvider();
    const inbox = imapInbox('claim-account', 'alice@example.com');
    await expect(provider.getMessages(inbox)).rejects.toThrow('Message not found');
    await expect(provider.getMessage(inbox, '1')).rejects.toThrow('Message not found');
    if (stage !== 'active') {
      getDb().prepare("UPDATE inboxes SET status = 'closed', closed_at = '2026-07-26 14:02:00' WHERE id = 'legacy-a'").run();
      if (stage === 'restart') { getDb().close(); initDb(); }
      for (const id of ['legacy-a', 'legacy-b']) {
        const lease = { ...inbox, authData: { ...inbox.authData, inboxId: id } };
        await expect(provider.getMessages(lease)).rejects.toThrow('Message not found');
        await expect(provider.getMessage(lease, '1')).rejects.toThrow('Message not found');
      }
    }
    expect(imapMockState.connectCount).toBe(before);
    expect(() => hold('third', 'imap', 'alice@example.com')).toThrow(/conflict/i);
    getDb().exec(`UPDATE inboxes SET status = 'closed' WHERE id = 'legacy-a'`);
    getDb().exec(`UPDATE inboxes SET status = 'closed' WHERE id = 'legacy-b'`);
    hold('new-claim', 'imap', 'alice@example.com');
  });
});

describe('describeImapError', () => {
  it('surfaces the server text rather than the bare Command failed imapflow reports', () => {
    // Observed against imap.mail.me.com with a bad app-specific password:
    // the message is always "Command failed" and every useful word is on the
    // sibling fields, so an operator was told nothing at all.
    const err = Object.assign(new Error('Command failed'), {
      responseText: 'Authentication Failed',
      responseStatus: 'NO',
      serverResponseCode: 'AUTHENTICATIONFAILED',
      authenticationFailed: true,
    });

    expect(describeImapError(err)).toBe('authentication rejected: Authentication Failed [AUTHENTICATIONFAILED]');
  });

  it('does not label a non-auth rejection as an auth failure', () => {
    const err = Object.assign(new Error('Command failed'), {
      responseText: 'Mailbox does not exist',
      responseStatus: 'NO',
    });

    expect(describeImapError(err)).toBe('Mailbox does not exist');
  });

  it('falls back to the plain message when nothing extra is attached', () => {
    expect(describeImapError(new Error('getaddrinfo ENOTFOUND imap.bad.host'))).toBe('getaddrinfo ENOTFOUND imap.bad.host');
    expect(describeImapError('boom')).toBe('boom');
  });
});
