import { describe, expect, it } from 'vitest';
import { getDb, initDb } from '../src/db.js';
import { hashApiKey } from '../src/crypto.js';
import { registry } from '../src/providers/registry.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';
import { FakeProvider } from './helpers/fake-provider.js';

function addKey(key: string): void {
  getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey(key), key);
}

function addOwnedInbox(id: string, ownerKey: string): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, status, owner_key)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  ).run(id, 'fake', `${id}@example.test`, JSON.stringify({ token: 't' }), 'https://fake.test', hashApiKey(ownerKey));
}

describe('inbox ownership isolation', () => {
  it('filters inbox lists to the current API key', async () => {
    addKey('owner-a');
    addKey('owner-b');
    addOwnedInbox('owned-a', 'owner-a');
    addOwnedInbox('owned-b', 'owner-b');

    const res = await app.request('/api/inboxes', { headers: authHeaders('owner-a') });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.inboxes).toHaveLength(1);
    expect(body.inboxes[0].id).toBe('owned-a');
  });

  it.each(['', '?excludeMessageId=other-owner-id', '?selection=matching&excludeMessageId=other-owner-id'])
    ('prevents another API key from reading, deleting, or reporting an inbox %s', async query => {
    const provider = new FakeProvider();
    registry.register(provider);
    addKey('owner-a');
    addKey('owner-b');
    addOwnedInbox('private-box', 'owner-a');

    const read = await app.request('/api/inbox/private-box/messages', { headers: authHeaders('owner-b') });
    const code = await app.request(`/api/inbox/private-box/code${query}`, { headers: authHeaders('owner-b') });
    const remove = await app.request('/api/inbox/private-box', { method: 'DELETE', headers: authHeaders('owner-b') });
    const report = await app.request('/api/inbox/private-box/report', {
      method: 'POST',
      headers: jsonHeaders('owner-b'),
      body: JSON.stringify({ success: true, service: 'svc' }),
    });

    expect(read.status).toBe(404);
    expect(code.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(report.status).toBe(404);
    expect(provider.messagesCount).toBe(0);

    const ownerRead = await app.request('/api/inbox/private-box/messages', { headers: authHeaders('owner-a') });
    expect(ownerRead.status).toBe(200);
    registry.unregister('fake');
  });

  it('claims inbox deletion once when requests race', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    addKey('owner-a');
    addOwnedInbox('delete-race', 'owner-a');

    const [first, second] = await Promise.all([
      app.request('/api/inbox/delete-race', { method: 'DELETE', headers: authHeaders('owner-a') }),
      app.request('/api/inbox/delete-race', { method: 'DELETE', headers: authHeaders('owner-a') }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 200]);
    expect(provider.deleteCount).toBe(1);
    registry.unregister('fake');
  });

  it('gives two API keys only one canonical IMAP claim and permits reapplication after close', async () => {
    addKey('owner-a');
    addKey('owner-b');
    getDb().prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('claim-http', 'imap.test', 993, 'u', 'p', ' Example.COM ')`).run();
    const request = (key: string, username: unknown) => app.request('/api/inbox', {
      method: 'POST', headers: jsonHeaders(key), body: JSON.stringify({ for: 'claim.test', provider: 'imap', username }),
    });
    const responses = await Promise.all([request('owner-a', 'Alice'), request('owner-b', ' ALICE ')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.findIndex((response) => response.status === 201);
    const created = await responses[winner].json();
    const loser = await responses[1 - winner].json();
    expect(loser).toEqual({ error: 'IMAP address conflict' });
    const closed = await app.request(`/api/inbox/${created.id}`, { method: 'DELETE', headers: authHeaders(winner === 0 ? 'owner-a' : 'owner-b') });
    expect(closed.status).toBe(200);
    expect((await request(winner === 0 ? 'owner-b' : 'owner-a', 'alice')).status).toBe(201);
  });

  it.each(['', null, false, 0, 'a@b', 'a\u007fb'])('returns 400 for invalid IMAP username %j', async (username) => {
    getDb().prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('invalid-http', 'imap.test', 993, 'u', 'p', 'example.com')`).run();
    const response = await app.request('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ for: 'claim.test', provider: 'imap', username }) });
    expect(response.status).toBe(400);
  });

  it('reports ambiguous legacy IMAP list, detail, and code reads with the not-found verdict', async () => {
    addKey('owner-a');
    addKey('owner-b');
    const db = getDb();
    // Simulate rows written before startup installs the new invariant in this test-owned DB.
    db.exec(`DROP TRIGGER IF EXISTS imap_active_address_insert; DROP TRIGGER IF EXISTS imap_active_address_update;`);
    const insert = db.prepare(`INSERT INTO inboxes (id, provider, address, auth_data, owner_key) VALUES (?, 'imap', ?, '{"imapAccountId":"missing"}', ?)`);
    insert.run('legacy-a', ' Alice@EXAMPLE.COM ', hashApiKey('owner-a'));
    insert.run('legacy-b', 'alice@example.com', hashApiKey('owner-b'));
    db.close();
    initDb();
    for (const suffix of ['messages', 'messages/1', 'code']) {
      const response = await app.request(`/api/inbox/legacy-a/${suffix}`, { headers: authHeaders('owner-a') });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Message not found' });
    }
  });
});
