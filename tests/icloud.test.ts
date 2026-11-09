import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { getDb } from '../src/db.js';
import { IcloudProvider, hmeSearchCriteria } from '../src/providers/icloud.js';
import { decodeMailboxMessageId, encodeMailboxMessageId } from '../src/providers/imap-core.js';
import type { InboxData } from '../src/providers/base.js';
import { app, authHeaders } from './helpers/http.js';

// Gmail is where this Apple ID's Hide My Email actually forwards, and its junk
// folder is localised — the name is discovered by special-use, never typed.
const JUNK_PATH = '[Gmail]/垃圾邮件';

const imapMockState = vi.hoisted(() => ({
  lastSearch: undefined as unknown,
  searchResult: [] as number[],
  junkSearchResult: [] as number[],
  lockPaths: [] as string[],
  connectCount: 0,
  envelopeTo: undefined as { address: string }[] | undefined,
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    private selected = 'INBOX';
    async connect(): Promise<void> { imapMockState.connectCount++; }
    once(): void {}
    async logout(): Promise<void> {}
    async list(): Promise<Array<{ path: string; specialUse?: string }>> {
      return [
        { path: 'INBOX', specialUse: '\\Inbox' },
        // A folder of the operator's own personal mail, with no special use.
        { path: '账单', specialUse: undefined },
        { path: '[Gmail]/垃圾邮件', specialUse: '\\Junk' },
      ];
    }
    async getMailboxLock(path = 'INBOX'): Promise<{ release(): void }> {
      this.selected = path;
      imapMockState.lockPaths.push(path);
      return { release() {} };
    }
    async search(criteria: unknown): Promise<number[]> {
      imapMockState.lastSearch = criteria;
      return this.selected === '[Gmail]/垃圾邮件'
        ? [...imapMockState.junkSearchResult]
        : [...imapMockState.searchResult];
    }
    async *fetch(range: number[]): AsyncGenerator<unknown> {
      for (const uid of range) {
        yield {
          uid,
          envelope: {
            from: [{ address: 's@example.test' }],
            to: imapMockState.envelopeTo,
            subject: `m-${uid}`,
            date: new Date(),
          },
        };
      }
    }
    async fetchOne(): Promise<unknown> {
      return { uid: 1, envelope: { to: [{ address: 'personal@icloud.com' }] }, bodyStructure: { type: 'text/plain' } };
    }
    async download(): Promise<{ meta: {}; content: AsyncIterable<Buffer> }> {
      return { meta: {}, content: (async function* () { yield Buffer.from('private Code: 654321'); })() };
    }
  }
  return { ImapFlow: FakeImapFlow };
});

beforeEach(() => {
  imapMockState.searchResult = [];
  imapMockState.junkSearchResult = [];
  imapMockState.lockPaths = [];
});

afterEach(() => {
  imapMockState.envelopeTo = undefined;
  vi.unstubAllGlobals();
});

function seedAccount(id = 'acc-1'): void {
  getDb().prepare(
    `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url, imap_user, imap_password)
     VALUES (?, 'me@icloud.com', 'X-APPLE=1', 'https://svc.test', 'me@icloud.com', 'pw')`,
  ).run(id);
}

function seedAddress(hme: string, accountId = 'acc-1', state = 'free'): void {
  getDb().prepare(
    `INSERT INTO icloud_addresses (hme, account_id, anonymous_id, state) VALUES (?, ?, ?, ?)`,
  ).run(hme, accountId, `anon-${hme}`, state);
}

