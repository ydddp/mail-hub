import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { OutlookProvider, buildAliasAddress, fetchAccountMailbox, fetchAccountMessage, stripPlusTag } from '../src/providers/outlook.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * Plus addressing is an opt-in per request: the account still serves exactly one
 * inbox, so the tag only buys a distinct address at the target service. The
 * account row stays keyed on the bare email, which is what every lookup
 * (refresh token, api_type, used_services, admin list) must resolve to.
 *
 * Delivery was verified live against the production pool on 2026-07-26: a
 * message sent to `<account>+probe@outlook.com` reached the base mailbox in ~6s
 * with the tag preserved in toRecipients.
 */

function insertAccount(email: string): void {
  getDb().prepare(
    `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
     VALUES (?, 'pw', 'cid', 'rt-' || ?, 'valid')`,
  ).run(email, email);
}

describe('stripPlusTag', () => {
  it('removes the tag and keeps the domain', () => {
    expect(stripPlusTag('user+github@outlook.com')).toBe('user@outlook.com');
  });

  it('leaves an untagged address untouched', () => {
    expect(stripPlusTag('user@outlook.com')).toBe('user@outlook.com');
  });

  it('strips only the first plus and ignores one in the domain part', () => {
    expect(stripPlusTag('user+a+b@outlook.com')).toBe('user@outlook.com');
    expect(stripPlusTag('nope')).toBe('nope');
    expect(stripPlusTag('@outlook.com')).toBe('@outlook.com');
  });
});

describe('buildAliasAddress', () => {
  it('appends a sanitized tag', () => {
    expect(buildAliasAddress('user@outlook.com', 'GitHub')).toBe('user+github@outlook.com');
    expect(buildAliasAddress('user@outlook.com', 'a b/c')).toBe('user+abc@outlook.com');
  });

  it('keeps the local part within the RFC 5321 64-octet limit', () => {
    const base = 'a'.repeat(60);
    const addr = buildAliasAddress(`${base}@outlook.com`, 'toolongtag')!;
    expect(addr.split('@')[0].length).toBeLessThanOrEqual(64);
    expect(addr.startsWith(`${base}+`)).toBe(true);
  });

  it('returns null when no usable tag survives, so the caller falls back', () => {
    expect(buildAliasAddress('user@outlook.com', '///')).toBeNull();
    expect(buildAliasAddress('user@outlook.com', '')).toBeNull();
    expect(buildAliasAddress('a'.repeat(64) + '@outlook.com', 'tag')).toBeNull();
    expect(buildAliasAddress('notanemail', 'tag')).toBeNull();
  });
});

describe('Outlook alias allocation', () => {
  it('uses the plain account address unless an alias is requested', async () => {
    insertAccount('plain@outlook.com');
    const inbox = await new OutlookProvider().createInbox({ inboxId: 'i-plain' });

    expect(inbox.address).toBe('plain@outlook.com');
    expect(inbox.authData.email).toBe('plain@outlook.com');
  });

  it('generates the tag server-side when alias is requested', async () => {
    insertAccount('aliased@outlook.com');
    const inbox = await new OutlookProvider().createInbox({ inboxId: 'i-alias', alias: true });

    // The caller never supplies a tag, so assert the shape, not a literal.
    expect(inbox.address).toMatch(/^aliased\+[a-z0-9]{8}@outlook\.com$/);
    // The credential path (refresh token, api_type, release) resolves via this.
    expect(inbox.authData.email).toBe('aliased@outlook.com');
  });

  it('gives two inboxes on the same account distinct tags', async () => {
    insertAccount('reuse@outlook.com');
    const provider = new OutlookProvider();
    const first = await provider.createInbox({ inboxId: 'i-r1', alias: true });
    await provider.releaseInbox(first, 'i-r1');
    const second = await provider.createInbox({ inboxId: 'i-r2', alias: true });

    expect(first.address).not.toBe(second.address);
    expect(stripPlusTag(first.address)).toBe('reuse@outlook.com');
    expect(stripPlusTag(second.address)).toBe('reuse@outlook.com');
  });

  it('still consumes exactly one account — aliasing is not extra capacity', async () => {
    insertAccount('solo@outlook.com');
    const provider = new OutlookProvider();
    await provider.createInbox({ inboxId: 'i-first', alias: true });

    await expect(provider.createInbox({ inboxId: 'i-second', alias: true }))
      .rejects.toThrow(/无可用账号/);
  });

  it('releases the account when an alias inbox is released', async () => {
    insertAccount('rel@outlook.com');
    const provider = new OutlookProvider();
    const inbox = await provider.createInbox({ inboxId: 'i-rel', alias: true });

    await provider.releaseInbox(inbox, 'i-rel');

    const row = getDb().prepare(`SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'rel@outlook.com'`).get() as { assigned_inbox_id: string | null };
    expect(row.assigned_inbox_id).toBeNull();
  });

  it('falls back to the plain address when no tag can fit the local part', async () => {
    // 60-char base leaves room for '+' plus 3 chars, so an 8-char tag is cut
    // down rather than overflowing; a 64-char base leaves no room at all.
    const full = 'a'.repeat(64);
    insertAccount(`${full}@outlook.com`);
    const inbox = await new OutlookProvider().createInbox({ inboxId: 'i-fb', alias: true });

    expect(inbox.address).toBe(`${full}@outlook.com`);
  });
});

