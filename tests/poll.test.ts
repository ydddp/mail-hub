import { describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { app, authHeaders } from './helpers/http.js';
import { FakeProvider } from './helpers/fake-provider.js';

function insertFakeInbox(id: string): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  ).run(id, 'fake', 'user@example.test', JSON.stringify({ token: 't' }), 'https://fake.test');
}

describe('poll rate limits', () => {
  it('returns 429 for /messages after the provider poll limit is reached', async () => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 10, pollPerMinute: 2 } });
    registry.register(provider);
    insertFakeInbox('poll-messages');

    expect((await app.request('/api/inbox/poll-messages/messages', { headers: authHeaders() })).status).toBe(200);
    expect((await app.request('/api/inbox/poll-messages/messages', { headers: authHeaders() })).status).toBe(200);
    const limited = await app.request('/api/inbox/poll-messages/messages', { headers: authHeaders() });

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      provider: 'fake',
      retryAfter: expect.any(String),
    });
    expect(provider.messagesCount).toBe(2);
    registry.unregister('fake');
  });

  it('applies the same 429 behavior to /code wait polling', async () => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 10, pollPerMinute: 1 } });
    registry.register(provider);
    insertFakeInbox('poll-code');

    expect((await app.request('/api/inbox/poll-code/code', { headers: authHeaders() })).status).toBe(200);
    const limited = await app.request('/api/inbox/poll-code/code?wait=true&timeout=10', { headers: authHeaders() });

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      provider: 'fake',
      retryAfter: expect.any(String),
    });
    expect(provider.messagesCount).toBe(1);
    registry.unregister('fake');
  });
});
