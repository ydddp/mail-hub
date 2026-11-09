import { beforeEach, describe, expect, it, vi } from 'vitest';

const imapState = vi.hoisted(() => ({
  connectFailure: '' as '' | 'auth' | 'network',
  connectWait: undefined as Promise<void> | undefined,
  rejectedAccessTokens: [] as string[],
  constructorOptions: [] as Array<Record<string, any>>,
  tokenCalls: 0,
  httpMailCalls: 0,
  listCalls: 0,
  locks: [] as Array<{ path: string; options: Record<string, unknown> | undefined; released: boolean }>,
  logoutCount: 0,
  closeCount: 0,
  mutationCalls: 0,
  searches: [] as Array<Record<string, unknown>>,
  folders: [
    { path: 'INBOX', specialUse: '\\Inbox', listed: true, subscribed: true, flags: new Set<string>(), delimiter: '/', name: 'INBOX', parent: [], parentPath: '' },
    { path: '垃圾邮件', specialUse: '\\Junk', listed: true, subscribed: true, flags: new Set<string>(), delimiter: '/', name: '垃圾邮件', parent: [], parentPath: '' },
  ],
  messages: {
    INBOX: [
      { uid: 7, subject: 'Inbox mail', receivedAt: '2026-08-07T10:00:00.000Z', body: 'inbox body' },
    ],
    '垃圾邮件': [
      { uid: 7, subject: 'Junk mail', receivedAt: '2026-08-07T11:00:00.000Z', body: 'junk body' },
    ],
  } as Record<string, Array<{ uid: number; subject: string; receivedAt: string; body: string; to?: string[]; cc?: string[]; detailTo?: string[] }>>,
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    // Real SELECT exposes the mailbox generation; admin history binds its pages to it.
    readonly mailbox = { uidValidity: 1n };
    private selected = 'INBOX';
    private readonly options: Record<string, any>;

    constructor(options: Record<string, any>) {
      this.options = options;
      imapState.constructorOptions.push(options);
    }

    async connect(): Promise<void> {
      await imapState.connectWait;
      if (imapState.connectFailure === 'auth' || imapState.rejectedAccessTokens.includes(this.options.auth?.accessToken)) {
        throw Object.assign(new Error('Command failed'), {
          authenticationFailed: true,
          responseText: 'AUTHENTICATE failed',
        });
      }
      if (imapState.connectFailure === 'network') {
        throw Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' });
      }
    }

    once(): void {}

    async logout(): Promise<void> {
      imapState.logoutCount++;
    }

    close(): void {
      imapState.closeCount++;
    }

    async list(): Promise<typeof imapState.folders> {
      imapState.listCalls++;
      return imapState.folders;
    }

    async mailboxOpen(path: string): Promise<void> {
      this.selected = path;
    }

    async getMailboxLock(path: string, options?: Record<string, unknown>): Promise<{ release(): void }> {
      this.selected = path;
      const lock = { path, options, released: false };
      imapState.locks.push(lock);
      return { release: () => { lock.released = true; } };
    }

    async search(criteria: Record<string, unknown>): Promise<number[]> {
      imapState.searches.push(criteria);
      return (imapState.messages[this.selected] || []).map((message) => message.uid);
    }

    async *fetch(range: number[]): AsyncGenerator<unknown> {
      for (const uid of range) {
        const message = (imapState.messages[this.selected] || []).find((candidate) => candidate.uid === uid);
        if (!message) continue;
        yield {
          uid: message.uid,
          internalDate: new Date(message.receivedAt),
          envelope: {
            from: [{ name: 'Sender', address: 'sender@example.test' }],
            subject: message.subject,
            date: new Date(message.receivedAt),
            to: message.to?.map((address) => ({ address })),
            cc: message.cc?.map((address) => ({ address })),
          },
        };
      }
    }

    async fetchOne(uid: string): Promise<unknown> {
      const message = (imapState.messages[this.selected] || []).find((candidate) => candidate.uid === Number(uid));
      if (!message) return false;
      return {
        uid: message.uid,
        internalDate: new Date(message.receivedAt),
        envelope: {
          from: [{ name: 'Sender', address: 'sender@example.test' }],
          subject: message.subject,
          date: new Date(message.receivedAt),
          to: (message.detailTo ?? message.to)?.map((address) => ({ address })),
          cc: message.cc?.map((address) => ({ address })),
        },
        bodyStructure: { type: 'text/plain' },
      };
    }

    async download(uid: string): Promise<{ meta: { charset: string }; content: AsyncIterable<Buffer> }> {
      const message = (imapState.messages[this.selected] || []).find((candidate) => candidate.uid === Number(uid));
      if (!message) throw new Error('message not found');
      return {
        meta: { charset: 'utf-8' },
        content: (async function* () { yield Buffer.from(message.body); })(),
      };
    }

    async messageFlagsAdd(): Promise<void> { imapState.mutationCalls++; }
    async messageMove(): Promise<void> { imapState.mutationCalls++; }
    async messageDelete(): Promise<void> { imapState.mutationCalls++; }
  }

  return { ImapFlow: FakeImapFlow };
});