describe('IcloudProvider pool', () => {
  it('advertises and allocates only active or unknown free aliases within the requested account/domain', async () => {
    seedAccount(); seedAccount('acc-other');
    seedAddress('inactive@privaterelay.appleid.com');
    seedAddress('active@icloud.com');
    seedAddress('legacy@private.icloud.com');
    seedAddress('other@privaterelay.appleid.com', 'acc-other');
    const db = getDb();
    db.prepare(`UPDATE icloud_addresses SET upstream_active = 0 WHERE hme = 'inactive@privaterelay.appleid.com'`).run();
    db.prepare(`UPDATE icloud_addresses SET upstream_active = 1 WHERE hme = 'active@icloud.com'`).run();
    db.prepare(`UPDATE icloud_accounts SET status = 'pending' WHERE id = 'acc-other'`).run();
    const provider = new IcloudProvider();
    expect((await provider.getDomains()).sort()).toEqual(['icloud.com', 'private.icloud.com']);
    await expect(provider.createInbox({ domain: 'privaterelay.appleid.com', account: 'acc-1', inboxId: 'bad' }))
      .rejects.toThrow(/no free iCloud address/i);
    expect((await provider.createInbox({ domain: 'icloud.com', account: 'acc-1', inboxId: 'active' })).address).toBe('active@icloud.com');
    expect((await provider.createInbox({ domain: 'private.icloud.com', inboxId: 'legacy' })).address).toBe('legacy@private.icloud.com');
    // Empty-held fallback remains the existing public domain-discovery contract.
    expect(await provider.getDomains()).toEqual(['icloud.com', 'private.icloud.com', 'privaterelay.appleid.com']);
  });

  it('rechecks the upstream activity condition when claiming a candidate that was just invalidated', async () => {
    seedAccount(); seedAddress('race@icloud.com');
    const db = getDb();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes('SELECT a.hme, a.account_id, a.anonymous_id')) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...params) => {
          const candidates = all(...params);
          prepare(`UPDATE icloud_addresses SET upstream_active = 0 WHERE hme = 'race@icloud.com'`).run();
          return candidates;
        });
      }
      return statement;
    });
    try {
      await expect(new IcloudProvider().createInbox({ inboxId: 'racing-owner' })).rejects.toThrow(/no free iCloud address/i);
      expect(prepare(`SELECT assigned_inbox_id, use_count FROM icloud_addresses`).get())
        .toEqual({ assigned_inbox_id: null, use_count: 0 });
    } finally { spy.mockRestore(); }
  });

  it.each([null, 1, 0].flatMap(active => ['assigned', 'retired', 'retiring'].map(state => ({ active, state }))))
    ('releases only assigned ownership, respecting upstream marker $active in state $state', async ({ active, state }) => {
      seedAccount(); seedAddress('release@icloud.com', 'acc-1', state);
      const db = getDb();
      db.prepare(`UPDATE icloud_addresses SET assigned_inbox_id = 'owner', assigned_at = '2026-01-01',
        use_count = 4, upstream_active = ?`).run(active);
      await new IcloudProvider().releaseInbox({} as InboxData, 'owner');
      expect(db.prepare(`SELECT state, assigned_inbox_id, assigned_at, use_count FROM icloud_addresses`).get()).toEqual({
        state: state === 'assigned' ? (active === 0 ? 'retired' : 'free') : state,
        assigned_inbox_id: state === 'assigned' ? null : 'owner',
        assigned_at: state === 'assigned' ? null : '2026-01-01', use_count: 4,
      });
    });

  it('claims a free address and marks it assigned to the inbox', async () => {
    seedAccount();
    seedAddress('one@icloud.com');

    const inbox = await new IcloudProvider().createInbox({ inboxId: 'ib-1' });

    expect(inbox.address).toBe('one@icloud.com');
    expect(inbox.authData.anonymousId).toBe('anon-one@icloud.com');
    const row = getDb().prepare(
      `SELECT state, assigned_inbox_id, use_count FROM icloud_addresses WHERE hme = 'one@icloud.com'`,
    ).get() as { state: string; assigned_inbox_id: string; use_count: number };
    expect(row.state).toBe('assigned');
    expect(row.assigned_inbox_id).toBe('ib-1');
    expect(row.use_count).toBe(1);
  });

  it('never hands the same address to two concurrent callers', async () => {
    seedAccount();
    seedAddress('a@icloud.com');
    seedAddress('b@icloud.com');

    const p = new IcloudProvider();
    const [first, second] = await Promise.all([
      p.createInbox({ inboxId: 'ib-a' }),
      p.createInbox({ inboxId: 'ib-b' }),
    ]);

    expect(first.address).not.toBe(second.address);
  });

  it('fails with a clear error rather than generating inline when the pool is empty', async () => {
    seedAccount();

    // Generating in the request path would turn Apple's rate limit into
    // request latency; an empty pool is a refill problem, not a caller problem.
    await expect(new IcloudProvider().createInbox({ inboxId: 'ib-x' }))
      .rejects.toThrow(/no free iCloud address/i);
  });

  it('returns a released address to the pool and hands it out again', async () => {
    seedAccount();
    seedAddress('recycle@icloud.com');
    const p = new IcloudProvider();

    const inbox = await p.createInbox({ inboxId: 'ib-1' });
    await p.releaseInbox(inbox, 'ib-1');

    const row = getDb().prepare(
      `SELECT state, assigned_inbox_id FROM icloud_addresses WHERE hme = 'recycle@icloud.com'`,
    ).get() as { state: string; assigned_inbox_id: string | null };
    expect(row.state).toBe('free');
    expect(row.assigned_inbox_id).toBeNull();

    const again = await p.createInbox({ inboxId: 'ib-2' });
    expect(again.address).toBe('recycle@icloud.com');
  });

  it('ignores a stale release for an address someone else now holds', async () => {
    seedAccount();
    seedAddress('contested@icloud.com');
    const p = new IcloudProvider();

    const first = await p.createInbox({ inboxId: 'ib-old' });
    await p.releaseInbox(first, 'ib-old');
    const second = await p.createInbox({ inboxId: 'ib-new' });
    expect(second.address).toBe('contested@icloud.com');

    // app.ts:537-553 re-releases an already-closed inbox a day after cleanup
    // closed it, so a replayed release is routine. Freeing by address would
    // hand this alias to a second live inbox and let each read the other's mail.
    await p.releaseInbox(first, 'ib-old');

    const row = getDb().prepare(
      `SELECT state, assigned_inbox_id FROM icloud_addresses WHERE hme = 'contested@icloud.com'`,
    ).get() as { state: string; assigned_inbox_id: string };
    expect(row.state).toBe('assigned');
    expect(row.assigned_inbox_id).toBe('ib-new');
  });

  it('honours the domain the dispatcher selected', async () => {
    seedAccount();
    seedAddress('a@privaterelay.appleid.com');
    seedAddress('b@icloud.com');

    // The dispatcher picks a domain only after filtering the block list, so
    // ignoring it here would quietly hand out an address on a blocked domain.
    const inbox = await new IcloudProvider().createInbox({ domain: 'icloud.com', inboxId: 'ib-1' });

    expect(inbox.address).toBe('b@icloud.com');
  });

  it('fails rather than substituting another domain when the requested one is exhausted', async () => {
    seedAccount();
    seedAddress('only@privaterelay.appleid.com');

    await expect(
      new IcloudProvider().createInbox({ domain: 'private.icloud.com', inboxId: 'ib-1' }),
    ).rejects.toThrow(/no free iCloud address/i);
  });

  it('treats the requested domain literally, so wildcards cannot slip a block', async () => {
    seedAccount();
    seedAddress('open@icloud.com');

    // With LIKE, a caller-supplied '%' matched every domain — including one
    // the block list had just filtered out of getDomains().
    await expect(
      new IcloudProvider().createInbox({ domain: '%', inboxId: 'ib-w' }),
    ).rejects.toThrow(/no free iCloud address/i);
    await expect(
      new IcloudProvider().createInbox({ domain: 'icloud.co_', inboxId: 'ib-u' }),
    ).rejects.toThrow(/no free iCloud address/i);
  });

  it('leaves a retiring address alone — it is on its way out at Apple', async () => {
    seedAccount();
    seedAddress('leaving@icloud.com', 'acc-1', 'retiring');

    // 'retiring' means the retire endpoint has claimed it and Apple may already
    // have deactivated it; handing it out now would give a tenant an alias that
    // silently receives nothing.
    await expect(new IcloudProvider().createInbox({ inboxId: 'ib-r' }))
      .rejects.toThrow(/no free iCloud address/i);
  });

  it('does not call Apple when an inbox is explicitly deleted', async () => {
    seedAccount();
    seedAddress('keep@icloud.com');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = new IcloudProvider();
    const inbox = await p.createInbox({ inboxId: 'ib-1' });

    await p.deleteInbox(inbox);

    // Deleting at Apple would permanently burn one of the account's 750 slots
    // every time a user tidies up, which destroys the premise of recycling.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('IcloudProvider reading', () => {
  it.each(['', ' \t\n'].flatMap(address => ['list', 'detail'].map(entry => ({ address, entry }))))
  ('rejects blank iCloud recipient scope before the $entry transport: $address', async ({ address, entry }) => {
    seedAccount('blank-scope-account');
    imapMockState.searchResult = [1];
    const inbox: InboxData = { address, provider: 'icloud', apiBase: '', authData: { icloudAccountId: 'blank-scope-account' } };
    const before = imapMockState.connectCount;
    const provider = new IcloudProvider();
    const result = entry === 'list' ? provider.getMessages(inbox) : provider.getMessage(inbox, encodeMailboxMessageId(JUNK_PATH, '1'));
    await expect(result).rejects.toThrow('Message not found');
    expect(imapMockState.connectCount).toBe(before);
    expect(imapMockState.lockPaths).toEqual([]);
  });

  it('searches the forward-to mailbox by the alias', async () => {
    seedAccount();
    seedAddress('read@icloud.com');
    imapMockState.searchResult = [7];
    imapMockState.envelopeTo = [{ address: 'read@icloud.com' }];
    const p = new IcloudProvider();
    const inbox = await p.createInbox({ inboxId: 'ib-1' });

    const messages = await p.getMessages(inbox);

    expect(imapMockState.lastSearch).toEqual(hmeSearchCriteria('read@icloud.com'));
    expect(messages).toHaveLength(1);
    expect(decodeMailboxMessageId(messages[0].id)).toEqual({ mailbox: 'INBOX', uid: '7' });
  });

  // The incident this whole path exists to prevent. On 2026-08-23 four aliases
  // on the live account received codes — the code was in the subject line —
  // and Gmail filed every one of them under 垃圾邮件. Polling read INBOX only,
  // reported an empty mailbox each time, and the caller reported four
  // failures against a provider that had in fact received all four mails.
  it('finds a code the forwarding mailbox filed as spam', async () => {
    seedAccount();
    seedAddress('junked@icloud.com');
    imapMockState.searchResult = [];
    imapMockState.junkSearchResult = [2455];
    imapMockState.envelopeTo = [{ address: 'junked@icloud.com' }];
    const provider = new IcloudProvider();
    const inbox = await provider.createInbox({ inboxId: 'ib-junk' });

    const messages = await provider.getMessages(inbox);
    const adminRes = await app.request(
      '/api/icloud/addresses/junked@icloud.com/messages',
      { headers: authHeaders() },
    );
    const adminBody = await adminRes.json() as { messages: { id: string }[] };

    expect(messages).toHaveLength(1);
    expect(decodeMailboxMessageId(messages[0].id)).toEqual({ mailbox: JUNK_PATH, uid: '2455' });
    expect(imapMockState.lockPaths.slice(0, 2)).toEqual(['INBOX', JUNK_PATH]);
    // The admin address viewer reads through the same function, so it can
    // never disagree with what a tenant polling the address sees.
    expect(adminBody.messages.map((m) => m.id)).toEqual([messages[0].id]);
  });

  it('refuses an id naming a folder of the operator´s own mail', async () => {
    seedAccount();
    seedAddress('boundary@icloud.com');
    const provider = new IcloudProvider();
    const inbox = await provider.createInbox({ inboxId: 'ib-boundary' });

    // strictRecipient already hides anything not addressed to the alias, but
    // the forwarding mailbox is the operator's personal account: the mailbox
    // an id names is checked against the two the listing reads, not trusted.
    await expect(provider.getMessage(inbox, encodeMailboxMessageId('账单', '1'))).rejects.toThrow(
      /Invalid IMAP message id/,
    );
    expect(imapMockState.lockPaths).toEqual([]);
  });

  it('hides unverifiable personal-mailbox messages from tenant and admin lists', async () => {
    seedAccount();
    seedAddress('private-boundary@icloud.com');
    imapMockState.searchResult = [8];
    imapMockState.envelopeTo = undefined;
    const provider = new IcloudProvider();
    const inbox = await provider.createInbox({ inboxId: 'ib-private' });

    const messages = await provider.getMessages(inbox);
    const adminRes = await app.request(
      '/api/icloud/addresses/private-boundary@icloud.com/messages',
      { headers: authHeaders() },
    );
    const adminBody = await adminRes.json() as { messages: unknown[] };

    expect(messages).toEqual([]);
    expect(adminRes.status).toBe(200);
    expect(adminBody.messages).toEqual([]);
  });
});

