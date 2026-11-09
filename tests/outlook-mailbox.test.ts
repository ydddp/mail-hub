import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { hashApiKey } from '../src/crypto.js';
import { app, authHeaders } from './helpers/http.js';

/**
 * An inbox is a LEASE over a pooled Outlook mailbox, and its message list is
 * clipped to that lease (inbox-history-isolation.test.ts locks that down — the
 * previous tenant's verification codes must never surface there).
 *
 * The clip left no way to see the rest of the mailbox at all: the account page
 * linked to the newest lease, so mail from an earlier lease, or arriving while
 * the account sat idle between leases, was unreachable from anywhere in the UI.
 * The mailbox route answers that other question — asked of the ACCOUNT, not of a
 * lease, and only for an admin — and files every message under the lease that
 * held the mailbox when it arrived.
 */

interface StubMessage {
  id: string;
  subject: string;
  receivedAt: string;
  folder?: 'inbox' | 'junk';
  to?: string[];
  cc?: string[];
}

const seenUrls: string[] = [];

function stubMailbox(messages: StubMessage[], transport: 'graph' | 'outlook' = 'graph'): void {
  seenUrls.length = 0;
  const toGraph = (m: StubMessage) => ({
    id: m.id,
    subject: m.subject,
    receivedDateTime: m.receivedAt,
    from: { emailAddress: { name: 'Sender', address: 'sender@x.test' } },
    bodyPreview: '',
    body: { content: `<p>${m.subject}</p>`, contentType: 'html' },
    toRecipients: m.to?.map(address => ({ emailAddress: { address } })),
    ccRecipients: m.cc?.map(address => ({ emailAddress: { address } })),
  });
  const encode = (m: StubMessage) => transport === 'graph' ? toGraph(m) : {
    Id: m.id, Subject: m.subject, ReceivedDateTime: m.receivedAt,
    ToRecipients: m.to?.map(Address => ({ EmailAddress: { Address } })),
    CcRecipients: m.cc?.map(Address => ({ EmailAddress: { Address } })),
  };

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    seenUrls.push(u);
    const json = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    if (u.includes('/oauth2/v2.0/token')) return json({ access_token: 'at-mailbox' });
    if ((u.includes('graph.microsoft.com') || u.includes('outlook.office.com/api/')) && /\/mailfolders\/inbox\//i.test(u)) {
      return json({ value: messages.filter((m) => m.folder !== 'junk').map(encode) });
    }
    if ((u.includes('graph.microsoft.com') || u.includes('outlook.office.com/api/')) && /\/mailfolders\/junkemail\//i.test(u)) {
      return json({ value: messages.filter((m) => m.folder === 'junk').map(encode) });
    }
    if (u.includes('/me/messages/')) {
      const id = u.split('/me/messages/')[1].split('?')[0];
      const found = messages.find((m) => m.id === id);
      if (!found) return new Response('{}', { status: 404 });
      return json(encode(found));
    }
    return new Response('{}', { status: 404 });
  }));
}

let accountSeq = 0;

function insertAccount(email: string): void {
  accountSeq += 1;
  getDb().prepare(
    `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status, api_type)
     VALUES (?, 'pw', ?, ?, 'valid', '')`,
  ).run(email, `cid-${accountSeq}`, `rt-mailbox-${accountSeq}`);
}

function insertLease(id: string, accountEmail: string, opts: {
  createdAt: string;
  status?: string;
  closedAt?: string | null;
  expiresAt?: string | null;
  address?: string;
  service?: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, target_service, created_at, expires_at, closed_at, status)
     VALUES (?, 'outlook', ?, ?, '', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.address ?? accountEmail,
    JSON.stringify({ email: accountEmail, password: 'pw', clientId: 'cid', refreshToken: 'rt' }),
    opts.service ?? null,
    opts.createdAt,
    opts.expiresAt ?? null,
    opts.closedAt ?? null,
    opts.status ?? 'closed',
  );
}

interface MailboxBody {
  email: string;
  limit: number;
  truncated: boolean;
  messages: { id: string; leaseId: string | null; leaseState: string; recipientAddress?: string; recipientMatch: string }[];
  leases: { id: string; address: string; createdAt: string; endedAt: string | null; status: string; targetService: string | null }[];
}