/**
 * used_services is a permanent anti-reuse blacklist keyed on the ACCOUNT email.
 * Looking it up by the inbox address would silently match no row for an alias
 * inbox, leaving the blacklist unwritten — the account would be handed to the
 * same service again.
 */
describe('report route resolves the account behind an alias inbox', () => {
  async function createInboxFor(email: string, tag: string | undefined, id: string): Promise<void> {
    insertAccount(email);
    const inbox = await new OutlookProvider().createInbox({ inboxId: id, ...(tag ? { alias: true } : {}) });
    getDb().prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, target_service, status)
       VALUES (?, 'outlook', ?, ?, '', 'netlify.com', 'active')`,
    ).run(id, inbox.address, JSON.stringify(inbox.authData));
  }

  it('records used_services against the base account for an alias inbox', async () => {
    await createInboxFor('report-alias@outlook.com', 'netlify', 'r-alias');

    const res = await app.request('/api/inbox/r-alias/report', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ success: true, service: 'netlify.com' }),
    });
    expect(res.status).toBe(200);

    const row = getDb().prepare(`SELECT used_services FROM outlook_accounts WHERE email = 'report-alias@outlook.com'`).get() as { used_services: string };
    expect(JSON.parse(row.used_services)).toEqual(['netlify.com']);
  });

  it('still records for a plain (non-alias) inbox', async () => {
    await createInboxFor('report-plain@outlook.com', undefined, 'r-plain');

    await app.request('/api/inbox/r-plain/report', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ success: true, service: 'netlify.com' }),
    });

    const row = getDb().prepare(`SELECT used_services FROM outlook_accounts WHERE email = 'report-plain@outlook.com'`).get() as { used_services: string };
    expect(JSON.parse(row.used_services)).toEqual(['netlify.com']);
  });

  /**
   * The point of the alias: one account may register at the SAME service more
   * than once, because each registration gets a fresh address. A plain request
   * for that service still finds the account excluded, so turning the flag off
   * restores the original guarantee. Exercised through the real API, since the
   * used_services filter sits in the account-selection SQL and is also applied
   * by getDomains — miss either and dispatch fails before createInbox runs.
   */
  it('lets an aliased request reuse an account already used for that service', async () => {
    insertAccount('reuse-ok@outlook.com');

    async function createAndBurn(alias: boolean): Promise<{ status: number; address?: string }> {
      const res = await app.request('/api/inbox', {
        method: 'POST', headers: jsonHeaders(),
        body: JSON.stringify({ for: 'guarded.com', provider: 'outlook', alias }),
      });
      const body = await res.json() as { id?: string; address?: string };
      if (res.status === 201 && body.id) {
        await app.request(`/api/inbox/${body.id}/report`, {
          method: 'POST', headers: jsonHeaders(),
          body: JSON.stringify({ success: true, service: 'guarded.com' }),
        });
        // Close so only used_services — not the 1:1 assignment — can exclude it.
        await app.request(`/api/inbox/${body.id}`, { method: 'DELETE', headers: authHeaders() });
      }
      return { status: res.status, address: body.address };
    }

    const first = await createAndBurn(true);
    expect(first.status).toBe(201);

    const used = getDb().prepare(`SELECT used_services FROM outlook_accounts WHERE email = 'reuse-ok@outlook.com'`).get() as { used_services: string };
    expect(JSON.parse(used.used_services)).toEqual(['guarded.com']);

    // Same account, same service, second registration — allowed, new address.
    const second = await createAndBurn(true);
    expect(second.status).toBe(201);
    expect(second.address).toMatch(/^reuse-ok\+[a-z0-9]{8}@outlook\.com$/);
    expect(second.address).not.toBe(first.address);

    // …and a third, to show it is not a one-off exemption.
    const third = await createAndBurn(true);
    expect(third.status).toBe(201);
    expect(new Set([first.address, second.address, third.address]).size).toBe(3);

    // Without the flag the original protection still holds.
    const plain = await app.request('/api/inbox', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ for: 'guarded.com', provider: 'outlook' }),
    });
    expect(plain.status).not.toBe(201);
  });

  it('excludes the account from later dispatch for that service', async () => {
    await createInboxFor('report-burn@outlook.com', 'svc', 'r-burn');
    await app.request('/api/inbox/r-burn/report', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ success: true, service: 'burned.com' }),
    });
    // Free the account so only the used_services filter can exclude it.
    getDb().prepare(`UPDATE outlook_accounts SET assigned_inbox_id = NULL WHERE email = 'report-burn@outlook.com'`).run();

    await expect(new OutlookProvider().createInbox({ inboxId: 'i-again', for: 'burned.com' }))
      .rejects.toThrow(/无可用账号/);
  });
});

/**
 * The feature exists so an API caller can turn it on per request — the caller
 * never invents a tag. These lock the wire contract of POST /api/inbox.
 */
describe('POST /api/inbox honours the alias flag', () => {
  async function create(body: Record<string, unknown>): Promise<{ status: number; address?: string }> {
    const res = await app.request('/api/inbox', {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body),
    });
    const json = await res.json() as { address?: string };
    return { status: res.status, address: json.address };
  }

  it('returns a tagged address when alias is true', async () => {
    insertAccount('apion@outlook.com');
    const r = await create({ for: 'alias-on.test', provider: 'outlook', alias: true });

    expect(r.status).toBe(201);
    expect(r.address).toMatch(/^apion\+[a-z0-9]{8}@outlook\.com$/);
  });

  it('returns the plain address when alias is absent or false', async () => {
    insertAccount('apioff@outlook.com');
    const r = await create({ for: 'alias-off.test', provider: 'outlook' });
    expect(r.address).toBe('apioff@outlook.com');

    insertAccount('apifalse@outlook.com');
    const r2 = await create({ for: 'alias-false.test', provider: 'outlook', alias: false });
    expect(r2.address).toBe('apifalse@outlook.com');
  });

  it('ignores a non-boolean alias rather than treating it as opt-in', async () => {
    insertAccount('apistr@outlook.com');
    const r = await create({ for: 'alias-str.test', provider: 'outlook', alias: 'yes' });

    expect(r.address).toBe('apistr@outlook.com');
  });
});

describe('admin account list links alias inboxes back to the account', () => {
  it('reports last_inbox_id for an alias inbox', async () => {
    insertAccount('lastinbox@outlook.com');
    const inbox = await new OutlookProvider().createInbox({ inboxId: 'i-last', alias: true });
    getDb().prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, status)
       VALUES ('i-last', 'outlook', ?, ?, '', 'active')`,
    ).run(inbox.address, JSON.stringify(inbox.authData));

    const res = await app.request('/api/outlook/accounts', { headers: authHeaders() });
    const body = await res.json() as { accounts: { email: string; last_inbox_id: string | null }[] };
    const account = body.accounts.find((a) => a.email === 'lastinbox@outlook.com');

    expect(account?.last_inbox_id).toBe('i-last');
  });
});

