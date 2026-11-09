export const PROVIDER = {
  OUTLOOK: 'outlook',
  YYDS: 'yyds',
  IMAP: 'imap',
  ICLOUD: 'icloud',
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
    /**
     * Provider can hand out a sub-address (e.g. Outlook plus addressing) on
     * request. Optional so providers that cannot do it need no change.
     */
    alias?: boolean;
  };
}

export interface InboxData {
  /** Internal recovery marker; never serialize to authData or a public result. */
  creationRecoveryId?: string;
  address: string;
  authData: Record<string, string>;
  provider: string;
  apiBase: string;
  /** UTC ISO datetime with an explicit zone. */
  expiresAt?: string;
}

/** Internal To/Cc evidence survives object spreads but is omitted by JSON. */
export const MESSAGE_RECIPIENTS: unique symbol = Symbol('messageRecipients');

export interface Message {
  [MESSAGE_RECIPIENTS]?: readonly string[];
  id: string;
  from: string;
  subject: string;
  excerpt: string;
  /** UTC ISO datetime, or '' when the upstream instant is unknown. */
  receivedAt: string;
}

export interface MessageDetail extends Message {
  text?: string;
  html?: string;
}

/** Internal matching scan; one budget is retained for the entire HTTP request. */
export interface MailboxScanBudget {
  pages: number;
  metadata: number;
  imapUidValidity?: Record<string, string>;
}

export interface MailboxScanMeta {
  scope: 'inbox_and_junk';
  pages: number;
  metadata: number;
  complete: boolean;
  truncated: boolean;
  partial: boolean;
  folders: { folder: string; complete: boolean }[];
}

export interface MailboxScanControl {
  budget: MailboxScanBudget;
  checkpoint(): void;
  /** Deadline, cancellation and lease checks around each awaited operation. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** One charge to the existing shared provider-read limiter. */
  read<T>(operation: () => Promise<T>): Promise<T>;
  /** Report in-flight folder progress before the next awaited operation. */
  progress?(scan: MailboxScanMeta): void;
}

export type ProviderDomainMode = 'endpoint' | 'static' | 'from_create';

export abstract class BaseProvider {
  abstract meta: ProviderMeta;

  getDomainMode(): ProviderDomainMode {
    return 'endpoint';
  }

  /**
   * `alias` mirrors the create request: a provider that scopes its candidate
   * accounts by prior use must not exclude them when the caller will be handed
   * a fresh sub-address, or dispatch would reject the request before
   * createInbox ever runs.
   */
  abstract getDomains(opts?: { for?: string; alias?: boolean }): Promise<string[]>;
  /**
   * `account` names which pooled credential to draw from — an Apple ID, a
   * mailbox, whatever the provider pools. Providers that hold one pool per
   * process ignore it; a provider holding several has no other way to let a
   * caller say which, and picking silently is wrong when the accounts are not
   * interchangeable.
   */
  abstract createInbox(opts?: { domain?: string; username?: string; for?: string; subdomain?: string; inboxId?: string; alias?: boolean; account?: string; duration?: number }): Promise<InboxData>;
  abstract getMessages(inbox: InboxData): Promise<Message[]>;
  scanMessages?(inbox: InboxData, control: MailboxScanControl): Promise<{ messages: Message[]; scan: MailboxScanMeta }>;
  abstract getMessage(inbox: InboxData, messageId: string, control?: MailboxScanControl): Promise<MessageDetail>;

  async deleteInbox(_inbox: InboxData): Promise<void> {}
  async releaseInbox(_inbox: InboxData, _inboxId?: string): Promise<void> {}
}
