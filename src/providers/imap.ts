import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail } from './base.js';
import {
  fetchMessageDetailAcrossMailboxes,
  fetchMessagesAcrossMailboxes,
  testConnection,
  type ImapCreds,
} from './imap-core.js';
import { allRows, canonicalImapAddress, getDb, getRow, IMAP_ADDRESS_KEY_SQL, imapLeasesOverlap } from '../db.js';
import { ImapAddressConflictError, InvalidImapUsernameError, MessageNotFoundError, NoAssetCreatedError } from '../errors.js';
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
  const canonical = canonicalImapAddress(domain);
  return getActiveAccounts().find((account) => canonicalImapAddress(account.domain) === canonical);
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
 * The human-shaped space is small enough (~7M) that a repeat is realistic.
 * Two live inboxes on one address would read each other's mail, because a
 * catch-all mailbox is sorted by exact To/Cc recipients.
 *
 * `gen` is injectable so the collision path can be tested without relying on
 * a lucky draw.
 */
export function generateUniqueUsername(domain: string, gen: () => string = randomUsername): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = normalizeUsername(gen());
    if (!addressTaken(`${candidate}@${canonicalImapAddress(domain)}`)) return candidate;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${normalizeUsername(gen())}${randomString(4)}`;
    if (!addressTaken(`${candidate}@${canonicalImapAddress(domain)}`)) return candidate;
  }
  throw new ImapAddressConflictError();
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidImapUsernameError();
  const username = canonicalImapAddress(value);
  if (!username || /[@\s\x00-\x1f\x7f]/.test(username)) throw new InvalidImapUsernameError();
  return username;
}

function addressTaken(address: string): boolean {
  return !!getRow<{ one: number }>(getDb(), `
    SELECT 1 AS one FROM inboxes WHERE provider = 'imap' AND status = 'active'
      AND ${IMAP_ADDRESS_KEY_SQL} = ? LIMIT 1
  `, canonicalImapAddress(address));
}

function assertUnambiguousAddress(inbox: InboxData): void {
  const db = getDb();
  const leases = allRows<{
    id: string; status: string; created_at: string; closed_at: string | null; expires_at: string | null; quarantined: number;
  }>(db, `
    SELECT id, status, created_at, closed_at, expires_at,
      EXISTS(SELECT 1 FROM imap_ambiguous_leases q WHERE q.inbox_id = inboxes.id) AS quarantined
    FROM inboxes WHERE provider = 'imap'
      AND ${IMAP_ADDRESS_KEY_SQL} = ?
  `, canonicalImapAddress(inbox.address));
  const ambiguous = new Set<string>();
  for (let i = 0; i < leases.length; i++) {
    const a = leases[i];
    for (const b of leases.slice(i + 1)) {
      if (imapLeasesOverlap(a, b)) {
        ambiguous.add(a.id);
        ambiguous.add(b.id);
      }
    }
  }
  if (ambiguous.size) {
    const quarantine = db.prepare('INSERT OR IGNORE INTO imap_ambiguous_leases (inbox_id) VALUES (?)');
    db.transaction(() => { for (const id of ambiguous) quarantine.run(id); })();
  }
  const id = inbox.authData.inboxId;
  const active = leases.filter(lease => lease.status === 'active');
  const own = id ? leases.filter(lease => lease.id === id) : active.length ? active : leases;
  if ((id && own.length === 0) || own.some(lease => lease.quarantined || ambiguous.has(lease.id))) {
    throw new MessageNotFoundError();
  }
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
    return [...new Set(accounts.map((a) => canonicalImapAddress(a.domain)))];
  }

  async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    const specifiedUsername = opts && Object.hasOwn(opts, 'username') ? normalizeUsername(opts.username) : undefined;
    let account: ImapAccount | undefined;

    if (opts?.domain) {
      account = getAccountByDomain(opts.domain);
    }

    if (!account) {
      const accounts = getActiveAccounts();
      if (accounts.length === 0) throw new NoAssetCreatedError('No active IMAP accounts configured');
      account = accounts[Math.floor(Math.random() * accounts.length)];
    }

    const domain = canonicalImapAddress(account.domain);
    const username = specifiedUsername ?? generateUniqueUsername(domain);
    const address = canonicalImapAddress(`${username}@${domain}`);
    if (addressTaken(address)) throw new ImapAddressConflictError();

    return {
      address,
      authData: {
        imapAccountId: account.id,
        username,
        domain,
      },
      provider: this.meta.name,
      apiBase: `imap://${account.host}`,
    };
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    assertUnambiguousAddress(inbox);
    const address = canonicalImapAddress(inbox.address);
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);
    // Junk too: a catch-all domain forwarded into someone else's mailbox is
    // the classic DMARC-misaligned sender, so the receiving server junking a
    // verification mail is routine rather than exceptional.
    return fetchMessagesAcrossMailboxes(credsFor(account), { or: [{ to: address }, { cc: address }] }, {
      recipient: address,
      strictRecipient: true,
    });
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    assertUnambiguousAddress(inbox);
    const address = canonicalImapAddress(inbox.address);
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);
    // A UID names a message in the whole catch-all mailbox, not in this inbox.
    return fetchMessageDetailAcrossMailboxes(credsFor(account), messageId, {
      recipient: address,
      strictRecipient: true,
      allowBareUid: true,
    });
  }
}

export async function testImapConnection(account: ImapAccount): Promise<{ ok: boolean; error?: string }> {
  return testConnection(credsFor(account));
}