import { getDb } from '../src/db.js';
import { checkToken, fetchAccountMailbox, fetchAccountMessage, OutlookProvider } from '../src/providers/outlook.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';
import { credentialContext, CREDENTIAL_COLUMNS, type OutlookCredentialRow } from '../src/outlook-credentials.js';
import { renewToken } from '../src/providers/outlook.js';
import { fetchOutlookImapMessage, fetchOutlookImapMessages, outlookImapCreds } from '../src/providers/outlook-imap.js';
import * as messageTypes from '../src/providers/base.js';
import { hashApiKey } from '../src/crypto.js';

function insertAccount(email: string, apiType = 'imap'): void {
  getDb().prepare(
    `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status, api_type)
     VALUES (?, 'pw', 'client-id', ?, 'valid', ?)`,
  ).run(email, `refresh-${email}`, apiType);
}

function stubMicrosoftHttp(opts: { rotatedRefreshToken?: string; rotatedRefreshTokens?: string[]; accessTokens?: string[] } = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/oauth2/v2.0/token')) {
      const accessToken = opts.accessTokens?.[imapState.tokenCalls] || opts.accessTokens?.at(-1) || 'opaque-access-token';
      const refreshToken = opts.rotatedRefreshTokens?.[imapState.tokenCalls] || opts.rotatedRefreshToken;
      imapState.tokenCalls++;
      return new Response(JSON.stringify({
        access_token: accessToken,
        expires_in: 3600,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target.includes('graph.microsoft.com') || target.includes('outlook.office.com/api/')) {
      imapState.httpMailCalls++;
      return new Response('{}', { status: 401 });
    }
    return new Response('{}', { status: 404 });
  }));
}

function inbox(email: string) {
  return {
    address: email,
    authData: { email, password: 'pw', clientId: 'client-id', refreshToken: `refresh-${email}` },
    provider: 'outlook',
    apiBase: '',
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  imapState.connectFailure = '';
  imapState.connectWait = undefined;
  imapState.rejectedAccessTokens = [];
  imapState.constructorOptions = [];
  imapState.tokenCalls = 0;
  imapState.httpMailCalls = 0;
  imapState.listCalls = 0;
  imapState.locks = [];
  imapState.logoutCount = 0;
  imapState.closeCount = 0;
  imapState.mutationCalls = 0;
  imapState.searches = [];
  imapState.messages = {
    INBOX: [{ uid: 7, subject: 'Inbox mail', receivedAt: '2026-08-07T10:00:00.000Z', body: 'inbox body' }],
    '垃圾邮件': [{ uid: 7, subject: 'Junk mail', receivedAt: '2026-08-07T11:00:00.000Z', body: 'junk body' }],
  };
});

