import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail } from './base.js';
import {
  fetchMessageDetailAcrossMailboxes,
  fetchMessagesAcrossMailboxes,
  testConnection,
  type ImapCreds,
} from './imap-core.js';
import { allRows, getDb, getRow } from '../db.js';
import { randomString } from '../utils.js';
import { randomUsername } from '../username-generator.js';

interface ImapAccount {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  domain: string;
  tls: number;
  status: string;
}

function getActiveAccounts(): ImapAccount[] {
  return allRows<ImapAccount>(
    getDb(),
    `SELECT id, host, port, user, password, domain, tls, status FROM imap_accounts WHERE status = 'active'`,
  );
}

function getAccountById(id: string): ImapAccount | undefined {
  return getRow<ImapAccount>(
    getDb(),
    `SELECT id, host, port, user, password, domain, tls, status FROM imap_accounts WHERE id = ? AND status = 'active'`,
    id,
  );
}

function getAccountByDomain(domain: string): ImapAccount | undefined {
  return getRow<ImapAccount>(
    getDb(),
    `SELECT id, host, port, user, password, domain, tls, status FROM imap_accounts WHERE domain = ? AND status = 'active' LIMIT 1`,
    domain,
  );
}

function credsFor(account: ImapAccount): ImapCreds {
  return {
    poolKey: `imap:${account.id}`,
    host: account.host,
    port: account.port,
    user: account.user,
    password: account.password,
    tls: account.tls === 1,
  };
}

/**
 * Draw a human-shaped username that no live inbox is already using.
 *
 * Unlike randomString(12), the human-shaped space is small enough (~7M) that
 * a repeat is realistic, and `inboxes.address` carries no unique constraint.
 * Two live inboxes on one address would read each other's mail, because a
 * catch-all mailbox is sorted by the To header alone.
 *
 * `gen` is injectable so the collision path can be tested without relying on
 * a lucky draw.
 */
export function generateUniqueUsername(domain: string, gen: () => string = randomUsername): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = gen();
    const taken = getRow<{ one: number }>(
      getDb(),
      `SELECT 1 AS one FROM inboxes WHERE address = ? AND status = 'active' LIMIT 1`,
      `${candidate}@${domain}`,
    );
    if (!taken) return candidate;
  }
  // Unlucky or genuinely crowded — a random suffix takes collision off the table.
  return `${gen()}${randomString(4)}`;
}

export class ImapProvider extends BaseProvider {
  meta = {
    name: PROVIDER.IMAP,
    displayName: 'IMAP / 域名邮箱',
    type: 'api' as const,
    tier: 'free' as const,
    trustLevel: 10,
    rateLimit: { createPerMinute: 60, pollPerMinute: 10 },
    retention: '24h',
    features: {
      customUsername: true,
      pollInbox: true,
      realtime: false,
      attachments: true,
    },
  };

  async getDomains(): Promise<string[]> {
    const accounts = getActiveAccounts();
    return [...new Set(accounts.map((a) => a.domain))];
  }

  async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    let account: ImapAccount | undefined;

    if (opts?.domain) {
      account = getAccountByDomain(opts.domain);
    }

    if (!account) {
      const accounts = getActiveAccounts();
      if (accounts.length === 0) throw new Error('No active IMAP accounts configured');
      account = accounts[Math.floor(Math.random() * accounts.length)];
    }

    const username = opts?.username || generateUniqueUsername(account.domain);

    return {
      address: `${username}@${account.domain}`,
      authData: {
        imapAccountId: account.id,
        username,
        domain: account.domain,
      },
      provider: this.meta.name,
      apiBase: `imap://${account.host}`,
    };
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);
    // Junk too: a catch-all domain forwarded into someone else's mailbox is
    // the classic DMARC-misaligned sender, so the receiving server junking a
    // verification mail is routine rather than exceptional.
    return fetchMessagesAcrossMailboxes(credsFor(account), { to: inbox.address }, { recipient: inbox.address });
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);
    // A UID names a message in the whole catch-all mailbox, not in this inbox.
    return fetchMessageDetailAcrossMailboxes(credsFor(account), messageId, {
      recipient: inbox.address,
      allowBareUid: true,
    });
  }
}

export async function testImapConnection(account: ImapAccount): Promise<{ ok: boolean; error?: string }> {
  return testConnection(credsFor(account));
}
