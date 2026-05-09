import { ImapFlow } from 'imapflow';
import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail } from './base.js';
import { allRows, getDb, getRow } from '../db.js';
import { randomString } from '../utils.js';
import { createLogger } from '../logger.js';
import { errorMessage, logIgnoredError } from '../errors.js';

const log = createLogger('imap');

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

async function connectImap(account: ImapAccount): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls === 1,
    auth: { user: account.user, pass: account.password },
    logger: false,
  });
  await client.connect();
  return client;
}

interface PoolEntry { client: ImapFlow; timer: ReturnType<typeof setTimeout>; }
const pool = new Map<string, PoolEntry>();
const IDLE_MS = 5 * 60 * 1000;

function evictClient(id: string): void {
  const entry = pool.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pool.delete(id);
  entry.client.logout().catch((error: unknown) => {
    logIgnoredError(log, 'IMAP pooled client logout failed', error, { accountId: id });
  });
}

async function getPooledClient(account: ImapAccount): Promise<ImapFlow> {
  const existing = pool.get(account.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => evictClient(account.id), IDLE_MS);
    return existing.client;
  }
  const client = await connectImap(account);
  client.once('error', () => evictClient(account.id));
  const timer = setTimeout(() => evictClient(account.id), IDLE_MS);
  pool.set(account.id, { client, timer });
  return client;
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

    const username = opts?.username || randomString(12);

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

    const client = await getPooledClient(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const toAddr = inbox.address;
        const uids = await client.search({ to: toAddr }, { uid: true });
        if (!uids || uids.length === 0) return [];
        const messages: Message[] = [];
        for (const uid of uids) {
          const fetched = await client.fetchOne(String(uid), {
            envelope: true,
            bodyStructure: true,
          }, { uid: true });
          if (!fetched) continue;
          messages.push({
            id: String(uid),
            from: fetched.envelope?.from?.[0]?.address ?? '',
            subject: fetched.envelope?.subject ?? '',
            excerpt: '',
            receivedAt: fetched.envelope?.date?.toISOString() ?? '',
          });
        }
        return messages;
      } finally {
        lock.release();
      }
    } catch (e) {
      evictClient(account.id);
      throw e;
    }
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);

    const client = await getPooledClient(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const fetched = await client.fetchOne(messageId, {
          uid: true,
          envelope: true,
          bodyParts: ['1', '2'],
        }, { uid: true });

        if (!fetched) throw new Error(`Message ${messageId} not found`);

        let text = '';
        let html = '';
        try { text = fetched.bodyParts?.get('1')?.toString() ?? ''; } catch (error) {
          log.warn('failed to read IMAP text body part', { accountId: account.id, messageId, error: errorMessage(error) });
        }
        try { html = fetched.bodyParts?.get('2')?.toString() ?? ''; } catch (error) {
          log.warn('failed to read IMAP html body part', { accountId: account.id, messageId, error: errorMessage(error) });
        }

        return {
          id: messageId,
          from: fetched.envelope?.from?.[0]?.address ?? '',
          subject: fetched.envelope?.subject ?? '',
          excerpt: text.slice(0, 200),
          receivedAt: fetched.envelope?.date?.toISOString() ?? '',
          text: text || undefined,
          html: html || undefined,
        };
      } finally {
        lock.release();
      }
    } catch (e) {
      evictClient(account.id);
      throw e;
    }
  }
}

export async function testImapConnection(account: ImapAccount): Promise<{ ok: boolean; error?: string }> {
  let client: ImapFlow;
  try {
    client = await connectImap(account);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  try {
    await client.mailboxOpen('INBOX');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    await client.logout().catch((error: unknown) => {
      logIgnoredError(log, 'IMAP test logout failed', error, { accountId: account.id });
    });
  }
}