async function getMailbox(email: string, query = ''): Promise<MailboxBody> {
  const res = await app.request(`/api/outlook/accounts/${encodeURIComponent(email)}/mailbox${query}`, { headers: authHeaders() });
  expect(res.status).toBe(200);
  return await res.json() as MailboxBody;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Outlook account mailbox view', () => {
  // Admins must see recipient evidence independently of the arrival window,
  // including delayed old-tag mail and addresses whose lease was cleaned up.
  it.each((['graph', 'outlook'] as const).flatMap(transport => [
    { name: 'delayed old alias', to: ['pool+old@outlook.com'], cc: [], match: 'exact', address: 'pool+old@outlook.com', retained: true },
    { name: 'cleaned lease', to: ['pool+old@outlook.com'], cc: [], match: 'exact', address: 'pool+old@outlook.com', retained: false },
    { name: 'main address evidence', to: ['pool@outlook.com'], cc: [], match: 'exact', address: 'pool@outlook.com', retained: true },
    { name: 'duplicate To/Cc', to: ['pool+old@outlook.com'], cc: ['POOL+OLD@OUTLOOK.COM'], match: 'exact', address: 'pool+old@outlook.com', retained: true },
    { name: 'multiple aliases', to: ['pool+old@outlook.com'], cc: ['pool+new@outlook.com'], match: 'multiple', address: undefined, retained: true },
    { name: 'Unicode distinct recipients', to: ['pool+k@outlook.com'], cc: ['pool+K@outlook.com'], match: 'multiple', address: undefined, retained: true },
    { name: 'no recipient evidence', to: [], cc: [], match: 'unknown', address: undefined, retained: true },
  ].map(row => ({ transport, ...row }))))('keeps $transport $name separate from the arrival lease in list and detail', async ({ transport, to, cc, match, address, retained }) => {
    const email = 'pool@outlook.com';
    insertAccount(email);
    getDb().prepare('UPDATE outlook_accounts SET api_type = ? WHERE email = ?').run(transport, email);
    if (retained) insertLease('old-lease', email, { address: 'pool+old@outlook.com', createdAt: '2026-07-24 09:00:00', closedAt: '2026-07-24 10:00:00' });
    insertLease('current-lease', email, { address: 'pool+new@outlook.com', createdAt: '2026-07-27 14:02:00', status: 'active' });
    stubMailbox([{ id: 'delayed', subject: 'Delayed mail', receivedAt: '2026-07-27T14:03:05.123Z', to, cc }], transport);
    const list = await getMailbox(email);
    const detail = await app.request(`/api/outlook/accounts/${email}/mailbox/delayed`, { headers: authHeaders() });
    expect(detail.status).toBe(200);
    for (const mail of [list.messages[0], await detail.json()]) {
      expect(mail).toMatchObject({ leaseId: 'current-lease', leaseState: 'lease', recipientMatch: match });
      expect(mail.recipientAddress).toBe(address);
      expect(mail).not.toHaveProperty('recipients');
    }
  });

  it('returns mail the newest lease clips away, and files each message under its lease', async () => {
    const email = 'pool1@outlook.com';
    insertAccount(email);
    // Two leases with an idle stretch between them.
    insertLease('i-old', email, {
      createdAt: '2026-07-24 09:11:00',
      closedAt: '2026-07-24 10:00:00',
      service: 'github',
    });
    insertLease('i-new', email, { createdAt: '2026-07-27 14:02:00', status: 'active' });

    stubMailbox([
      { id: 'm-ancient', subject: 'before the pool', receivedAt: '2026-07-20T00:00:00Z' },
      { id: 'm-old', subject: 'GitHub code', receivedAt: '2026-07-24T09:12:00Z' },
      { id: 'm-idle', subject: 'newsletter while idle', receivedAt: '2026-07-26T13:10:00Z' },
      { id: 'm-new-ambiguous', subject: 'same-second mail', receivedAt: '2026-07-27T14:02:00.100Z' },
      { id: 'm-new', subject: 'Steam code', receivedAt: '2026-07-27T14:02:01Z' },
    ]);

    // What the lease view shows: only its own message.
    const leaseRes = await app.request('/api/inbox/i-new/messages', { headers: authHeaders() });
    const leaseBody = await leaseRes.json() as { messages: { id: string }[]; accountEmail: string };
    expect(leaseBody.messages.map((m) => m.id)).toEqual(['m-new']);
    // ...and the account it is a lease on, so a client can offer the way out.
    expect(leaseBody.accountEmail).toBe(email);

    // What the mailbox view shows: everything, newest first, each attributed.
    const body = await getMailbox(email);
    expect(body.messages.map((m) => [m.id, m.leaseState, m.leaseId])).toEqual([
      ['m-new', 'lease', 'i-new'],
      ['m-new-ambiguous', 'gap', null],
      ['m-idle', 'gap', null],
      ['m-old', 'lease', 'i-old'],
      ['m-ancient', 'before', null],
    ]);
    expect(body.leases.map((l) => l.id)).toEqual(['i-new', 'i-old']);
    expect(body.leases[0].endedAt).toBeNull();
    expect(body.leases[1].targetService).toBe('github');
  });

  it('ends a lease at closed_at, not at the expiry it never reached', async () => {
    const email = 'pool2@outlook.com';
    insertAccount(email);
    // Closed by hand at 10:00; expires_at still says 24h out. Reading expires_at
    // as the end would file the 12:00 message inside a lease that was already
    // over and the account already back in the pool.
    insertLease('i-early', email, {
      createdAt: '2026-07-24 09:11:00',
      closedAt: '2026-07-24 10:00:00',
      expiresAt: '2026-07-25 09:11:00',
    });

    stubMailbox([
      { id: 'm-during', subject: 'in lease', receivedAt: '2026-07-24T09:30:00Z' },
      { id: 'm-after', subject: 'after close', receivedAt: '2026-07-24T12:00:00Z' },
    ]);

    const body = await getMailbox(email);
    expect(body.messages.map((m) => [m.id, m.leaseState])).toEqual([
      ['m-after', 'gap'],
      ['m-during', 'lease'],
    ]);
  });

  it('falls back to expires_at for rows closed before closed_at was recorded', async () => {
    const email = 'pool3@outlook.com';
    insertAccount(email);
    insertLease('i-legacy', email, {
      createdAt: '2026-07-24 09:11:00',
      closedAt: null,
      expiresAt: '2026-07-24 10:11:00',
    });

    stubMailbox([
      { id: 'm-in', subject: 'in lease', receivedAt: '2026-07-24T09:30:00Z' },
      { id: 'm-out', subject: 'past expiry', receivedAt: '2026-07-24T11:00:00Z' },
    ]);

    const body = await getMailbox(email);
    expect(body.messages.map((m) => [m.id, m.leaseState])).toEqual([
      ['m-out', 'gap'],
      ['m-in', 'lease'],
    ]);
  });

  it('applies active expires_at as a strict half-open mailbox classification boundary', async () => {
    const email = 'pool-active-expiry@outlook.com';
    insertAccount(email);
    insertLease('i-active-expiry', email, {
      createdAt: '2026-07-24 09:00:00',
      expiresAt: '2026-07-24 10:00:00',
      status: 'active',
    });
    stubMailbox([
      { id: 'm-before-expiry', subject: 'before expiry', receivedAt: '2026-07-24T09:59:59Z' },
      { id: 'm-at-expiry', subject: 'at expiry', receivedAt: '2026-07-24T10:00:00Z' },
      { id: 'm-after-expiry', subject: 'after expiry', receivedAt: '2026-07-24T10:00:01Z' },
    ]);

    const body = await getMailbox(email);
    expect(body.messages.map((message) => [message.id, message.leaseState])).toEqual([
      ['m-after-expiry', 'gap'],
      ['m-at-expiry', 'gap'],
      ['m-before-expiry', 'lease'],
    ]);
    expect(body.leases[0].endedAt).toBe('2026-07-24T10:00:00.000Z');
  });

  it('caps a lease with no recorded end at the moment the next one took the account', async () => {
    const email = 'pool4@outlook.com';
    insertAccount(email);
    // Neither closed_at nor expires_at — a row closed before closed_at existed,
    // with no expiry recorded either. The only knowable end is the handover.
    insertLease('i-a', email, { createdAt: '2026-07-24 09:00:00', closedAt: null, expiresAt: null });
    insertLease('i-b', email, { createdAt: '2026-07-25 09:00:00', status: 'active' });

    stubMailbox([
      { id: 'm-a', subject: 'first tenant', receivedAt: '2026-07-24T20:00:00Z' },
      { id: 'm-handoff', subject: 'ambiguous handoff', receivedAt: '2026-07-25T09:00:00.100Z' },
      { id: 'm-b', subject: 'second tenant', receivedAt: '2026-07-25T10:00:00Z' },
    ]);

    const body = await getMailbox(email);
    expect(body.messages.map((m) => [m.id, m.leaseId])).toEqual([
      ['m-b', 'i-b'],
      ['m-handoff', null],
      ['m-a', 'i-a'],
    ]);
    // Attribution alone cannot show the cap — newest-first matching already
    // keeps an open-ended old lease from stealing newer mail. What the cap fixes
    // is the window the UI prints: without it this lease reads "still running"
    // forever, on an account that was handed on a day later. The handoff itself
    // is strict: the older lease ends exactly when the next lease starts.
    const older = body.leases.find((l) => l.id === 'i-a')!;
    expect(older.endedAt).not.toBeNull();
    expect(Date.parse(older.endedAt!)).toBe(Date.UTC(2026, 6, 25, 9, 0, 0));
    expect(body.leases.find((l) => l.id === 'i-b')!.endedAt).toBeNull();
  });

  it('resolves an alias lease by account email, so its window still owns its mail', async () => {
    const email = 'pool5@outlook.com';
    insertAccount(email);
    // The lease address carries a +tag; only auth_data.email names the account.
    insertLease('i-alias', email, {
      createdAt: '2026-07-27 14:02:00',
      status: 'active',
      address: 'pool5+ab12cd34@outlook.com',
    });

    stubMailbox([{ id: 'm-alias', subject: 'to the alias', receivedAt: '2026-07-27T14:03:00Z' }]);

    const body = await getMailbox(email);
    expect(body.leases.map((l) => l.address)).toEqual(['pool5+ab12cd34@outlook.com']);
    expect(body.messages[0].leaseId).toBe('i-alias');
  });

  it('keeps an undated message rather than dropping it, filed under no lease', async () => {
    const email = 'pool6@outlook.com';
    insertAccount(email);
    insertLease('i-undated', email, { createdAt: '2026-07-27 14:02:00', status: 'active' });

    stubMailbox([{ id: 'm-undated', subject: 'no date', receivedAt: '' }]);

    const body = await getMailbox(email);
    expect(body.messages.map((m) => [m.id, m.leaseState, m.leaseId])).toEqual([['m-undated', 'undated', null]]);
  });

  it('opens a message the lease view would refuse, and reports it as HTML', async () => {
    const email = 'pool7@outlook.com';
    insertAccount(email);
    insertLease('i-recent', email, { createdAt: '2026-07-27 14:02:00', status: 'active' });

    stubMailbox([{ id: 'm-history', subject: 'previous tenant', receivedAt: '2026-07-01T00:00:00Z' }]);

    // The lease path refuses by id — ids stay valid across reuse, so that 404 is
    // the tenant boundary and must stay.
    const denied = await app.request('/api/inbox/i-recent/messages/m-history', { headers: authHeaders() });
    expect(denied.status).toBe(404);

    const res = await app.request(`/api/outlook/accounts/${email}/mailbox/m-history`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const detail = await res.json() as { id: string; html: string };
    expect(detail.id).toBe('m-history');
    expect(detail.html).toContain('previous tenant');
  });

  it('is admin-only: an API key cannot reach the mailbox behind its own inbox', async () => {
    const email = 'pool8@outlook.com';
    insertAccount(email);
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, 'tenant')`).run(hashApiKey('tenant-key'));
    stubMailbox([{ id: 'm-any', subject: 'anything', receivedAt: '2026-07-27T14:03:00Z' }]);

    const list = await app.request(`/api/outlook/accounts/${email}/mailbox`, { headers: authHeaders('tenant-key') });
    const detail = await app.request(`/api/outlook/accounts/${email}/mailbox/m-any`, { headers: authHeaders('tenant-key') });

    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
  });

  it('404s for an account that is not in the pool, before spending a token', async () => {
    stubMailbox([]);
    const res = await app.request('/api/outlook/accounts/ghost@outlook.com/mailbox', { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(seenUrls).toHaveLength(0);
  });

  it('threads limit through to the upstream $top and clamps it', async () => {
    const email = 'pool9@outlook.com';
    insertAccount(email);
    insertLease('i-lim', email, { createdAt: '2026-07-27 14:02:00', status: 'active' });

    stubMailbox([
      { id: 'm-1', subject: 'one', receivedAt: '2026-07-27T14:03:00Z' },
      { id: 'm-2', subject: 'two', receivedAt: '2026-07-27T14:04:00Z' },
    ]);

    const capped = await getMailbox(email, '?limit=999');
    expect(capped.limit).toBe(100);
    expect(seenUrls.some((u) => u.includes('%24top=100') || u.includes('$top=100'))).toBe(true);

    // A limit the mailbox fills exactly is a ceiling the caller has hit, and the
    // UI has to say so — there is no paging past it.
    const trimmed = await getMailbox(email, '?limit=1');
    expect(trimmed.messages.map((m) => m.id)).toEqual(['m-2']);
    expect(trimmed.truncated).toBe(true);

    const roomy = await getMailbox(email, '?limit=50');
    expect(roomy.truncated).toBe(false);
  });
});

/**
 * closed_at is what makes the lease windows above truthful, so it has to be
 * written on both paths that end a lease — the manual close and the hourly
 * expiry sweep. Only the manual path is exercised here; cleanup.test.ts owns
 * the sweep.
 */
describe('closed_at', () => {
  it('is stamped when an inbox is closed by hand', async () => {
    const email = 'pool10@outlook.com';
    insertAccount(email);
    insertLease('i-close', email, { createdAt: '2026-07-27 14:02:00', status: 'active' });

    const res = await app.request('/api/inbox/i-close', { method: 'DELETE', headers: authHeaders() });
    expect(res.status).toBe(200);

    const row = getDb().prepare(`SELECT status, closed_at FROM inboxes WHERE id = 'i-close'`).get() as { status: string; closed_at: string | null };
    expect(row.status).toBe('closed');
    expect(row.closed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
