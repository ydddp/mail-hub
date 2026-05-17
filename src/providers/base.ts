export const PROVIDER = {
  OUTLOOK: 'outlook',
  YYDS: 'yyds',
  IMAP: 'imap',
  MAILTM: 'mailtm',
  MAILGW: 'mailgw',
  TEMPMAIL_LOL: 'tempmail-lol',
  TEMPMAIL_ING: 'tempmail-ing',
} as const;

export type ProviderName = typeof PROVIDER[keyof typeof PROVIDER];

export interface ProviderMeta {
  name: string;
  displayName: string;
  type: 'api' | 'alias';
  tier: 'free' | 'paid';
  trustLevel: number;
  rateLimit: {
    createPerMinute: number;
    pollPerMinute: number;
  };
  retention: string;
  features: {
    customUsername: boolean;
    pollInbox: boolean;
    realtime: boolean;
    attachments: boolean;
  };
}

export interface InboxData {
  address: string;
  authData: Record<string, string>;
  provider: string;
  apiBase: string;
  expiresAt?: string;
}

export interface Message {
  id: string;
  from: string;
  subject: string;
  excerpt: string;
  receivedAt: string;
}

export interface MessageDetail extends Message {
  text?: string;
  html?: string;
}

export abstract class BaseProvider {
  abstract meta: ProviderMeta;

  abstract getDomains(opts?: { for?: string }): Promise<string[]>;
  abstract createInbox(opts?: { domain?: string; username?: string; for?: string; subdomain?: string; inboxId?: string }): Promise<InboxData>;
  abstract getMessages(inbox: InboxData): Promise<Message[]>;
  abstract getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail>;

  async deleteInbox(_inbox: InboxData): Promise<void> {}
  async releaseInbox(_inbox: InboxData, _inboxId?: string): Promise<void> {}
}