describe('Outlook IMAP alias recipient isolation', () => {
  const email = 'alias-imap@outlook.com';
  const own = 'alias-imap+new@outlook.com';
  const old = 'alias-imap+old@outlook.com';
  const aliasInbox = (accountEmail = email) => ({ ...inbox(accountEmail), address: accountEmail.replace('@', '+new@') });
  const messageId = (uid: number, mailbox = 'INBOX') => `imap:${Buffer.from(JSON.stringify([mailbox, String(uid)])).toString('base64url')}`;
  const message = (uid: number, recipients: { to?: string[]; cc?: string[]; detailTo?: string[] } = {}) => ({
    uid, subject: 'Verification code: 123456', receivedAt: `2026-11-07T10:00:${String(uid).padStart(2, '0')}Z`,
    body: 'Code: 654321', ...recipients,
  });
  function prepare(accountEmail = email, address = aliasInbox(accountEmail).address): void {
    insertAccount(accountEmail);
    stubMicrosoftHttp();
    getDb().prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, created_at, status)
       VALUES ('imap-recipient-lease', 'outlook', ?, ?, '', '2026-11-07 10:00:00', 'active')`,
    ).run(address, JSON.stringify(aliasInbox(accountEmail).authData));
  }

  // An admin can distinguish a delayed recipient from its arrival lease,
  // while an ordinary owner still receives only the existing message shape.
  it.each([
    { name: 'old alias', to: [old], cc: [], match: 'exact', address: old },
    { name: 'To and Cc', to: [old], cc: [own], match: 'multiple', address: undefined },
    { name: 'no evidence', to: [], cc: [], match: 'unknown', address: undefined },
  ])('retains IMAP $name evidence internally and exposes only admin attribution', async ({ to, cc, match, address }) => {
    prepare();
    const id = messageId(10);
    imapState.messages = { INBOX: [message(10, { to, cc })], '垃圾邮件': [] };
    const internalKey = (messageTypes as unknown as Record<string, symbol>).MESSAGE_RECIPIENTS;
    expect(typeof internalKey).toBe('symbol');
    for (const mail of [(await fetchAccountMailbox(email))[0], await fetchAccountMessage(email, id)]) {
      expect((mail as any)[internalKey]).toEqual([...to, ...cc]);
      expect(JSON.stringify(mail)).not.toContain(old);
    }
    for (const suffix of ['', `/${encodeURIComponent(id)}`]) {
      const res = await app.request(`/api/outlook/accounts/${email}/mailbox${suffix}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      const mail = suffix ? body : body.messages[0];
      expect(mail).toMatchObject({ recipientMatch: match, leaseState: 'lease', leaseId: 'imap-recipient-lease' });
      expect(mail.recipientAddress).toBe(address);
    }
    // The bare-address tenant path can view all To/Cc evidence only internally;
    // no recipient metadata is added to its existing HTTP message contract.
    getDb().prepare(`UPDATE inboxes SET address = ?, owner_key = ? WHERE id = 'imap-recipient-lease'`).run(email, hashApiKey('evidence-owner'));
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, 'evidence owner')`).run(hashApiKey('evidence-owner'));
    for (const suffix of ['', `/${encodeURIComponent(id)}`]) {
      const res = await app.request(`/api/inbox/imap-recipient-lease/messages${suffix}`, { headers: authHeaders('evidence-owner') });
      expect(res.status).toBe(200);
      const body = await res.json();
      const mail = suffix ? body : body.messages[0];
      expect(mail).not.toHaveProperty('recipientMatch');
      expect(mail).not.toHaveProperty('recipientAddress');
      expect(JSON.stringify(mail)).not.toContain(old);
    }
  });

  it.each(['', ' \t\n'].flatMap(recipient => ['list', 'detail'].map(entry => ({ recipient, entry }))))
  ('rejects explicitly blank recipient scope in the Outlook IMAP $entry wrapper: $recipient', async ({ recipient, entry }) => {
    const creds = outlookImapCreds(`blank-wrapper-${entry}@outlook.com`, 'local-mock-token');
    const result = entry === 'list' ? fetchOutlookImapMessages(creds, 20, recipient)
      : fetchOutlookImapMessage(creds, messageId(7, '垃圾邮件'), recipient);
    await expect(result).rejects.toThrow('Message not found');
    expect(imapState.constructorOptions).toHaveLength(0);
    expect(imapState.listCalls).toBe(0);
    expect(imapState.locks).toHaveLength(0);
  });

  it('keeps omitted Outlook IMAP recipient scope available for administrator whole-mailbox reads', async () => {
    const creds = outlookImapCreds('whole-wrapper-admin@outlook.com', 'local-mock-token');
    expect(await fetchOutlookImapMessages(creds, 20)).toHaveLength(2);
    expect((await fetchOutlookImapMessage(creds, messageId(7))).text).toBe('inbox body');
    expect(imapState.searches).toEqual([{ all: true }, { all: true }]);
  });

  it('uses To OR Cc with an exact envelope check before lease filtering, leaving account reads whole', async () => {
    prepare();
    imapState.messages = {
      INBOX: [
        message(12, { to: [old] }), // Delayed old-tag mail, after current-tag mail.
        message(11, { to: [own] }),
        message(10, { to: [own.toUpperCase()] }),
        message(8, { to: [old] }), // Old and new tags within the same minute.
        message(7, { to: [email] }),
        message(6, { to: ['alias-imap+newer@outlook.com'] }),
        message(5),
        { ...message(1, { to: [own] }), receivedAt: '2026-11-07T09:59:59Z' },
      ],
      '垃圾邮件': [message(9, { to: [old], cc: [own.toUpperCase()] })],
    };
    const provider = new OutlookProvider();
    expect((await provider.getMessages(aliasInbox())).map((mail) => mail.id)).toEqual([
      messageId(11), messageId(10), messageId(9, '垃圾邮件'), messageId(1),
    ]);
    expect(imapState.searches).toEqual([
      { or: [{ to: own }, { cc: own }] }, { or: [{ to: own }, { cc: own }] },
    ]);
    const list = await app.request('/api/inbox/imap-recipient-lease/messages', { headers: authHeaders() });
    expect(list.status).toBe(200);
    expect((await list.json() as { messages: { id: string }[] }).messages.map((mail) => mail.id)).toEqual([
      messageId(11), messageId(10), messageId(9, '垃圾邮件'),
    ]);
    const code = await app.request('/api/inbox/imap-recipient-lease/code', { headers: authHeaders() });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject({ messageId: messageId(11), codes: expect.arrayContaining([expect.objectContaining({ value: '654321' })]) });

    expect(await fetchAccountMailbox(email)).toHaveLength(9);
    expect((await fetchAccountMessage(email, messageId(5))).text).toBe('Code: 654321');
    expect(await provider.getMessages(inbox(email))).toHaveLength(9);
    expect(imapState.searches.at(-1)).toEqual({ all: true });
  });

  it.each([
    ['exact To', { to: [own] }, true],
    ['case-insensitive To', { to: [own.toUpperCase()] }, true],
    ['exact Cc', { to: [old], cc: [own.toUpperCase()] }, true],
    ['previous tag', { to: [old] }, false],
    ['untagged account', { to: [email] }, false],
    ['substring', { to: ['alias-imap+newer@outlook.com'] }, false],
    ['no envelope recipients', {}, false],
    ['plus-containing account: own alias', { to: ['alias-imap+existing+new@outlook.com'] }, true, 'alias-imap+existing@outlook.com'],
    ['plus-containing account: previous alias', { to: ['alias-imap+existing+old@outlook.com'] }, false, 'alias-imap+existing@outlook.com'],
    ['Unicode local is distinct', { to: ['\u212A+new@outlook.com'] }, false, 'k@outlook.com'],
    ['Unicode Cc is distinct', { cc: ['\u212A+new@outlook.com'] }, false, 'k@outlook.com'],
    ['Unicode tag is distinct', { to: ['alias-imap+\u212A@outlook.com'] }, false, undefined, 'alias-imap+k@outlook.com'],
    ['Unicode domain is distinct', { to: ['local+new@\u212A.test'] }, false, 'local@k.test'],
    ['same Unicode keeps ASCII case compatibility', { cc: ['\u212A+NEW@OUTLOOK.COM'] }, true, '\u212A@outlook.com'],
    ['Unicode case pair is distinct', { to: ['\u00e9+new@outlook.com'] }, false, '\u00c9@outlook.com'],
    ['Unicode normalization is not identity', { to: ['e\u0301+new@outlook.com'] }, false, '\u00e9@outlook.com'],
    ['legacy Unicode base cannot become whole mailbox', { to: ['k+new@outlook.com'] }, false, 'k@outlook.com', '\u212A+new@outlook.com'],
    ['legacy Unicode base exact evidence', { to: ['\u212A+NEW@OUTLOOK.COM'] }, true, 'k@outlook.com', '\u212A+new@outlook.com'],
    ['legacy Unicode domain cannot become whole mailbox', { to: ['local+new@k.test'] }, false, 'local@k.test', 'local+new@\u212A.test'],
    ['legacy distinct bare identity stays scoped', { to: ['k@outlook.com'] }, false, 'k@outlook.com', '\u212A@outlook.com'],
    ['legacy distinct bare identity exact evidence', { to: ['\u212A@OUTLOOK.COM'] }, true, 'k@outlook.com', '\u212A@outlook.com'],
    ['ASCII-identical bare lease stays whole mailbox', {}, true, 'k@outlook.com', 'K@OUTLOOK.COM'],
  ] as const)('independently checks guessed detail ids: %s', async (_name, recipients, allowed, accountEmail = email, leaseAddress = aliasInbox(accountEmail).address) => {
    prepare(accountEmail, leaseAddress);
    imapState.messages = { INBOX: [message(10, { ...recipients })], '垃圾邮件': [] };
    const lease = { ...aliasInbox(accountEmail), address: leaseAddress };
    expect((await new OutlookProvider().getMessages(lease)).map((mail) => mail.id)).toEqual(allowed ? [messageId(10)] : []);
    const result = new OutlookProvider().getMessage(lease, messageId(10));
    if (allowed) await expect(result).resolves.toMatchObject({ text: 'Code: 654321' });
    else await expect(result).rejects.toThrow(/not found/i);
    const list = await app.request('/api/inbox/imap-recipient-lease/messages', { headers: authHeaders() });
    expect(list.status).toBe(200);
    expect((await list.json() as { messages: unknown[] }).messages).toHaveLength(allowed ? 1 : 0);
    const detail = await app.request(`/api/inbox/imap-recipient-lease/messages/${messageId(10)}`, { headers: authHeaders() });
    expect(detail.status).toBe(allowed ? 200 : 404);
    const code = await app.request('/api/inbox/imap-recipient-lease/code', { headers: authHeaders() });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject(allowed
      ? { messageId: messageId(10), codes: expect.arrayContaining([expect.objectContaining({ value: '654321' })]) }
      : { codes: [], email: null, messageId: null });
    expect((await fetchAccountMessage(accountEmail, messageId(10))).text).toBe('Code: 654321');
  });

  it('returns not-found and extracts no summary code after detail recipient evidence changes', async () => {
    prepare();
    imapState.messages = { INBOX: [message(10, { to: [own], detailTo: [old] })], '垃圾邮件': [] };
    const detail = await app.request(`/api/inbox/imap-recipient-lease/messages/${messageId(10)}`, { headers: authHeaders() });
    expect(detail.status).toBe(404);
    expect(await detail.json()).toEqual({ error: 'Message not found' });
    const code = await app.request('/api/inbox/imap-recipient-lease/code', { headers: authHeaders() });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject({ codes: [], email: null, messageId: null });
  });

  // Corrupt tenant identities cannot fall through to the admin's whole mailbox.
  it.each(['', ' ', '\t'])('rejects an empty stored lease identity %j before reading mail', async (address) => {
    prepare(email, address);
    imapState.messages = { INBOX: [message(10, { to: [old] })], '垃圾邮件': [] };
    const lease = { ...aliasInbox(), address };
    const provider = new OutlookProvider();
    await expect(provider.getMessages(lease)).rejects.toThrow('Message not found');
    await expect(provider.getMessage(lease, messageId(10))).rejects.toThrow('Message not found');
    for (const path of ['messages', `messages/${messageId(10)}`, 'code']) {
      const response = await app.request(`/api/inbox/imap-recipient-lease/${path}`, { headers: authHeaders() });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Message not found' });
    }
    expect(imapState.constructorOptions).toHaveLength(0);
    expect(imapState.tokenCalls).toBe(0);
    expect((await fetchAccountMessage(email, messageId(10))).text).toBe('Code: 654321');
  });
});

describe('Outlook IMAP XOAUTH2 mailbox transport', () => {
  it('reads Inbox and special-use Junk directly with collision-free ids', async () => {
    const email = 'known-imap@outlook.com';
    insertAccount(email);
    stubMicrosoftHttp();

    const provider = new OutlookProvider();
    const messages = await provider.getMessages(inbox(email));

    expect(messages.map((message) => message.subject)).toEqual(['Junk mail', 'Inbox mail']);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
    expect(imapState.httpMailCalls).toBe(0);
    expect(imapState.listCalls).toBe(1);
    expect(imapState.constructorOptions[0]?.auth).toEqual({
      user: email,
      accessToken: 'opaque-access-token',
    });
    expect(imapState.constructorOptions[0]).toMatchObject({
      connectionTimeout: 10000,
      socketTimeout: 30000,
    });
    expect(imapState.locks.map((lock) => [lock.path, lock.options])).toEqual([
      ['INBOX', { readOnly: true }],
      ['垃圾邮件', { readOnly: true }],
    ]);
    expect(imapState.locks.every((lock) => lock.released)).toBe(true);
    expect(imapState.mutationCalls).toBe(0);
  });

  it('uses the folder encoded in the message id when reading detail', async () => {
    const email = 'detail-imap@outlook.com';
    insertAccount(email);
    stubMicrosoftHttp();
    const provider = new OutlookProvider();
    const messages = await provider.getMessages(inbox(email));
    const junk = messages.find((message) => message.subject === 'Junk mail');

    const detail = await provider.getMessage(inbox(email), junk!.id);

    expect(detail.subject).toBe('Junk mail');
    expect(detail.text).toBe('junk body');
    expect(imapState.locks.at(-1)).toMatchObject({ path: '垃圾邮件', released: true });
    expect(imapState.mutationCalls).toBe(0);
  });

  it.each([
    ['a mailbox outside Inbox and special-use Junk', 'Sent Items', '7'],
    ['an IMAP UID range', 'INBOX', '1:*'],
  ])('rejects a forged message id containing %s', async (_description, mailbox, uid) => {
    const email = 'folder-boundary@outlook.com';
    insertAccount(email);
    stubMicrosoftHttp();
    const forgedId = `imap:${Buffer.from(JSON.stringify([mailbox, uid])).toString('base64url')}`;

    await expect(new OutlookProvider().getMessage(inbox(email), forgedId)).rejects.toThrow('Invalid Outlook IMAP message id');

    expect(imapState.locks).toHaveLength(0);
    expect(imapState.mutationCalls).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['unrecognized', 'legacy-api'],
  ])('discovers IMAP while polling an account whose api type is %s', async (label, apiType) => {
    const email = `unknown-${label}-imap@outlook.com`;
    insertAccount(email, apiType);
    stubMicrosoftHttp();

    const messages = await new OutlookProvider().getMessages(inbox(email));

    expect(messages.map((message) => message.subject)).toEqual(['Junk mail', 'Inbox mail']);
    // Each HTTP transport reads Inbox and Junk as one capability attempt.
    expect(imapState.httpMailCalls).toBe(4);
    expect(getDb().prepare(`SELECT api_type FROM outlook_accounts WHERE email = ?`).get(email)).toEqual({ api_type: 'imap' });
  });

  it('persists a refresh token rotated during ordinary mailbox polling', async () => {
    const email = 'poll-rotation@outlook.com';
    insertAccount(email);
    stubMicrosoftHttp({ rotatedRefreshToken: 'rotated-during-poll' });

    await new OutlookProvider().getMessages(inbox(email));

    expect(getDb().prepare(
      `SELECT refresh_token, token_renewed_at FROM outlook_accounts WHERE email = ?`,
    ).get(email)).toMatchObject({
      refresh_token: 'rotated-during-poll',
      token_renewed_at: expect.any(String),
    });
  });

  it('evicts a rejected cached access token and retries IMAP once with a fresh token', async () => {
    const email = 'retry-imap@outlook.com';
    insertAccount(email);
    imapState.rejectedAccessTokens = ['stale-access-token'];
    stubMicrosoftHttp({ accessTokens: ['stale-access-token', 'fresh-access-token'] });

    const messages = await new OutlookProvider().getMessages(inbox(email));

    expect(messages).toHaveLength(2);
    expect(imapState.tokenCalls).toBe(2);
    expect(imapState.constructorOptions.map((options) => options.auth.accessToken)).toEqual([
      'stale-access-token',
      'fresh-access-token',
    ]);
    expect(imapState.closeCount).toBe(1);
  });

  it('evicts the rotated credential cache key before retrying a rejected access token', async () => {
    const email = 'retry-rotated-imap@outlook.com';
    insertAccount(email);
    imapState.rejectedAccessTokens = ['stale-rotated-access-token'];
    stubMicrosoftHttp({
      rotatedRefreshTokens: ['rotated-before-retry', 'rotated-after-retry'],
      accessTokens: ['stale-rotated-access-token', 'fresh-rotated-access-token'],
    });

    const messages = await new OutlookProvider().getMessages(inbox(email));

    expect(messages).toHaveLength(2);
    expect(imapState.tokenCalls).toBe(2);
    expect(imapState.constructorOptions.map((options) => options.auth.accessToken)).toEqual([
      'stale-rotated-access-token',
      'fresh-rotated-access-token',
    ]);
    expect(getDb().prepare(`SELECT refresh_token FROM outlook_accounts WHERE email = ?`).get(email)).toEqual({
      refresh_token: 'rotated-after-retry',
    });
  });
});

describe('Outlook capability detection', () => {
  it('classifies an opaque Thunderbird token as valid IMAP after both HTTP APIs reject it', async () => {
    const email = 'detect-imap@outlook.com';
    insertAccount(email, '');
    stubMicrosoftHttp();

    await expect(checkToken(email, 'client-id', `refresh-${email}`)).resolves.toEqual({
      status: 'valid',
      apiType: 'imap',
    });
  });

  it('persists valid plus imap through the /outlook/check route', async () => {
    const email = 'route-check-imap@outlook.com';
    insertAccount(email, '');
    getDb().prepare(`UPDATE outlook_accounts SET token_status = '' WHERE email = ?`).run(email);
    stubMicrosoftHttp();

    const response = await app.request('/api/outlook/check', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ emails: [email] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      valid: 1,
      invalid: 0,
      unknown: 0,
      results: [{ email, valid: true, status: 'valid', apiType: 'imap' }],
    });
    expect(getDb().prepare(
      `SELECT token_status, api_type FROM outlook_accounts WHERE email = ?`,
    ).get(email)).toEqual({ token_status: 'valid', api_type: 'imap' });
  });

  it('refreshes and rechecks a cached access token before /outlook/check can mark the account invalid', async () => {
    const email = 'route-check-stale-cache@outlook.com';
    insertAccount(email, 'imap');
    stubMicrosoftHttp({ accessTokens: ['stale-check-access-token', 'fresh-check-access-token'] });
    await new OutlookProvider().getMessages(inbox(email));
    imapState.rejectedAccessTokens = ['stale-check-access-token'];

    const response = await app.request('/api/outlook/check', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ emails: [email] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      valid: 1,
      invalid: 0,
      unknown: 0,
      results: [{ email, valid: true, status: 'valid', apiType: 'imap' }],
    });
    expect(imapState.tokenCalls).toBe(2);
    expect(getDb().prepare(
      `SELECT token_status, api_type FROM outlook_accounts WHERE email = ?`,
    ).get(email)).toEqual({ token_status: 'valid', api_type: 'imap' });
  });

  it.each([
    ['temporary IMAP connection failure is inconclusive', 'network', 'unknown'],
    ['explicit rejection by every transport is invalid', 'auth', 'invalid'],
  ] as const)('%s', async (_name, connectFailure, expected) => {
    const email = `${connectFailure}@outlook.com`;
    insertAccount(email, '');
    imapState.connectFailure = connectFailure;
    stubMicrosoftHttp();

    const result = await checkToken(email, 'client-id', `refresh-${email}`);

    expect(result).toEqual({ status: expected, apiType: '' });
    expect(imapState.constructorOptions).toHaveLength(1);
  });

  it('treats a malformed successful token response as unknown, not invalid', async () => {
    const email = 'malformed-token@outlook.com';
    insertAccount(email, '');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/v2.0/token')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('mail APIs must not be called without an access token');
    }));

    await expect(checkToken(email, 'client-id', `refresh-${email}`)).resolves.toEqual({
      status: 'unknown',
      apiType: '',
    });
    expect(imapState.constructorOptions).toHaveLength(0);
  });
});

describe('Outlook token renewal capability validation', () => {
  it.each(['imap-discovery', 'imap-auth-retry', 'cached-check'])('fences %s after a same-credential OAuth session change', async boundary => {
    const email = `late-cached-${boundary}@outlook.com`;
    insertAccount(email, boundary === 'imap-auth-retry' ? 'imap' : '');
    stubMicrosoftHttp();
    if (boundary === 'cached-check') await checkToken(email, 'client-id', `refresh-${email}`);
    let release!: () => void;
    imapState.connectWait = new Promise<void>(resolve => { release = resolve; });
    if (boundary === 'imap-auth-retry') imapState.rejectedAccessTokens = ['opaque-access-token'];
    const initialConstructors = imapState.constructorOptions.length;
    const request = boundary === 'cached-check'
      ? app.request('/api/outlook/check', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ emails: [email] }) })
      : new OutlookProvider().getMessages(inbox(email));
    const settled = Promise.resolve(request).then(value => value, () => 'stale');
    await vi.waitFor(() => expect(imapState.constructorOptions).toHaveLength(initialConstructors + 1));
    getDb().prepare("UPDATE outlook_accounts SET oauth_last_session_id = 'next-oauth' WHERE email = ?").run(email);
    const expected = getDb().prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email);
    release();
    const result = await settled;
    if (boundary === 'cached-check') expect(await (result as Response).json()).toMatchObject({ results: [{ status: 'unknown' }] });
    else expect(result).toBe('stale');
    expect(imapState.tokenCalls).toBe(1);
    expect(getDb().prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email)).toEqual(expected);
  });

  it('keeps both workers issued assets but permits only the winning rotation', async () => {
    const email = 'two-workers@outlook.com';
    insertAccount(email);
    const db = getDb();
    const row = db.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM outlook_accounts WHERE email = ?`).get(email) as OutlookCredentialRow;
    const gates: Array<(response: Response) => void> = [];
    const pairs: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      pairs.push(String(init?.body));
      return new Promise<Response>(resolve => { gates.push(resolve); });
    }));
    const firstContext = credentialContext(row, 'test-worker-one');
    const secondContext = credentialContext(row, 'test-worker-two');
    const first = renewToken(firstContext);
    const second = renewToken(secondContext);
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0](new Response('{"access_token":"worker-one-at","refresh_token":"worker-one-rt"}'));
    await first;
    gates[1](new Response('{"access_token":"worker-two-at","refresh_token":"worker-two-rt"}'));
    expect((await settled).map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(db.prepare('SELECT refresh_token FROM outlook_accounts WHERE email = ?').get(email)).toEqual({ refresh_token: 'worker-one-rt' });
    expect(firstContext.refreshToken).toBe('worker-one-rt');
    expect(secondContext.refreshToken).toBe(row.refresh_token);
    const issued = db.prepare('SELECT credentials_json FROM outlook_credential_checkpoints WHERE http_status = 200').all();
    expect(issued).toHaveLength(2);
    expect(JSON.stringify(issued)).toContain('worker-one-rt');
    expect(JSON.stringify(issued)).toContain('worker-two-rt');
    expect(pairs.every(pair => pair.includes(`refresh_token=${encodeURIComponent(row.refresh_token)}`))).toBe(true);
  });

  it.each(['check', 'renew'].flatMap(operation => ['client', 'refresh', 'session'].flatMap(change =>
    [200, 401, 503].map(status => ({ operation, change, status })),
  )))('ignores delayed capability $status from $operation after own rotation then $change changes', async ({ operation, change, status }) => {
    const email = 'after-own-rotation@outlook.com';
    insertAccount(email, '');
    const db = getDb();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/token')) return new Response('{"access_token":"own-at","refresh_token":"own-rt"}');
      entered(); await waiting; return new Response('{"value":[]}', { status });
    }));
    const request = Promise.resolve(app.request(`/api/outlook/${operation}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ emails: [email] }) }));
    await started;
    expect(db.prepare('SELECT refresh_token FROM outlook_accounts WHERE email = ?').get(email)).toEqual({ refresh_token: 'own-rt' });
    const column = change === 'client' ? 'client_id' : change === 'refresh' ? 'refresh_token' : 'oauth_last_session_id';
    db.prepare(`UPDATE outlook_accounts SET ${column} = 'foreign-generation' WHERE email = ?`).run(email);
    const expected = db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email);
    release();
    expect(await (await request).json()).toMatchObject({ results: [{ status: 'unknown' }] });
    expect(db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email)).toEqual(expected);
  });

  it.each(['tenant-list', 'tenant-detail', 'admin-list', 'admin-detail'])('stops stale %s reads before committing capabilities or returning mail', async surface => {
    const email = 'late-mailbox@outlook.com';
    insertAccount(email, '');
    const db = getDb();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/token')) return new Response('{"access_token":"mailbox-at"}');
      entered(); await waiting;
      return new Response(JSON.stringify(surface.endsWith('list') ? { value: [] } : { id: 'message', body: { content: 'old mail' } }));
    }));
    const provider = new OutlookProvider();
    const request = surface === 'tenant-list' ? provider.getMessages(inbox(email))
      : surface === 'tenant-detail' ? provider.getMessage(inbox(email), 'message')
      : surface === 'admin-list' ? fetchAccountMailbox(email) : fetchAccountMessage(email, 'message');
    const settled = request.then(() => 'returned-stale-mail', () => 'stale');
    await started;
    db.prepare("UPDATE outlook_accounts SET oauth_last_session_id = 'new-oauth' WHERE email = ?").run(email);
    const expected = db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email);
    release();
    expect(await settled).toBe('stale');
    expect(db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email)).toEqual(expected);
  });

  it.each(['check', 'renew'].flatMap(operation => [false, true].flatMap(background =>
    ['client', 'refresh', 'session', 'deleted', 'pending'].map(change => ({ operation, background, change })),
  )))('ignores $operation background=$background after $change changes during refresh', async ({ operation, background, change }) => {
    const email = 'generation@outlook.com';
    insertAccount(email, '');
    const db = getDb();
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/token')) { started(); return waiting; }
      return new Response(JSON.stringify({ value: [] }));
    }));
    const request = Promise.resolve(app.request(`/api/outlook/${operation}`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ emails: [email], background }),
    }));
    await entered;
    if (change === 'deleted') db.prepare('DELETE FROM outlook_accounts WHERE email = ?').run(email);
    else if (change === 'client') db.prepare("UPDATE outlook_accounts SET client_id = 'replacement-client' WHERE email = ?").run(email);
    else if (change === 'refresh') db.prepare("UPDATE outlook_accounts SET refresh_token = 'replacement-refresh' WHERE email = ?").run(email);
    else if (change === 'session') db.prepare("UPDATE outlook_accounts SET oauth_last_session_id = 'replacement-session' WHERE email = ?").run(email);
    else db.prepare("UPDATE outlook_accounts SET token_status = 'pending_oauth' WHERE email = ?").run(email);
    const expected = db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email);
    release(new Response(JSON.stringify({ access_token: 'late-private-access', refresh_token: 'late-private-refresh' })));
    const response = await request;
    const body = await response.json();
    if (background) {
      await vi.waitFor(async () => {
        const result = await app.request(`/api/batch-jobs/${body.job.id}`, { headers: authHeaders() });
        expect((await result.json()).job).toMatchObject({ status: 'completed', summary: { unknown: 1 } });
      });
    } else expect(body.results).toEqual([expect.objectContaining({ email, status: 'unknown' })]);
    expect(db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email)).toEqual(expected);
    const checkpoints = db.prepare('SELECT credentials_json FROM outlook_credential_checkpoints WHERE email = ?').all(email);
    expect(JSON.stringify(checkpoints)).toContain('late-private-refresh');
    expect(JSON.stringify(body)).not.toMatch(/late-private|replacement-|client-id|refresh-generation/);
  });

  it.each(['check', 'renew'].flatMap(operation => ['pending_oauth', 'exchanging'].map(oauthState => ({ operation, oauthState }))))('does not promote or invalidate already $oauthState during $operation', async ({ operation, oauthState }) => {
    const email = 'already-pending@outlook.com';
    insertAccount(email);
    if (oauthState === 'pending_oauth') getDb().prepare("UPDATE outlook_accounts SET token_status = 'pending_oauth' WHERE email = ?").run(email);
    else {
      getDb().prepare(`INSERT INTO outlook_oauth_sessions (id, email, client_id, redirect_uri, scopes, tenant, state_hash, code_verifier, status, expires_at)
        VALUES ('active-exchange', ?, 'client-id', 'http://localhost', '', 'common', 'exchange-state', 'verifier', 'exchanging', datetime('now', '+1 hour'))`).run(email);
      getDb().prepare("UPDATE outlook_accounts SET oauth_last_session_id = 'active-exchange' WHERE email = ?").run(email);
    }
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await app.request(`/api/outlook/${operation}`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ emails: [email] }),
    });
    expect((await response.json()).results).toEqual([expect.objectContaining({ status: 'unknown' })]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT token_status, last_checked_at FROM outlook_accounts WHERE email = ?').get(email))
      .toEqual({ token_status: oauthState === 'pending_oauth' ? 'pending_oauth' : 'valid', last_checked_at: null });
  });

  it('uses one current client/RT pair for a tenant whose saved auth is obsolete', async () => {
    const email = 'coherent@outlook.com';
    insertAccount(email);
    getDb().prepare("UPDATE outlook_accounts SET client_id = 'current-client', refresh_token = 'current-refresh' WHERE email = ?").run(email);
    const pairs: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      pairs.push(String(init.body));
      return new Response('{"access_token":"coherent-access"}');
    }));
    await new OutlookProvider().getMessages(inbox(email));
    expect(pairs).toEqual(['client_id=current-client&refresh_token=current-refresh&grant_type=refresh_token']);
  });

  it('records valid IMAP only after the rotated token can read the mailbox', async () => {
    const email = 'renew-imap@outlook.com';
    insertAccount(email, '');
    stubMicrosoftHttp({ rotatedRefreshToken: 'rotated-refresh-token' });

    const response = await app.request('/api/outlook/renew', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ emails: [email] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ email, renewed: true, status: 'renewed', apiType: 'imap' }],
    });
    expect(getDb().prepare(
      `SELECT refresh_token, token_status, api_type FROM outlook_accounts WHERE email = ?`,
    ).get(email)).toEqual({
      refresh_token: 'rotated-refresh-token',
      token_status: 'valid',
      api_type: 'imap',
    });
  });

  it.each([
    ['temporary IMAP failure keeps the prior status', 'network', 'unknown', 'valid'],
    ['explicit rejection by all transports marks the account invalid', 'auth', 'invalid', 'invalid'],
  ] as const)('%s', async (_name, failure, expectedResult, expectedStoredStatus) => {
    const email = `renew-${failure}@outlook.com`;
    insertAccount(email, '');
    imapState.connectFailure = failure;
    stubMicrosoftHttp({ rotatedRefreshToken: `rotated-${failure}` });

    const response = await app.request('/api/outlook/renew', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ emails: [email] }),
    });
    const body = await response.json() as { results: Array<{ status: string }> };

    expect(body.results[0].status).toBe(expectedResult);
    expect(getDb().prepare(
      `SELECT refresh_token, token_status FROM outlook_accounts WHERE email = ?`,
    ).get(email)).toEqual({
      refresh_token: `rotated-${failure}`,
      token_status: expectedStoredStatus,
    });
  });
});