describe('IcloudProvider metadata', () => {
  it('stays out of automatic dispatch because it is a paid tier', () => {
    // registry.register derives this from meta.tier; the assertion guards the
    // tier, not a hand-written config row.
    const row = getDb().prepare(
      `SELECT auto_dispatch FROM provider_config WHERE provider = 'icloud'`,
    ).get() as { auto_dispatch: number } | undefined;
    expect(row?.auto_dispatch).toBe(0);
  });

  it('is a paid provider that reports the domains Apple may issue', async () => {
    const meta = new IcloudProvider().meta;
    expect(meta.name).toBe('icloud');
    expect(meta.tier).toBe('paid');

    seedAccount();
    const domains = await new IcloudProvider().getDomains();
    // Apple is migrating both Hide My Email and Sign in with Apple onto
    // private.icloud.com while keeping the older domains working.
    expect(domains).toEqual(expect.arrayContaining(['icloud.com', 'private.icloud.com']));
  });
});

describe('IcloudProvider domain availability', () => {
  it('names the account problem instead of looking like an empty provider', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, status, last_error)
       VALUES ('acc-bad', 'me@icloud.com', 'error', 'IMAP: authentication rejected')`,
    ).run();

    // An empty domain list reaches the caller as the dispatcher's generic
    // "no address available", which reads as "this provider has nothing" even
    // when the pool is full and only the account check failed. Say that the
    // account is the problem — but not what the problem is.
    await expect(new IcloudProvider().getDomains()).rejects.toThrow(/not usable/);

    // last_error is admin-only: imapHint writes the operator's own forwarding
    // mailbox into it, and this error travels all the way out to any API-key
    // holder through the dispatcher.
    await expect(new IcloudProvider().getDomains())
      .rejects.not.toThrow(/authentication rejected/);
  });

  it('tells the operator to test an account that never has been', async () => {
    getDb().prepare(
      `INSERT INTO icloud_accounts (id, apple_id, status) VALUES ('acc-new', 'me@icloud.com', 'pending')`,
    ).run();

    await expect(new IcloudProvider().getDomains()).rejects.toThrow(/has not been tested yet/);
  });

  it('stays quiet when no account exists at all', async () => {
    await expect(new IcloudProvider().getDomains()).resolves.toEqual([]);
  });
});
