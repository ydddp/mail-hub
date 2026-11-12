import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { app, authHeaders } from './helpers/http.js';
import { hashApiKey } from '../src/crypto.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { fetchAccountMailboxPage, resetTokenCache } from '../src/providers/outlook.js';
import { evictClient } from '../src/providers/imap-core.js';

const imap = vi.hoisted(() => ({ validity: '71', selected: 'INBOX', fresh: false, searches: [] as any[], fail: false, reverseDates: false }));
vi.mock('imapflow', () => ({ ImapFlow: class {
  get mailbox() { return { uidValidity: BigInt(imap.validity), uidNext: imap.fresh ? 5 : 4 }; }
  async connect() {} once() {} async logout() {} close() {}
  async list() { return [{ path: 'INBOX' }, { path: 'Junk', specialUse: '\\Junk' }]; }
  async getMailboxLock(path: string) { imap.selected = path; return { release() {} }; }
  async search(criteria: any) {
    imap.searches.push(criteria);
    const upper = criteria.uid ? Number(String(criteria.uid).split(':')[1]) : 99;
    return (imap.selected === 'Junk' ? [1, 2] : imap.fresh ? [1, 2, 3, 4] : [1, 2, 3]).filter(uid => uid <= upper);
  }
  async *fetch(uids: number[]) {
    if (imap.fail) throw new Error('IMAP history page unavailable');
    for (const uid of uids) yield { uid, internalDate: new Date(`2026-06-05T00:02:${String(imap.reverseDates ? 20 - uid * 2 : imap.selected === 'INBOX' ? uid * 2 : uid * 2 - 1).padStart(2, '0')}Z`), envelope: { subject: `${imap.selected}-${uid}`, to: [{ address: account }] } };
  }
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); imap.validity = '71'; imap.fresh = false; imap.searches = []; imap.fail = false; imap.reverseDates = false; evictClient(`outlook:${account}`); });
const account = 'history-page@outlook.com';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const mail = (id: string, second: number) => ({ id, subject: id, receivedDateTime: `2026-06-05T00:02:${String(second).padStart(2, '0')}Z`, toRecipients: [{ emailAddress: { address: account } }] });
function seed(api = 'graph', email = account) {
  getDb().prepare(`INSERT INTO outlook_accounts (email,password,client_id,refresh_token,api_type) VALUES (?,'pw','history-client',?,?)`).run(email, `${email}-${Math.random()}`, api);
}
function request(query = '', email = account, key = 'admin-secret') { return app.request(`/api/outlook/accounts/${encodeURIComponent(email)}/mailbox${query ? `?${query}` : ''}`, { headers: authHeaders(key) }); }

describe('administrator Outlook history continuation', () => {
  it.each(['graph', 'outlook', 'imap'].flatMap(api => [false, true].map(fail => ({ api, fail }))))
  ('preserves retry and cached replay after a normal $api token rotation (failure=$fail)', async ({ api, fail }) => {
    seed(api); let refreshes = 0; let pageReads = 0; let rejectOld = false; let unavailable = false;
    const root = api === 'graph' ? 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages' : 'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages';
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: `token-${++refreshes}`, refresh_token: `rotated-${refreshes}` });
      pageReads++;
      if (String(url).includes('junkemail')) return json({ value: [] });
      if (String(url).includes('$skiptoken=2')) {
        if (rejectOld && new Headers(options.headers).get('Authorization') === 'Bearer token-1') return json({}, 401);
        return unavailable ? json({}, 503) : json({ value: [mail('B', 4)] });
      }
      return json({ value: [mail('A', 5)], '@odata.nextLink': `${root}?$skiptoken=2` });
    }));
    const firstResponse = await request('limit=1');
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    rejectOld = true; unavailable = fail; imap.fail = fail;
    if (api === 'imap') resetTokenCache();
    const query = `pageToken=${first.nextPageToken}`;
    if (fail) { expect((await request(query)).status).toBe(502); unavailable = false; imap.fail = false; }
    const response = await request(query);
    expect(response.status).toBe(200);
    const second = await response.json();
    expect(second.messages[0][api === 'imap' ? 'subject' : 'id']).toBe(api === 'imap' ? 'INBOX-2' : 'B');
    expect(refreshes).toBe(2);
    const count = pageReads;
    expect(await (await request(query)).json()).toEqual(second);
    expect(pageReads).toBe(count);
    getDb().prepare("UPDATE outlook_accounts SET refresh_token='operator-replaced' WHERE email=?").run(account);
    expect((await request(query)).status).toBe(502);
  });

  it.each([1, 2])('keeps existing nonmonotonic IMAP dates across %i-message pages while excluding new UIDs', async limit => {
    seed('imap'); imap.reverseDates = true;
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'history-token' })));
    let page = await (await request(`limit=${limit}`)).json();
    const subjects: string[] = [];
    imap.fresh = true;
    for (let n = 0; n < 8; n++) {
      subjects.push(...page.messages.map((message: any) => message.subject));
      const times = page.messages.map((message: any) => Date.parse(message.receivedAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      if (!page.nextPageToken) break;
      page = await (await request(`pageToken=${page.nextPageToken}`)).json();
    }
    expect(page.nextPageToken).toBeNull();
    expect(subjects.sort()).toEqual(['INBOX-1', 'INBOX-2', 'INBOX-3', 'Junk-1', 'Junk-2']);
  });

  it('retains the single credential refresh retry and charges each attempted HTTP page', async () => {
    seed(); let refreshes = 0; let pages = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: `history-token-${++refreshes}` });
      pages++;
      if (new Headers(options.headers).get('Authorization') === 'Bearer history-token-1') return json({}, 401);
      return json({ value: String(url).includes('junkemail') ? [] : [mail('A', 5)] });
    }));
    const response = await request('limit=1');
    expect(response.status).toBe(200); expect((await response.json()).messages[0].id).toBe('A');
    expect(refreshes).toBe(2); expect(pages).toBe(3);
    expect(rateLimiter.getPollStatus('outlook').currentCount).toBe(3);
  });

  it.each(['response', 'body'])('bounds a stalled history %s and lets the same token retry', async stalled => {
    seed(); vi.useFakeTimers(); let stall = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'history-token' });
      if (target.includes('junkemail')) return json({ value: [] });
      if (!target.includes('$skiptoken=2')) return json({ value: [mail('A', 5)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$skiptoken=2' });
      if (stall && stalled === 'response') return new Promise<Response>(() => {});
      const response = json({ value: [mail('B', 4)] });
      if (stall) response.json = () => new Promise(() => {});
      return response;
    }));
    const first = await (await request('limit=1')).json();
    const pending = request(`pageToken=${first.nextPageToken}`);
    await vi.advanceTimersByTimeAsync(30100);
    expect((await pending).status).toBe(502);
    stall = false;
    expect((await (await request(`pageToken=${first.nextPageToken}`)).json()).messages[0].id).toBe('B');
  });

  it('checks current credentials before returning a cached token page', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/oauth2/') ? json({ access_token: 'history-token' }) : json({ value: String(url).includes('junkemail') ? [] : [mail('A', 5), mail('B', 4)] })));
    const first = await (await request('limit=1')).json();
    expect((await request(`pageToken=${first.nextPageToken}`)).status).toBe(200);
    getDb().prepare(`UPDATE outlook_accounts SET refresh_token='replaced' WHERE email=?`).run(account);
    const replay = await request(`pageToken=${first.nextPageToken}`);
    expect(replay.status).toBe(502); expect((await replay.json()).error).toMatch(/credentials changed.*reload/i);
  });
  it('pages backwards through IMAP UID boundaries and gets new mail only on refresh', async () => {
    seed('imap');
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'history-token' })));
    const first = await (await request('limit=2')).json();
    expect(first.messages.map((value: any) => value.subject)).toEqual(['INBOX-3', 'INBOX-2']);
    imap.fresh = true;
    const second = await (await request(`pageToken=${first.nextPageToken}`)).json();
    expect(second.messages.map((value: any) => value.subject)).toEqual(['Junk-2', 'INBOX-1']);
    const third = await (await request(`pageToken=${second.nextPageToken}`)).json();
    expect(third.messages.map((value: any) => value.subject)).toEqual(['Junk-1']);
    expect(third.nextPageToken).toBeNull();
    expect(imap.searches.some(criteria => criteria.uid === '1:1')).toBe(true);
    expect((await (await request('limit=2')).json()).messages[0].subject).toBe('INBOX-4');
  });

  it('invalidates an IMAP history continuation after UIDVALIDITY changes', async () => {
    seed('imap'); vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'history-token' })));
    const first = await (await request('limit=1')).json(); imap.validity = '72';
    const response = await request(`pageToken=${first.nextPageToken}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/UIDVALIDITY.*reload/i) });
  });

  it('keeps a failed IMAP page retryable with the same token', async () => {
    seed('imap'); vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'history-token' })));
    const first = await (await request('limit=1')).json(); imap.fail = true;
    expect((await request(`pageToken=${first.nextPageToken}`)).status).toBe(502);
    imap.fail = false;
    expect((await (await request(`pageToken=${first.nextPageToken}`)).json()).messages[0].subject).toBe('INBOX-2');
  });

  it.each(['expired', 'wrong administrator'])('rejects a %s token without reading upstream', async invalid => {
    seed(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'history-token' });
      reads++; return json({ value: String(url).includes('junkemail') ? [] : [mail('A', 5), mail('B', 4)] });
    }));
    const first = await fetchAccountMailboxPage(account, 'admin-A', 1); const count = reads;
    if (invalid === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600001); }
    await expect(fetchAccountMailboxPage(account, invalid === 'expired' ? 'admin-A' : 'admin-B', 1, first.nextPageToken!)).rejects.toThrow(/reload/i);
    expect(reads).toBe(count);
  });

  it('evicts the least recently used token after 100 active states', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/oauth2/') ? json({ access_token: 'history-token' }) : json({ value: String(url).includes('junkemail') ? [] : [mail('A', 5), mail('B', 4)] })));
    const tokens: string[] = [];
    for (let n = 0; n < 100; n++) { rateLimiter.reset(); tokens.push((await fetchAccountMailboxPage(account, 'admin-A', 1)).nextPageToken!); }
    await fetchAccountMailboxPage(account, 'admin-A', 1, tokens[0]);
    rateLimiter.reset(); await fetchAccountMailboxPage(account, 'admin-A', 1);
    await expect(fetchAccountMailboxPage(account, 'admin-A', 1, tokens[1])).rejects.toThrow(/reload/i);
    await expect(fetchAccountMailboxPage(account, 'admin-A', 1, tokens[0])).resolves.toMatchObject({ messages: [{ id: 'B' }] });
  });

  it.each([429, 503])('retries a failed HTTP continuation %s without advancing the token', async status => {
    seed(); let fail = true; let continuationReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'history-token' });
      if (target.includes('junkemail')) return json({ value: [] });
      if (target.includes('$skiptoken=2')) { continuationReads++; return fail ? new Response('{}', { status, headers: { 'Retry-After': '7' } }) : json({ value: [mail('B', 4)] }); }
      return json({ value: [mail('A', 5)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$skiptoken=2' });
    }));
    const first = await (await request('limit=1')).json();
    const response = await request(`pageToken=${first.nextPageToken}`);
    expect(response.status).toBe(status === 429 ? 429 : 502);
    if (status === 429) expect(response.headers.get('Retry-After')).toBe('7');
    fail = false;
    const second = await (await request(`pageToken=${first.nextPageToken}`)).json();
    expect(second.messages[0].id).toBe('B'); expect(second.nextPageToken).toBeNull();
    expect(continuationReads).toBe(2);
  });

  it('fixes the transport after first-page Graph rejection discovers REST', async () => {
    seed(''); const hosts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'history-token' });
      hosts.push(new URL(target).hostname);
      if (target.includes('graph.microsoft.com')) return json({}, 401);
      if (target.includes('junkemail')) return json({ value: [] });
      if (target.includes('$skiptoken=2')) return json({ value: [mail('B', 4)] });
      return json({ value: [mail('A', 5)], '@odata.nextLink': 'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages?$skiptoken=2' });
    }));
    const first = await (await request('limit=1')).json();
    expect(first.messages[0].id).toBe('A');
    const before = hosts.length;
    expect((await (await request(`pageToken=${first.nextPageToken}`)).json()).messages[0].id).toBe('B');
    expect(hosts.slice(before).every(host => host === 'outlook.office.com')).toBe(true);
  });

  it.each([
    'https://evil.test/v1.0/me/mailFolders/Inbox/messages',
    'http://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages',
    'https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages',
    'https://graph.microsoft.com:444/v1.0/me/mailFolders/Inbox/messages',
    'https://graph.microsoft.com/v1.0/users/other/messages',
    'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages',
  ])('rejects malicious or cross-API history nextLink %s before following it', async next => {
    seed(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'history-token' });
      reads++; return json({ value: [mail('A', 5)], '@odata.nextLink': next });
    }));
    expect((await request()).status).toBe(502); expect(reads).toBe(1);
  });

  it('does not jump back to new mail during continuation, while refresh sees it', async () => {
    seed(); let fresh = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'history-token' });
      if (target.includes('junkemail')) return json({ value: [] });
      if (target.includes('$skiptoken=2')) return json({ value: [...(fresh ? [mail('NEW', 9)] : []), mail('B', 4)] });
      return json({ value: [fresh ? mail('NEW', 9) : mail('A', 5)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$skiptoken=2' });
    }));
    const first = await (await request('limit=1')).json(); fresh = true;
    expect((await (await request(`pageToken=${first.nextPageToken}`)).json()).messages.map((value: any) => value.id)).toEqual(['B']);
    expect((await (await request('limit=1')).json()).messages[0].id).toBe('NEW');
  });
  it.each(['graph', 'outlook'].flatMap(api => [false, true].map(canonical => ({ api, canonical }))))('merges interleaved $api folders and replays a token (canonical=$canonical)', async ({ api, canonical }) => {
    seed(api); const reads: string[] = [];
    const root = api === 'graph' ? 'https://graph.microsoft.com/v1.0/me/mailFolders/' : 'https://outlook.office.com/api/v2.0/me/mailfolders/';
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'history-token' });
      reads.push(target); expect(opts.redirect).toBe('error');
      if (target.includes('junkemail')) return json({ value: [mail('B', 5), mail('D', 3)] });
      if (target.includes('$skiptoken=older')) return json({ value: [mail('E', 2)] });
      const folder = canonical ? root.replace(/\/mailfolders\/$/i, "/mailFolders('opaque-folder-id')") : `${root}${api === 'graph' ? 'Inbox' : 'inbox'}`;
      return json({ value: [mail('A', 6), mail('C', 4)], '@odata.nextLink': `${folder}/messages?$skiptoken=older` });
    }));
    const first = await (await request('limit=2')).json();
    expect(first.messages.map((value: any) => value.id)).toEqual(['A', 'B']);
    expect(first).toMatchObject({ email: account, limit: 2, nextPageToken: expect.any(String), leases: [] });
    const token = first.nextPageToken;
    const second = await (await request(`limit=99&pageToken=${token}`)).json();
    expect(second.messages.map((value: any) => value.id)).toEqual(['C', 'D']);
    expect(second.limit).toBe(2);
    const count = reads.length;
    expect(await (await request(`pageToken=${token}`)).json()).toEqual(second);
    expect(reads).toHaveLength(count);
    const third = await (await request(`pageToken=${second.nextPageToken}`)).json();
    expect(third.messages.map((value: any) => value.id)).toEqual(['E']);
    expect(third.nextPageToken).toBeNull();
    expect(rateLimiter.getPollStatus('outlook').currentCount).toBe(reads.length);
  });

  it('keeps equal-time messages on both sides of a page boundary without dropping duplicate IDs', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/oauth2/') ? json({ access_token: 'history-token' })
      : json({ value: String(url).includes('junkemail') ? [mail('B', 5), mail('C', 5)] : [mail('A', 5), mail('B', 5)] })));
    const first = await (await request('limit=1')).json();
    const second = await (await request(`pageToken=${first.nextPageToken}`)).json();
    const third = await (await request(`pageToken=${second.nextPageToken}`)).json();
    expect([first, second, third].flatMap(result => result.messages.map((value: any) => value.id))).toEqual(['A', 'B', 'C']);
    expect(third.nextPageToken).toBeNull();
  });

  it('rejects unknown/account-mismatched tokens and ordinary user keys before upstream reads', async () => {
    seed(); seed('graph', 'other-history@outlook.com');
    getDb().prepare(`INSERT INTO api_keys (key,name) VALUES (?,'history user')`).run(hashApiKey('history-user'));
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'history-token' });
      reads++; return json({ value: String(url).includes('junkemail') ? [] : [mail('A', 5), mail('B', 4)] });
    }));
    const first = await (await request('limit=1')).json(); const count = reads;
    expect((await request('pageToken=unknown')).status).toBe(400);
    expect((await request(`pageToken=${first.nextPageToken}`, 'other-history@outlook.com')).status).toBe(400);
    expect((await request(`pageToken=${first.nextPageToken}`, account, 'history-user')).status).toBe(403);
    expect(reads).toBe(count);
  });
});
