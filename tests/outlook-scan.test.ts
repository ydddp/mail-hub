import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { app, authHeaders } from './helpers/http.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { OutlookProvider } from '../src/providers/outlook.js';
import { evictClient } from '../src/providers/imap-core.js';
import type { MailboxScanControl } from '../src/providers/base.js';

const imapState = vi.hoisted(() => ({ validity: '11', selected: 'INBOX', ranges: [] as number[][], searches: [] as unknown[], change: false, count: 24, failJunk: false, detailClose: false, bodyFailure: false, downloads: 0 }));
vi.mock('imapflow', () => ({ ImapFlow: class {
  get mailbox() { return { uidValidity: BigInt(imapState.validity) }; }
  async connect() {} once() {} async logout() {} close() {}
  async list() { return [{ path: 'INBOX' }, { path: 'Junk', specialUse: '\\Junk' }]; }
  async getMailboxLock(path: string) { if (path === 'Junk' && imapState.failJunk) throw new Error('Junk unavailable'); imapState.selected = path; return { release() {} }; }
  async search(criteria: unknown) { imapState.searches.push(criteria); return imapState.selected === 'INBOX' ? Array.from({ length: imapState.count }, (_, i) => i + 1) : []; }
  async *fetch(range: number[]) {
    imapState.ranges.push(range);
    for (const uid of range) yield { uid, internalDate: new Date('2026-06-05T00:02:00Z'), envelope: { to: [{ address: uid === 24 ? `prefix${recipient}` : recipient }], subject: 'notification' } };
    if (imapState.change) imapState.validity = '12';
  }
  async fetchOne() {
    if (imapState.detailClose) getDb().prepare(`UPDATE inboxes SET status='closed' WHERE id='scan'`).run();
    return { uid: 1, internalDate: new Date('2026-06-05T00:02:00Z'), envelope: { to: [{ address: recipient }] }, bodyStructure: { type: 'text/plain' } };
  }
  async download() { imapState.downloads++; if (imapState.bodyFailure) throw new Error('body unavailable'); return { meta: {}, content: (async function* () { yield Buffer.from('Code 654321'); })() }; }
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); evictClient(`outlook:${email}`); imapState.validity = '11'; imapState.change = false; imapState.ranges = []; imapState.searches = []; imapState.count = 24; imapState.failJunk = false; imapState.detailClose = false; imapState.bodyFailure = false; imapState.downloads = 0; });
const email = 'scan@outlook.com';
const recipient = 'scan+lease@outlook.com';
const graphInbox = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages';
const graphJunk = 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function seed(api = 'graph') {
  getDb().prepare(`INSERT INTO outlook_accounts (email,password,client_id,refresh_token,api_type,assigned_inbox_id) VALUES (?,'pw','scan-client','scan-refresh',?,'scan')`).run(email, api);
  getDb().prepare(`INSERT INTO inboxes (id,provider,address,auth_data,created_at,expires_at) VALUES ('scan','outlook',?,?,'2026-06-05 00:00:00','2099-01-01 00:00:00')`).run(recipient, JSON.stringify({ email }));
}
function mail(id: string, address = recipient, received = '2026-06-05T00:02:00Z') {
  return { id, subject: 'notification', receivedDateTime: received, toRecipients: [{ emailAddress: { address } }] };
}
function request(query = '') { return app.request(`/api/inbox/scan/code?selection=matching${query}`, { headers: authHeaders() }); }

describe('bounded Outlook matching scan', () => {
  it.each(['latest', 'matching'].flatMap(selection => ['oauth', 'body'].map(phase => ({ selection, phase }))))('propagates the $selection route deadline into $phase', async ({ selection, phase }) => {
    seed(); vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const upstream = vi.fn(async (url: string, options: RequestInit) => {
      if (phase === 'body' && url.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      if (phase === 'body' && url.includes('junkemail')) return json({ value: [] });
      transportSignal = options.signal!;
      if (phase === 'body') return new Response(new ReadableStream({ start() {} }));
      return new Promise<Response>((_, reject) => transportSignal!.addEventListener('abort', () => reject(transportSignal!.reason), { once: true }));
    });
    vi.stubGlobal('fetch', upstream);
    const pending = app.request(`/api/inbox/scan/code?selection=${selection}&timeout=1`, { headers: authHeaders() });
    await vi.advanceTimersByTimeAsync(1001);
    const response = await pending;
    expect(response.status).toBe(selection === 'matching' ? 200 : 502);
    expect(transportSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(upstream).toHaveBeenCalledTimes(phase === 'oauth' ? 1 : selection === 'matching' ? 2 : 3);
  });
  it.each([{}, { value: null }, { value: {} }, { value: 'not a list' }])('does not report no-code for a malformed list payload %#', async payload => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/oauth2/') ? json({ access_token: 'scan-token' }) : json(payload)));
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/malformed/i), scan: { complete: false, reason: 'error' } });
  });
  it('keeps IMAP UIDVALIDITY snapshots across wait rounds of the same request', async () => {
    seed('imap'); imapState.count = 0;
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'scan-token' })));
    const control: MailboxScanControl = { budget: { pages: 0, metadata: 0 }, checkpoint() {}, run: operation => operation(), read: operation => operation() };
    const provider = new OutlookProvider();
    const box = { address: recipient, authData: { email }, provider: 'outlook', apiBase: '' };
    await provider.scanMessages(box, control);
    imapState.validity = '12';
    await expect(provider.scanMessages(box, control)).rejects.toThrow(/UIDVALIDITY.*reload/i);
  });

  it.each(['folder failure', 'body failure', 'lease closed during detail'])('keeps IMAP matching %s explicit and prevents later body reads', async mode => {
    seed('imap'); imapState.count = 1;
    imapState.failJunk = mode === 'folder failure'; imapState.bodyFailure = mode === 'body failure'; imapState.detailClose = mode === 'lease closed during detail';
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'scan-token' })));
    const response = await request();
    expect(response.status).toBe(mode === 'lease closed during detail' ? 200 : 502);
    const data = await response.json();
    if (mode === 'lease closed during detail') { expect(data.codes).toEqual([]); expect(imapState.downloads).toBe(0); }
    else expect(data.error).toMatch(mode === 'folder failure' ? /Junk/ : /body unavailable/);
  });

  it('persists REST discovery so detail reads use the successful transport', async () => {
    seed(''); const detailHosts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      if (target.includes('/me/messages/')) detailHosts.push(new URL(target).hostname);
      if (target.includes('graph.microsoft.com')) return json({}, 401);
      if (target.includes('/me/messages/')) return json({ ...mail('target'), body: { content: 'Code 654321', contentType: 'text' } });
      return json({ value: /\/inbox\//i.test(target) ? [mail('target')] : [] });
    }));
    const response = await request();
    expect(response.status).toBe(200); expect((await response.json()).messageId).toBe('target');
    expect(detailHosts).toEqual(['outlook.office.com']);
    expect(getDb().prepare('SELECT api_type FROM outlook_accounts WHERE email=?').get(email)).toEqual({ api_type: 'outlook' });
  });

  it('orders equal-time IDs by code units, independent of locale', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/oauth2/') ? json({ access_token: 'scan-token' }) : json({ value: String(url).includes('/Inbox/') ? [mail('a'), mail('Z')] : [] })));
    const control: MailboxScanControl = { budget: { pages: 0, metadata: 0 }, checkpoint() {}, run: operation => operation(), read: operation => operation() };
    const result = await new OutlookProvider().scanMessages({ address: recipient, authData: { email }, provider: 'outlook', apiBase: '' }, control);
    expect(result.messages.map(message => message.id)).toEqual(['Z', 'a']);
  });

  it.each(['response', 'json', 'detail json'])('bounds a stalled %s await by the request timeout', async stalled => {
    seed(); vi.useFakeTimers(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++;
      const detail = String(url).includes('/me/messages/');
      if (stalled === 'response') return new Promise<Response>(() => {});
      const response = json(detail ? { ...mail('A'), body: { content: 'Code 654321' } } : { value: String(url).includes('junkemail') ? [] : [mail('A')] });
      if (stalled === 'json' || (detail && stalled === 'detail json')) response.json = () => new Promise(() => {});
      return response;
    }));
    const pending = request('&timeout=1');
    await vi.advanceTimersByTimeAsync(1100);
    expect(await (await pending).json()).toMatchObject({ codes: [], scan: { reason: 'timeout', complete: false, scope: 'inbox_and_junk', pages: stalled === 'detail json' ? 2 : 1, metadata: stalled === 'detail json' ? 1 : 0, partial: true } });
    expect(reads).toBe(stalled === 'detail json' ? 3 : 1);
  });

  it('rechecks a closed lease before consuming an HTTP detail body', async () => {
    seed(); let detailJson = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      if (String(url).includes('/me/messages/')) {
        getDb().prepare(`UPDATE inboxes SET status='closed' WHERE id='scan'`).run();
        const response = json({ ...mail('A'), body: { content: 'Code 654321', contentType: 'text' } });
        response.json = async () => { detailJson++; return {}; };
        return response;
      }
      return json({ value: String(url).includes('junkemail') ? [] : [mail('A')] });
    }));
    expect((await (await request()).json()).codes).toEqual([]);
    expect(detailJson).toBe(0);
  });

  it.each([429, 503])('includes live scan metadata when detail fails with %s', async status => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      if (String(url).includes('/me/messages/')) return new Response('{}', { status, headers: { 'Retry-After': '13' } });
      return json({ value: String(url).includes('junkemail') ? [] : [mail('A')] });
    }));
    const response = await request();
    expect(response.status).toBe(status === 429 ? 429 : 502);
    if (status === 429) expect(response.headers.get('Retry-After')).toBe('13');
    expect(await response.json()).toMatchObject({ scan: { scope: 'inbox_and_junk', checked: 1, pages: 2, metadata: 1, complete: false, partial: true, truncated: false, reason: 'error', folders: [{ folder: 'Inbox', complete: true }, { folder: 'Junk', complete: true }] } });
  });

  it.each(['close', 'abort', 'timeout'])('reports current counters and folder progress for a stopped later round: %s', async stop => {
    seed(); vi.useFakeTimers(); let reads = 0;
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++;
      const response = json({ value: [] });
      if (reads === 3) response.json = async () => {
        if (stop === 'close') getDb().prepare(`UPDATE inboxes SET status='closed' WHERE id='scan'`).run();
        if (stop === 'abort') controller.abort();
        if (stop === 'timeout') return new Promise(() => {});
        return { value: [] };
      };
      return response;
    }));
    const pending = app.request('/api/inbox/scan/code?selection=matching&wait=true&timeout=5', { headers: authHeaders(), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5100);
    const response = await pending;
    expect(await response.json()).toMatchObject({ codes: [], scan: { scope: 'inbox_and_junk', pages: 3, metadata: 0, complete: false, partial: true, reason: stop === 'close' ? 'window_exhausted' : 'timeout', folders: [{ folder: 'Inbox', complete: false }, { folder: 'Junk', complete: false }] } });
    expect(reads).toBe(3);
  });

  it('charges each list page to the existing shared limiter and stops before a denied page', async () => {
    seed(); const provider = new OutlookProvider(); provider.meta.rateLimit.pollPerMinute = 2;
    const { registry } = await import('../src/providers/registry.js'); registry.register(provider);
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++; return json({ value: [], '@odata.nextLink': `${String(url).includes('junkemail') ? graphJunk : graphInbox}?$skiptoken=${reads}` });
    }));
    expect((await request()).status).toBe(429); expect(reads).toBe(2);
    expect(rateLimiter.getPollStatus('outlook').currentCount).toBe(2);
  });

  it('does not retry an upstream network failure under one page charge', async () => {
    seed(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++; throw new TypeError('network unavailable');
    }));
    expect((await request()).status).toBe(502); expect(reads).toBe(1);
  });
  it('pages only matching IMAP UIDs, checks exact recipients and binds detail IDs to UIDVALIDITY', async () => {
    seed('imap');
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'scan-token' })));
    const control: MailboxScanControl = { budget: { pages: 0, metadata: 0 }, checkpoint() {}, run: operation => operation(), read: operation => operation() };
    const provider = new OutlookProvider();
    const box = { address: recipient, authData: { email }, provider: 'outlook', apiBase: '' };
    const result = await provider.scanMessages(box, control);
    expect(result.scan).toMatchObject({ pages: 3, metadata: 24, complete: true });
    expect(result.messages).toHaveLength(23);
    expect(imapState.ranges.map(range => range.length)).toEqual([20, 4]);
    expect(imapState.searches.every(criteria => JSON.stringify(criteria) === JSON.stringify({ or: [{ to: recipient }, { cc: recipient }] }))).toBe(true);
    imapState.validity = '12';
    await expect(provider.getMessage(box, result.messages[0].id)).rejects.toThrow(/UIDVALIDITY.*reload/i);
  });

  it('fails an IMAP continuation when the mailbox UIDVALIDITY changes', async () => {
    seed('imap'); imapState.change = true;
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'scan-token' })));
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/UIDVALIDITY.*reload/i) });
    expect(imapState.ranges).toHaveLength(1);
  });
  it.each(['graph', 'outlook'].flatMap(api => [false, true].map(canonical => ({ api, canonical }))))('finds the 21st mailbox message through $api pages (canonical=$canonical)', async ({ api, canonical }) => {
    seed(api);
    const reads: string[] = [];
    const base = api === 'graph' ? graphInbox : 'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages';
    const next = `${base}?$skiptoken=page2`;
    // Microsoft Graph returns a folder ID in OData key syntax, not /Inbox/.
    const upstreamNext = canonical ? next.replace(/\/mailfolders\/inbox/i, "/mailFolders('opaque-folder-id')") : next;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads.push(target);
      if (target.includes('/me/messages/target')) return json({ ...mail('target'), body: { content: 'Your verification code: 654321', contentType: 'text' } });
      expect(opts.redirect).toBe('error');
      if (target === next) return json({ value: [mail('target')] });
      if (/\/inbox\/messages/i.test(target)) return json({ value: Array.from({ length: 20 }, (_, n) => mail(`other-${n}`, 'someone@outlook.com')), '@odata.nextLink': upstreamNext });
      return json({ value: [] });
    }));
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messageId: 'target', scan: { checked: 1, pages: 3, metadata: 21, complete: true, truncated: false, scope: 'inbox_and_junk' } });
    expect(reads.filter(url => url.includes('/me/messages/'))).toHaveLength(1);
    expect(rateLimiter.getPollStatus('outlook').currentCount).toBe(4);
  });

  it('counts 100 metadata before recipient filtering and stops after five actual list pages', async () => {
    seed();
    const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads.push(target);
      const base = target.includes('junkemail') ? graphJunk : graphInbox;
      return json({ value: Array.from({ length: 20 }, (_, n) => mail(`${reads.length}-${n}`, 'other@outlook.com')), '@odata.nextLink': `${base.replace(/\/mailfolders\/[^/]+/i, "/mailFolders('opaque-folder-id')")}?$skip=${reads.length * 20}` });
    }));
    const response = await request();
    expect(await response.json()).toMatchObject({ codes: [], scan: { checked: 0, pages: 5, metadata: 100, complete: false, truncated: true, reason: 'scan_limit' } });
    expect(reads).toHaveLength(5);
    expect(rateLimiter.getPollStatus('outlook').currentCount).toBe(5);
  });

  it('enforces the shared metadata cap independently when upstream pages exceed the requested size', async () => {
    seed(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++;
      return json({ value: Array.from({ length: 60 }, (_, n) => mail(`${reads}-${n}`, reads === 2 && n === 50 ? recipient : 'other@outlook.com')) });
    }));
    const response = await request();
    expect(await response.json()).toMatchObject({ codes: [], scan: { pages: 2, metadata: 100, truncated: true, complete: false, reason: 'scan_limit' } });
    expect(reads).toBe(2);
  });

  it.each([
    'https://evil.test/v1.0/me/mailFolders/Inbox/messages',
    'https://graph.microsoft.com.evil.test/v1.0/me/mailFolders/Inbox/messages',
    'https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages',
    'http://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages',
    'https://graph.microsoft.com:444/v1.0/me/mailFolders/Inbox/messages',
    'https://graph.microsoft.com/v1.0/users/other/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/other',
  ])('rejects an untrusted continuation before any bearer fetch: %s', async next => {
    seed();
    const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads.push(target);
      return json({ value: [mail('target')], '@odata.nextLink': next });
    }));
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/continuation/i) });
    expect(reads).toHaveLength(1);
  });

  it('rejects malicious continuation even on the final budget page', async () => {
    seed(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++;
      const base = String(url).includes('junkemail') ? graphJunk : graphInbox;
      return json({ value: [], '@odata.nextLink': reads === 5 ? 'https://evil.test/' : `${base}?$skiptoken=${reads}` });
    }));
    expect((await request()).status).toBe(502); expect(reads).toBe(5);
  });

  it('merges both folders with duplicate IDs and stable equal-time selection', async () => {
    seed(); const detailIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      if (target.includes('/me/messages/')) {
        const id = /\/me\/messages\/([^?]+)/.exec(target)![1]; detailIds.push(id);
        return json({ ...mail(id), body: { content: id === 'C' ? 'Code 654321' : 'notification', contentType: 'text' } });
      }
      return json({ value: target.includes('junkemail') ? [mail('B'), mail('C')] : [mail('A'), mail('B')] });
    }));
    const response = await request();
    expect(await response.json()).toMatchObject({ messageId: 'C', scan: { checked: 3, pages: 2, metadata: 4, complete: true } });
    expect(detailIds).toEqual(['A', 'B', 'C']);
  });

  it('does not equate Inbox exhaustion with Junk completion', async () => {
    seed(); let junkPages = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      if (!target.includes('junkemail')) return json({ value: [] });
      return json({ value: [], '@odata.nextLink': `${graphJunk}?$skiptoken=${++junkPages}` });
    }));
    expect(await (await request()).json()).toMatchObject({ scan: { complete: false, truncated: true, pages: 5, folders: [{ folder: 'Inbox', complete: true }, { folder: 'Junk', complete: false }] } });
  });

  it.each([429, 503])('reports a partial-folder %s as an error and reads no details', async status => {
    seed(); const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads.push(target);
      return target.includes('junkemail') ? new Response('{}', { status, headers: { 'Retry-After': '11' } }) : json({ value: [mail('A')] });
    }));
    const response = await request();
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(reads).toHaveLength(2);
    expect(await response.json()).toMatchObject({ scan: { partial: true, complete: false, pages: 2 } });
  });

  it('stops on a mid-page lease close before JSON consumption causes further reads', async () => {
    seed(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++;
      const response = json({ value: [mail('A')], '@odata.nextLink': `${graphInbox}?$skiptoken=2` });
      response.json = async () => {
        getDb().prepare(`UPDATE inboxes SET status='closed' WHERE id='scan'`).run();
        return { value: [mail('A')], '@odata.nextLink': `${graphInbox}?$skiptoken=2` };
      };
      return response;
    }));
    expect(await (await request()).json()).toMatchObject({ codes: [], scan: { complete: false, scope: 'inbox_and_junk', pages: 1, metadata: 0, partial: true, folders: [{ folder: 'Inbox', complete: false }, { folder: 'Junk', complete: false }] } });
    expect(reads).toBe(1);
  });

  it('preserves the total list budget across waiting rounds', async () => {
    seed(); vi.useFakeTimers(); let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/')) return json({ access_token: 'scan-token' });
      reads++; return json({ value: [] });
    }));
    const pending = request('&wait=true&timeout=30');
    await vi.advanceTimersByTimeAsync(10000);
    const response = await pending;
    expect(await response.json()).toMatchObject({ scan: { pages: 5, complete: false, truncated: true, reason: 'scan_limit' } });
    expect(reads).toBe(5);
  });
});
