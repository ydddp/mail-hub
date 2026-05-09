import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../../src/providers/base.js';

export class FakeProvider extends BaseProvider {
  createCount = 0;
  deleteCount = 0;
  messagesCount = 0;
  domains: string[];
  createdDomains: string[] = [];

  meta: ProviderMeta;

  constructor(opts: Partial<ProviderMeta> & { domains?: string[] } = {}) {
    super();
    this.domains = opts.domains ?? ['example.test'];
    this.meta = {
    name: 'fake',
    displayName: 'Fake Mail',
    type: 'api',
    tier: 'free',
    trustLevel: 5,
    rateLimit: { createPerMinute: 1, pollPerMinute: 2 },
    retention: 'test',
    features: {
      customUsername: true,
      pollInbox: true,
      realtime: false,
      attachments: false,
    },
      ...opts,
      rateLimit: {
        createPerMinute: opts.rateLimit?.createPerMinute ?? 1,
        pollPerMinute: opts.rateLimit?.pollPerMinute ?? 2,
      },
      features: {
        customUsername: opts.features?.customUsername ?? true,
        pollInbox: opts.features?.pollInbox ?? true,
        realtime: opts.features?.realtime ?? false,
        attachments: opts.features?.attachments ?? false,
      },
    };
  }

  async getDomains(): Promise<string[]> {
    return this.domains;
  }

  async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    this.createCount++;
    const username = opts?.username ?? `user${this.createCount}`;
    const domain = opts?.domain ?? 'example.test';
    this.createdDomains.push(domain);
    return {
      address: `${username}@${domain}`,
      authData: { token: `token-${this.createCount}` },
      provider: this.meta.name,
      apiBase: 'https://fake.test',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
  }

  async getMessages(_inbox: InboxData): Promise<Message[]> {
    this.messagesCount++;
    return [{
      id: 'message-1',
      from: 'sender@example.test',
      subject: 'Your code is 123456',
      excerpt: '123456',
      receivedAt: new Date().toISOString(),
    }];
  }

  async getMessage(_inbox: InboxData, messageId: string): Promise<MessageDetail> {
    return {
      id: messageId,
      from: 'sender@example.test',
      subject: 'Your code is 123456',
      excerpt: '123456',
      receivedAt: new Date().toISOString(),
      text: 'Use code 123456 to continue.',
    };
  }

  async deleteInbox(_inbox: InboxData): Promise<void> {
    this.deleteCount++;
  }
}