interface AliasMail {
  id: string;
  receivedAt: string;
  to?: string[];
  cc?: string[];
  originalTo?: string;
  detailTo?: string[];
  detailMissing?: boolean;
}

/** An upstream projection, not a recipient filter: Microsoft only returns selected fields. */
function stubAliasMailbox(apiType: 'graph' | 'outlook', messages: AliasMail[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = new URL(String(url));
    const json = (payload: unknown) => new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
    if (target.pathname.includes('/oauth2/v2.0/token')) return json({ access_token: 'alias-mail-token' });
    if (target.hostname !== (apiType === 'graph' ? 'graph.microsoft.com' : 'outlook.office.com')) {
      return new Response('{}', { status: 404 });
    }
    const selected = (target.searchParams.get('$select') || '').toLowerCase().split(',');
    const detailId = target.pathname.match(/\/me\/messages\/([^/]+)$/)?.[1];
    const encode = (mail: AliasMail) => {
      const to = detailId && mail.detailTo ? mail.detailTo : mail.to;
      const addresses = (values?: string[]) => values?.map((address) => apiType === 'outlook'
        ? { EmailAddress: { Address: address } }
        : { emailAddress: { address } });
      const recipients = {
        ...(selected.includes('torecipients') ? { [apiType === 'outlook' ? 'ToRecipients' : 'toRecipients']: addresses(to) } : {}),
        ...(selected.includes('ccrecipients') ? { [apiType === 'outlook' ? 'CcRecipients' : 'ccRecipients']: addresses(mail.cc) } : {}),
      };
      return apiType === 'outlook'
        ? { Id: mail.id, Subject: 'Verification code: 123456', ReceivedDateTime: mail.receivedAt, Body: { Content: 'Code: 654321', ContentType: 'Text' }, ...recipients,
            InternetMessageHeaders: [{ Name: 'X-Original-To', Value: mail.originalTo }] }
        : { id: mail.id, subject: 'Verification code: 123456', receivedDateTime: mail.receivedAt, body: { content: 'Code: 654321', contentType: 'text' }, ...recipients,
            internetMessageHeaders: [{ name: 'X-Original-To', value: mail.originalTo }] };
    };
    if (detailId) {
      const found = messages.find((mail) => mail.id === detailId);
      return found && !found.detailMissing ? json(encode(found)) : new Response('{}', { status: 404 });
    }
    return json({ value: target.pathname.toLowerCase().includes('/inbox/') ? messages.map(encode) : [] });
  }));
}

