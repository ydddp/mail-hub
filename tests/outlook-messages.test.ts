import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { OutlookProvider } from '../src/providers/outlook.js';
import * as messageTypes from '../src/providers/base.js';
import { app, authHeaders } from './helpers/http.js';
import { hashApiKey } from '../src/crypto.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Contract: the Outlook REST API (api_type 'outlook') returns PascalCase
// fields; messages must be normalized BEFORE dedup/merge/sort, otherwise every
// message collapses onto an undefined id and only one survives.
describe('Outlook REST (PascalCase) message polling', () => {
  // Recipient evidence must survive both transports internally for admin
  // attribution without becoming part of tenant-visible message JSON.
  it.each(['graph', 'outlook'])('retains internal To/Cc evidence in %s list and detail without serializing it', async (transport) => {
    const email = `evidence-${transport}@outlook.com`;
    getDb().prepare(`INSERT INTO outlook_accounts (email, password, client_id, refresh_token, api_type) VALUES (?, 'pw', 'evidence-client', ?, ?)`).run(email, `evidence-${transport}`, transport);
    const mail = transport === 'graph'
      ? { id: 'evidence-mail', receivedDateTime: '2026-07-01T12:00:05.123Z', toRecipients: [{ emailAddress: { address: email } }], ccRecipients: [{ emailAddress: { address: 'other@x.test' } }] }
      : { Id: 'evidence-mail', ReceivedDateTime: '2026-07-01T12:00:05.123Z', ToRecipients: [{ EmailAddress: { Address: email } }], CcRecipients: [{ EmailAddress: { Address: 'other@x.test' } }] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      const result = target.includes('/oauth2/') ? { access_token: 'evidence-token' }
        : target.includes('/me/messages/') ? mail
        : { value: /\/inbox\//i.test(target) ? [mail] : [] };
      return new Response(JSON.stringify(result), { status: 200 });
    }));
    const box = { address: email, authData: { email }, provider: 'outlook', apiBase: '' };
    const provider = new OutlookProvider();
    const internalKey = (messageTypes as unknown as Record<string, symbol>).MESSAGE_RECIPIENTS;
    expect(typeof internalKey).toBe('symbol');
    for (const message of [(await provider.getMessages(box))[0], await provider.getMessage(box, 'evidence-mail')]) {
      expect((message as any)[internalKey]).toEqual([email, 'other@x.test']);
      expect(message.receivedAt).toBe('2026-07-01T12:00:05.123Z');
      expect(JSON.stringify(message)).not.toContain('other@x.test');
      expect(JSON.parse(JSON.stringify(message))).not.toHaveProperty('recipientAddress');
    }
    const ownerKey = hashApiKey('evidence-owner');
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, 'evidence owner')`).run(ownerKey);
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data, created_at, owner_key) VALUES ('evidence-lease', 'outlook', ?, ?, '2026-07-01 11:00:00', ?)`).run(email, JSON.stringify({ email }), ownerKey);
    for (const suffix of ['', '/evidence-mail']) {
      const response = await app.request(`/api/inbox/evidence-lease/messages${suffix}`, { headers: authHeaders('evidence-owner') });
      expect(response.status).toBe(200);
      const body = await response.json();
      const message = suffix ? body : body.messages[0];
      expect(message).not.toHaveProperty('recipientAddress');
      expect(message).not.toHaveProperty('recipientMatch');
      expect(JSON.stringify(message)).not.toContain('other@x.test');
    }
  });

  it('returns all inbox+junk messages, normalized and sorted newest first', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, api_type)
       VALUES ('rest@outlook.com', 'pw', 'cid-rest', 'rt-rest-unique', 'outlook')`,
    ).run();

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'at-rest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('outlook.office.com') && u.includes('/inbox/')) {
        return new Response(JSON.stringify({ value: [
          { Id: 'in-1', Subject: 'Inbox One', ReceivedDateTime: '2026-07-01T10:00:00Z', From: { EmailAddress: { Name: 'A', Address: 'a@x.com' } }, BodyPreview: 'p1' },
          { Id: 'in-2', Subject: 'Inbox Two', ReceivedDateTime: '2026-07-01T12:00:00Z', From: { EmailAddress: { Name: 'B', Address: 'b@x.com' } }, BodyPreview: 'p2' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('outlook.office.com') && u.includes('/junkemail/')) {
        return new Response(JSON.stringify({ value: [
          { Id: 'jk-1', Subject: 'Junk One', ReceivedDateTime: '2026-07-01T11:00:00Z', From: { EmailAddress: { Address: 'c@x.com' } }, BodyPreview: 'p3' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }));

    const provider = new OutlookProvider();
    const messages = await provider.getMessages({
      address: 'rest@outlook.com',
      authData: { email: 'rest@outlook.com', password: 'pw', clientId: 'cid-rest', refreshToken: 'rt-rest-unique' },
      provider: 'outlook',
      apiBase: '',
    });

    expect(messages.map((m) => m.id)).toEqual(['in-2', 'jk-1', 'in-1']);
    expect(messages[0].subject).toBe('Inbox Two');
    expect(messages[0].from).toBe('B <b@x.com>');
  });

  it.each([401, 503])('discovers REST for an unknown account after Graph returns %s', async (graphStatus) => {
    const email = `rest-fallback-${graphStatus}@outlook.com`;
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, api_type)
       VALUES (?, 'pw', 'cid-rest-fallback', ?, '')`,
    ).run(email, `rt-rest-fallback-${graphStatus}`);

    const mailUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: `at-rest-fallback-${graphStatus}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      mailUrls.push(target);
      if (target.includes('graph.microsoft.com')) return new Response('{}', { status: graphStatus });
      if (target.includes('outlook.office.com/api/')) {
        return new Response(JSON.stringify({ value: target.includes('/inbox/')
          ? [{ Id: `rest-${graphStatus}`, Subject: 'REST fallback', ReceivedDateTime: '2026-08-07T10:00:00Z' }]
          : [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }));

    const messages = await new OutlookProvider().getMessages({
      address: email,
      authData: { email, password: 'pw', clientId: 'cid-rest-fallback', refreshToken: `rt-rest-fallback-${graphStatus}` },
      provider: 'outlook',
      apiBase: '',
    });

    expect(messages.map((message) => message.id)).toEqual([`rest-${graphStatus}`]);
    expect(mailUrls.some((url) => url.includes('graph.microsoft.com'))).toBe(true);
    expect(mailUrls.some((url) => url.includes('outlook.office.com/api/'))).toBe(true);
    expect(db.prepare(`SELECT api_type FROM outlook_accounts WHERE email = ?`).get(email)).toEqual({ api_type: 'outlook' });
  });
});

/**
 * Contract: an access token is cached per credential pair, and the cache must
 * distinguish credentials that differ ANYWHERE in the refresh token. Pool
 * accounts share a client_id, so if the key only looks at part of the token,
 * two accounts can collide and the second is handed the first one's access
 * token — which means the first one's mailbox. Found when a local mock used
 * readable tokens that all ended in the same 8 characters and every account
 * showed the same inbox.
 */
describe('access token cache isolation', () => {
  it('does not serve one account the mailbox of another whose token ends alike', async () => {
    const db = getDb();
    // Same client_id, and refresh tokens identical in their last 8 characters.
    const shared = 'suffix00';
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, api_type)
       VALUES ('first@outlook.com', 'pw', 'cid-shared', ?, 'graph')`,
    ).run(`rt-first-${shared}`);
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, api_type)
       VALUES ('second@outlook.com', 'pw', 'cid-shared', ?, 'graph')`,
    ).run(`rt-second-${shared}`);

    // The mail host only ever learns which mailbox is meant from the access
    // token, so the stub mints one per refresh token and reads it back.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      const json = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      if (u.includes('/oauth2/v2.0/token')) {
        const refresh = new URLSearchParams(String(init.body ?? '')).get('refresh_token') ?? '';
        return json({ access_token: `at-for-${refresh}` });
      }
      const token = String(new Headers(init.headers ?? {}).get('Authorization') ?? '');
      if (u.includes('/mailFolders/Inbox/')) {
        return json({ value: [{ id: `msg-${token.replace('Bearer at-for-rt-', '')}`, subject: 'x', receivedDateTime: '2026-07-01T10:00:00Z' }] });
      }
      return json({ value: [] });
    }));

    const provider = new OutlookProvider();
    const inbox = (email: string, refreshToken: string) => ({
      address: email,
      authData: { email, password: 'pw', clientId: 'cid-shared', refreshToken },
      provider: 'outlook',
      apiBase: '',
    });

    const first = await provider.getMessages(inbox('first@outlook.com', `rt-first-${shared}`));
    const second = await provider.getMessages(inbox('second@outlook.com', `rt-second-${shared}`));

    expect(first.map((m) => m.id)).toEqual([`msg-first-${shared}`]);
    expect(second.map((m) => m.id)).toEqual([`msg-second-${shared}`]);
  });
});
