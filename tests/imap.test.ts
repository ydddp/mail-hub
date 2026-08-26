import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDb } from '../src/db.js';
import { ImapProvider, generateUniqueUsername } from '../src/providers/imap.js';
import {
  decodeBody,
  decodeMailboxMessageId,
  describeImapError,
  encodeMailboxMessageId,
  selectBodyParts,
} from '../src/providers/imap-core.js';
import { randomUsername } from '../src/username-generator.js';
import type { InboxData } from '../src/providers/base.js';

const JUNK_PATH = '垃圾邮件';

const imapMockState = vi.hoisted(() => ({
  connectCount: 0,
  searchResult: [] as number[],
  // The receiving server's spam folder. Empty by default so every case that
  // predates junk support keeps describing an INBOX-only mailbox.
  junkSearchResult: [] as number[],
  lockPaths: [] as string[],
  fetchRanges: [] as number[][],
  // Recipients the fake reports on every fetched message. Defaults to
  // undefined, which the provider must treat as "cannot verify, keep".
  envelopeTo: undefined as { address: string }[] | undefined,
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
    async search(): Promise<number[]> {
      return this.selected === '垃圾邮件'
        ? [...imapMockState.junkSearchResult]
        : [...imapMockState.searchResult];
    }
    async *fetch(range: number[]): AsyncGenerator<{ uid: number; internalDate: Date; envelope: { from: { address: string }[]; to?: { address: string }[]; subject: string; date: Date } }> {
      imapMockState.fetchRanges.push(range);
      for (const uid of range) {
        yield {
          uid,
          internalDate: new Date(imapMockState.internalDate),
          envelope: {
            from: [{ address: 'sender@example.test' }],
            to: imapMockState.envelopeTo,
            subject: `mail-${uid}`,
            date: new Date(imapMockState.envelopeDate),
          },
        };
      }
    }
    async fetchOne(_id: string, query: Record<string, unknown>): Promise<unknown> {
      // Requesting fixed body parts is the defect this suite locks out: a part
      // that does not exist fails the entire FETCH, not just that part.
      if (query?.bodyParts) throw new Error('Command failed');
      if (imapMockState.bodyStructure === undefined) return undefined;
      return {
        uid: 1,
        internalDate: new Date(imapMockState.internalDate),
        envelope: {
          from: [{ address: 'sender@example.test' }],
          to: imapMockState.envelopeTo,
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

// envelopeTo is module-level mock state. Resetting it inside a test body only
// runs when that test's assertions pass, so one real failure would pin the
// recipient for every later test and bury the cause in a cascade.
beforeEach(() => {
  imapMockState.envelopeTo = undefined;
  imapMockState.envelopeDate = '2020-01-01T00:00:00.000Z';
  imapMockState.internalDate = '2026-07-26T21:03:47.000Z';
  imapMockState.searchResult = [];
  imapMockState.junkSearchResult = [];
  imapMockState.lockPaths = [];
});

describe('ImapProvider polling', () => {
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
    const before = imapMockState.connectCount;

    const p = new ImapProvider();
    const inbox = imapInbox('pool-share', 'y@example.com');
    await Promise.all([p.getMessages(inbox), p.getMessages(inbox)]);

    expect(imapMockState.connectCount - before).toBe(1);
  });

  it('drops a message the substring search matched but is addressed to someone else', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('substr', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [1];
    // IMAP SEARCH TO is a substring match, so a search for bob.smith4@ returns
    // mail addressed to bob.smith42@. Both usernames can be live at once —
    // generateUniqueUsername only rules out exact duplicates.
    imapMockState.envelopeTo = [{ address: 'bob.smith42@example.com' }];

    const p = new ImapProvider();
    const messages = await p.getMessages(imapInbox('substr', 'bob.smith4@example.com'));

    expect(messages).toHaveLength(0);
  });

  it('keeps a message when the server reports no recipients to check', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('norcpt', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [1];
    imapMockState.envelopeTo = undefined;

    const p = new ImapProvider();
    const messages = await p.getMessages(imapInbox('norcpt', 'someone@example.com'));

    // Losing real mail to a sparse envelope is worse than a rare stray, the
    // same call isMessageWithinInboxLifetime already makes for timestamps.
    expect(messages).toHaveLength(1);
  });

  it('refuses to read a UID addressed to another tenant', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('detail-leak', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('code 123456') } };
    imapMockState.envelopeTo = [{ address: 'bob.smith42@example.com' }];

    // Filtering the listing is not enough: a UID names a message in the whole
    // catch-all mailbox and arrives straight off the request path, so a tenant
    // who walks small sequential integers would otherwise read a neighbour's
    // body and verification code.
    const p = new ImapProvider();
    await expect(
      p.getMessage(imapInbox('detail-leak', 'bob.smith4@example.com'), '1'),
    ).rejects.toThrow(/not found/);
  });

  it('keeps reading a message with no envelope recipients for a catch-all mailbox', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('bcc-ok', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.partContents = { '1': { content: Buffer.from('bcc body') } };
    imapMockState.envelopeTo = undefined;

    // A catch-all domain mailbox exists only to serve these addresses, so
    // refusing everything unverifiable would silently lose Bcc-only mail while
    // buying nothing — there is no third party's private mail in there to
    // protect. IcloudProvider passes strictRecipient because its shared mailbox
    // is the operator's own inbox, where the trade runs the other way.
    const msg = await new ImapProvider().getMessage(imapInbox('bcc-ok', 'someone@example.com'), '1');
    expect(msg.text).toBe('bcc body');
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

  it('reports a wrong-tenant UID exactly like an absent one', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('detail-oracle', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.partContents = {};

    const p = new ImapProvider();
    const inbox = imapInbox('detail-oracle', 'bob.smith4@example.com');

    imapMockState.bodyStructure = undefined; // UID does not exist at all
    const absent = await p.getMessage(inbox, '1').catch((e: Error) => e.message);

    imapMockState.bodyStructure = { type: 'text/plain' };
    imapMockState.envelopeTo = [{ address: 'bob.smith42@example.com' }];
    const forbidden = await p.getMessage(inbox, '1').catch((e: Error) => e.message);

    // Distinguishing the two would turn the endpoint into an oracle for which
    // UIDs are live in the shared mailbox.
    expect(forbidden).toBe(absent);
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