function aliasLease(apiType: 'graph' | 'outlook', messages: AliasMail[], email = 'recipient-scope@outlook.com', address = email.replace('@', '+new@')) {
  insertAccount(email);
  getDb().prepare('UPDATE outlook_accounts SET api_type = ? WHERE email = ?').run(apiType, email);
  const inbox = {
    address,
    authData: { email, clientId: 'cid', refreshToken: `rt-${email}` },
    provider: 'outlook', apiBase: '',
  };
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, created_at, status)
     VALUES ('recipient-lease', 'outlook', ?, ?, '', '2026-11-07 10:00:00', 'active')`,
  ).run(address, JSON.stringify(inbox.authData));
  stubAliasMailbox(apiType, messages);
  return { email, address, inbox };
}

// The two new contracts below protect tenant-visible lists/codes and independently
// guessed details. Admin account reads deliberately exercise the same transports.
describe.each(['graph', 'outlook'] as const)('Outlook %s alias recipient isolation', (apiType) => {
  const own = 'recipient-scope+new@outlook.com';
  const old = 'recipient-scope+old@outlook.com';
  const mail = (id: string, seconds: number, recipients: Partial<AliasMail> = {}): AliasMail => ({
    id, receivedAt: `2026-11-07T10:00:${String(seconds).padStart(2, '0')}Z`, ...recipients,
  });

  it('lists only exact To/Cc alias matches before applying the lease window, while admin sees the whole mailbox', async () => {
    const messages = [
      mail('old-delayed', 12, { to: [old] }),
      mail('own-to', 11, { to: [own] }),
      mail('own-case', 10, { to: [own.toUpperCase()] }),
      mail('own-cc', 9, { to: ['elsewhere@example.test'], cc: [own.toUpperCase()] }),
      mail('old-same-minute', 8, { to: [old] }),
      mail('base', 7, { to: ['recipient-scope@outlook.com'] }),
      mail('substring', 6, { to: ['recipient-scope+newer@outlook.com'] }),
      mail('missing', 5),
      mail('original-header-only', 4, { originalTo: own }),
      { id: 'own-before-lease', receivedAt: '2026-11-07T09:59:59Z', to: [own] },
    ];
    const { email, inbox } = aliasLease(apiType, messages);
    const provider = new OutlookProvider();

    expect((await provider.getMessages(inbox)).map((message) => message.id)).toEqual([
      'own-to', 'own-case', 'own-cc', 'own-before-lease',
    ]);
    const list = await app.request('/api/inbox/recipient-lease/messages', { headers: authHeaders() });
    expect(list.status).toBe(200);
    expect((await list.json() as { messages: { id: string }[] }).messages.map((message) => message.id))
      .toEqual(['own-to', 'own-case', 'own-cc']);
    const code = await app.request('/api/inbox/recipient-lease/code', { headers: authHeaders() });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject({
      messageId: 'own-to', codes: expect.arrayContaining([expect.objectContaining({ value: '654321' })]),
    });

    expect((await fetchAccountMailbox(email)).map((message) => message.id)).toEqual(messages.map((message) => message.id));
    expect((await provider.getMessages({ ...inbox, address: email })).map((message) => message.id))
      .toEqual(messages.map((message) => message.id));
    expect((await fetchAccountMessage(email, 'missing')).text).toBe('Code: 654321');
  });

  it.each([
    ['exact To', { to: [own] }, true],
    ['case-insensitive To', { to: [own.toUpperCase()] }, true],
    ['exact Cc', { to: [old], cc: [own.toUpperCase()] }, true],
    ['previous tag delivered in the new lease', { to: [old] }, false],
    ['untagged account', { to: ['recipient-scope@outlook.com'] }, false],
    ['substring', { to: ['recipient-scope+newer@outlook.com'] }, false],
    ['no recipients', {}, false],
    ['X-Original-To without To/Cc', { originalTo: own }, false],
    ['plus-containing account: own alias', { to: ['recipient-scope+existing+new@outlook.com'] }, true, 'recipient-scope+existing@outlook.com'],
    ['plus-containing account: previous alias', { to: ['recipient-scope+existing+old@outlook.com'] }, false, 'recipient-scope+existing@outlook.com'],
    ['Unicode local is distinct', { to: ['\u212A+new@outlook.com'] }, false, 'k@outlook.com'],
    ['Unicode Cc is distinct', { cc: ['\u212A+new@outlook.com'] }, false, 'k@outlook.com'],
    ['Unicode tag is distinct', { to: ['recipient-scope+\u212A@outlook.com'] }, false, undefined, 'recipient-scope+k@outlook.com'],
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
  ] as const)('independently checks guessed detail ids: %s', async (_name, recipients, allowed, accountEmail?, leaseAddress?) => {
    const { email, inbox } = aliasLease(apiType, [mail('guessed', 10, { ...recipients })], accountEmail, leaseAddress);
    expect((await new OutlookProvider().getMessages(inbox)).map((message) => message.id)).toEqual(allowed ? ['guessed'] : []);
    const result = new OutlookProvider().getMessage(inbox, 'guessed');
    if (allowed) await expect(result).resolves.toMatchObject({ id: 'guessed', text: 'Code: 654321' });
    else await expect(result).rejects.toThrow(/not found/i);
    const list = await app.request('/api/inbox/recipient-lease/messages', { headers: authHeaders() });
    expect(list.status).toBe(200);
    expect((await list.json() as { messages: unknown[] }).messages).toHaveLength(allowed ? 1 : 0);
    const detail = await app.request('/api/inbox/recipient-lease/messages/guessed', { headers: authHeaders() });
    expect(detail.status).toBe(allowed ? 200 : 404);
    const code = await app.request('/api/inbox/recipient-lease/code', { headers: authHeaders() });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject(allowed
      ? { messageId: 'guessed', codes: expect.arrayContaining([expect.objectContaining({ value: '654321' })]) }
      : { codes: [], email: null, messageId: null });
    expect((await fetchAccountMessage(email, 'guessed')).id).toBe('guessed');
  });

  it.each([
    ['mismatched recipients', { detailTo: [old] }],
    ['missing recipients', { detailTo: [] }],
    ['a missing message', { detailMissing: true }],
  ])('extracts no summary code and returns not-found after detail reports %s', async (_name, detail) => {
    aliasLease(apiType, [mail('recipient-changed', 10, { to: [own], ...detail })]);
    const code = await app.request('/api/inbox/recipient-lease/code', { headers: authHeaders() });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject({ codes: [], email: null, messageId: null });
    const response = await app.request('/api/inbox/recipient-lease/messages/recipient-changed', { headers: authHeaders() });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Message not found' });
  });

  // A corrupt tenant identity must never turn an optional recipient into an
  // unscoped transport call, even though the admin can still read the account.
  it.each(['', ' ', '\t'])('rejects an empty stored lease identity %j before reading mail', async (address) => {
    const { email, inbox } = aliasLease(apiType, [mail('private', 10, { to: [old] })], undefined, address);
    const provider = new OutlookProvider();
    await expect(provider.getMessages(inbox)).rejects.toThrow('Message not found');
    await expect(provider.getMessage(inbox, 'private')).rejects.toThrow('Message not found');
    for (const path of ['messages', 'messages/private', 'code']) {
      const response = await app.request(`/api/inbox/recipient-lease/${path}`, { headers: authHeaders() });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Message not found' });
    }
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect((await fetchAccountMessage(email, 'private')).id).toBe('private');
  });
});
