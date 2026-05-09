import { describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
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

  it('prevents another API key from reading, deleting, or reporting an inbox', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    addKey('owner-a');
    addKey('owner-b');
    addOwnedInbox('private-box', 'owner-a');

    const read = await app.request('/api/inbox/private-box/messages', { headers: authHeaders('owner-b') });
    const code = await app.request('/api/inbox/private-box/code', { headers: authHeaders('owner-b') });
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

    const ownerRead = await app.request('/api/inbox/private-box/messages', { headers: authHeaders('owner-a') });
    expect(ownerRead.status).toBe(200);
    registry.unregister('fake');
  });
});
