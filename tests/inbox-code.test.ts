import { describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../src/providers/base.js';
import { registry } from '../src/providers/registry.js';
import { app, authHeaders } from './helpers/http.js';

class CodeTestProvider extends BaseProvider {
  meta: ProviderMeta = {
    name: 'code-test',
    displayName: 'Code Test Mail',
    type: 'api',
    tier: 'free',
    trustLevel: 5,
    rateLimit: { createPerMinute: 10, pollPerMinute: 10 },
    retention: 'test',
    features: {
      customUsername: true,
      pollInbox: true,
      realtime: false,
      attachments: false,
    },
  };

  constructor(
    private readonly messages: Message[],
    private readonly details: Record<string, MessageDetail>,
  ) {
    super();
  }

  async getDomains(): Promise<string[]> {
    return ['example.test'];
  }

  async createInbox(): Promise<InboxData> {
    return {
      address: 'user@example.test',
      authData: { token: 'test-token' },
      provider: this.meta.name,
      apiBase: 'https://example.test',
    };
  }

  async getMessages(): Promise<Message[]> {
    return this.messages;
  }

  async getMessage(_inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const detail = this.details[messageId];
    if (!detail) throw new Error(`Unknown message ${messageId}`);
    return detail;
  }
}

function insertCodeInbox(id: string): void {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  ).run(id, 'code-test', 'user@example.test', JSON.stringify({ token: 'test-token' }), 'https://example.test', '2026-06-05T00:00:00.000Z');
}

describe('inbox code extraction', () => {
  it('returns the selected message id and receivedAt with extracted codes', async () => {
    const receivedAt = '2026-06-05T00:02:00.000Z';
    registry.register(new CodeTestProvider([
      {
        id: 'msg-1',
        from: 'sender@example.test',
        subject: 'Your code is 654321',
        excerpt: '654321',
        receivedAt,
      },
    ], {
      'msg-1': {
        id: 'msg-1',
        from: 'sender@example.test',
        subject: 'Your code is 654321',
        excerpt: '654321',
        receivedAt,
        text: 'Use verification code 654321 to continue.',
      },
    }));
    insertCodeInbox('code-metadata');

    const res = await app.request('/api/inbox/code-metadata/code', { headers: authHeaders() });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      messageId: 'msg-1',
      receivedAt,
      email: {
        from: 'sender@example.test',
        subject: 'Your code is 654321',
      },
      codes: [
        expect.objectContaining({
          type: 'numeric',
          value: '654321',
        }),
      ],
    });
  });

  it('does not return the same latest message again when since equals its receivedAt', async () => {
    const receivedAt = '2026-06-05T00:03:00.000Z';
    registry.register(new CodeTestProvider([
      {
        id: 'msg-repeat',
        from: 'sender@example.test',
        subject: 'Your code is 111222',
        excerpt: '111222',
        receivedAt,
      },
    ], {
      'msg-repeat': {
        id: 'msg-repeat',
        from: 'sender@example.test',
        subject: 'Your code is 111222',
        excerpt: '111222',
        receivedAt,
        text: 'Use verification code 111222.',
      },
    }));
    insertCodeInbox('code-since-repeat');

    const res = await app.request(`/api/inbox/code-since-repeat/code?since=${encodeURIComponent(receivedAt)}`, { headers: authHeaders() });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      codes: [],
      email: null,
      messageId: null,
      receivedAt: null,
    });
  });

  it('rejects an invalid since parameter', async () => {
    registry.register(new CodeTestProvider([], {}));
    insertCodeInbox('code-invalid-since');

    const res = await app.request('/api/inbox/code-invalid-since/code?since=not-a-date', { headers: authHeaders() });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid since parameter' });
  });
});
