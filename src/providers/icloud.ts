import { randomUUID } from 'crypto';
import type { SearchObject } from 'imapflow';
import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail } from './base.js';
import {
  fetchMessageDetailAcrossMailboxes,
  fetchMessagesAcrossMailboxes,
  type ImapCreds,
} from './imap-core.js';
import { MAILHUB_HME_LABEL, type IcloudClient } from './icloud-client.js';
import { allRows, getDb, getRow } from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('icloud');

/**
 * Domains Apple may issue an alias on.
 *
 * Static rather than fetched: Apple exposes no endpoint for this, and in June
 * 2026 it announced new addresses move to private.icloud.com while icloud.com
 * and privaterelay.appleid.com keep working. All three must be recognised or
 * dispatch and the block rules will disown live addresses.
 */
const ICLOUD_DOMAINS = ['icloud.com', 'private.icloud.com', 'privaterelay.appleid.com'];

export interface IcloudAccountRow {
  id: string;
  apple_id: string;
  region: string;
  cookies: string;
  hme_service_url: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password: string;
  imap_tls: number;
}

const ACCOUNT_COLUMNS = `id, apple_id, region, cookies, hme_service_url,
  imap_host, imap_port, imap_user, imap_password, imap_tls`;

export function getAccountById(id: string): IcloudAccountRow | undefined {
  return getRow<IcloudAccountRow>(
    getDb(),
    `SELECT ${ACCOUNT_COLUMNS} FROM icloud_accounts WHERE id = ? AND status IN ('active', 'degraded')`,
    id,
  );
}

export function credsFor(account: IcloudAccountRow): ImapCreds {
  return {
    poolKey: `icloud:${account.id}`,
    host: account.imap_host,
    port: account.imap_port,
    user: account.imap_user,
    password: account.imap_password,
    tls: account.imap_tls === 1,
  };
}

/**
 * Refill backoff lives in the database, not in `rateLimiter`.
 *
 * Apple's generation limit is measured in tens of minutes, and `rateLimiter`
 * keeps its cooldowns in an in-memory Map (`src/rate-limiter.ts:20`) that a
 * restart clears. A deploy would therefore wipe the backoff and the next tick
 * would immediately hammer Apple again. These are different lifetimes, not a
 * workaround: rateLimiter governs the request path, this governs an upstream
 * quota measured in hours.
 */
export function setCooldown(accountId: string, ms: number, reason: string): void {
  // datetime('now', 'NaN seconds') silently yields NULL — which is "no
  // cooldown at all", the exact opposite of what every caller means. Refuse
  // loudly instead of degrading into hammering Apple.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`iCloud cooldown must be a positive number of milliseconds, got ${ms}`);
  }
  getDb().prepare(
    `UPDATE icloud_accounts
        SET pool_cooldown_until = datetime('now', ? || ' seconds'),
            last_error = ?
      WHERE id = ?`,
  ).run(String(Math.round(ms / 1000)), reason, accountId);
}

export function clearCooldown(accountId: string): void {
  getDb().prepare(
    `UPDATE icloud_accounts SET pool_cooldown_until = NULL WHERE id = ?`,
  ).run(accountId);
}

export function inCooldown(accountId: string): boolean {
  const row = getRow<{ held: number }>(
    getDb(),
    `SELECT CASE
              WHEN pool_cooldown_until IS NULL THEN 0
              WHEN datetime(pool_cooldown_until) > datetime('now') THEN 1
              ELSE 0
            END AS held
       FROM icloud_accounts WHERE id = ?`,
    accountId,
  );
  return row?.held === 1;
}

/**
 * Bring the local pool back in line with Apple's own list.
 *
 * `reserve` succeeding at Apple and the row landing locally are two operations
 * with no transaction between them. A crash or a lost response in between
 * leaves an address that permanently consumes one of the account's 750 slots
 * while being invisible here — and the next tick mints another.
 *
 * Adoption is restricted to addresses carrying the Mail Hub marker. That
 * endpoint returns every alias on the Apple ID, including ones the owner
 * created by hand, and adopting one of those would hand their private mail to
 * an unrelated tenant. Anything unmarked is reported and left alone.
 */
export async function reconcileAccount(
  accountId: string,
  client: Pick<IcloudClient, 'listWithForwarding'>,
): Promise<{ adopted: string[]; unowned: string[] }> {
  const { hmeEmails } = await client.listWithForwarding();
  const db = getDb();

  const known = new Set(
    allRows<{ anonymous_id: string }>(db, `SELECT anonymous_id FROM icloud_addresses`)
      .map((r) => r.anonymous_id),
  );

  const adopted: string[] = [];
  const unowned: string[] = [];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO icloud_addresses (hme, account_id, anonymous_id, state) VALUES (?, ?, ?, ?)`,
  );

  for (const entry of hmeEmails) {
    if (known.has(entry.anonymousId)) continue;
    if (entry.label !== MAILHUB_HME_LABEL) {
      unowned.push(entry.hme);
      continue;
    }
    // An alias Apple lists as inactive was deactivated — by the retire path, or
    // by hand in Apple's own UI. Adopting it into the free pool would hand a
    // tenant an address that silently receives nothing, and they would sit
    // waiting for a verification code that can never arrive. Take it back under
    // management, but as retired.
    const state = entry.isActive === false ? 'retired' : 'free';
    const res = insert.run(entry.hme, accountId, entry.anonymousId, state);
    if (res.changes === 1 && state === 'free') adopted.push(entry.hme);
  }

  return { adopted, unowned };
}

/**
 * Return addresses whose inbox no longer exists.
 *
 * The hourly cleanup already does exactly this for Outlook ("released orphaned
 * Outlook assignments"), so this is the established shape for pool orphans
 * rather than a new concept.
 *
 * The state filter names 'assigned' rather than excluding 'free', and that is
 * load-bearing: a 'retired' row is an address deactivated at Apple, which no
 * longer receives mail. Widening this to "anything not free" would recycle it
 * and hand a tenant an alias that silently drops every message.
 */
export function reapOrphanedAddresses(): number {
  // The age floor protects the claim-to-insert window: the dispatcher claims
  // the address first and writes the inbox row moments later, so a cleanup
  // firing in between would see a "missing" inbox and put a just-claimed
  // address back in the pool — two live inboxes on one alias. Ten minutes is
  // orders of magnitude beyond that gap; NULL assigned_at means a pre-migration
  // row whose age is unknowable, which reaps as before.
  const result = getDb().prepare(
    `UPDATE icloud_addresses
        SET state = 'free', assigned_inbox_id = NULL, assigned_at = NULL
      WHERE state = 'assigned'
        AND assigned_inbox_id IS NOT NULL
        AND assigned_inbox_id NOT IN (SELECT id FROM inboxes)
        AND (assigned_at IS NULL OR datetime(assigned_at) < datetime('now', '-10 minutes'))`,
  ).run();
  return result.changes;
}

/**
 * How a message addressed to `hme` is found in the shared forward-to mailbox.
 *
 * Verified against a live account on 2026-08-02: Apple leaves the alias in the
 * To header verbatim, while Delivered-To carries the real forwarding mailbox.
 * scripts/verify-icloud-imap.ts reproduces the check; the seam stays because
 * the answer is Apple's to change, not ours.
 */
export function hmeSearchCriteria(hme: string): SearchObject {
  return { to: hme };
}

/**
 * One reading path for the provider and the admin address viewer.
 *
 * They used to call imap-core separately with the same arguments, which is how
 * the admin page ended up as blind to the junk folder as the poll was. Sharing
 * the function means the operator's own view of an address can never disagree
 * with what a tenant polling it sees.
 */
export async function fetchHmeMessages(account: IcloudAccountRow, hme: string): Promise<Message[]> {
  return fetchMessagesAcrossMailboxes(credsFor(account), hmeSearchCriteria(hme), {
    recipient: hme,
    strictRecipient: true,
  });
}

export async function fetchHmeMessage(
  account: IcloudAccountRow,
  hme: string,
  messageId: string,
): Promise<MessageDetail> {
  return fetchMessageDetailAcrossMailboxes(credsFor(account), messageId, {
    recipient: hme,
    strictRecipient: true,
    allowBareUid: true,
  });
}

export class IcloudProvider extends BaseProvider {
  meta = {
    name: PROVIDER.ICLOUD,
    displayName: 'iCloud 别名',
    // Deliberately 'api', not 'alias'. selectAllowedDomain returns early for
    // alias providers (dispatcher.ts:156) and never reaches the block filter,
    // so calling this an alias would make every domain block and auto-block
    // silently inert for iCloud — and it is the only alias provider, so that
    // path had never been exercised.
    type: 'api' as const,
    tier: 'paid' as const,
    trustLevel: 10,
    // createInbox only claims a pre-generated address with one local UPDATE.
    // Apple's generation limit constrains the refill task, not this path.
    rateLimit: { createPerMinute: 60, pollPerMinute: 10 },
    retention: '24h',
    features: {
      customUsername: false,
      pollInbox: true,
      realtime: false,
      attachments: true,
    },
  };

  getDomainMode(): 'static' {
    return 'static';
  }

  async getDomains(): Promise<string[]> {
    const accounts = allRows<{ id: string; status: string; last_error: string | null }>(
      getDb(),
      `SELECT id, status, last_error FROM icloud_accounts`,
    );
    // 'degraded' means the cookie expired: no new addresses can be minted, but
    // everything already in the pool still receives and still reads.
    const usable = accounts.some((a) => a.status === 'active' || a.status === 'degraded');
    if (usable) {
      // Only the domains we can actually satisfy. Apple decides which of the
      // three an alias lands on, so advertising all of them lets the dispatcher
      // pick one the pool holds nothing for — and createInbox then refuses a
      // request it could have served from a domain it never offered.
      const held = allRows<{ domain: string }>(
        getDb(),
        `SELECT DISTINCT substr(a.hme, instr(a.hme, '@') + 1) AS domain
           FROM icloud_addresses a
           JOIN icloud_accounts c ON c.id = a.account_id
          WHERE a.state = 'free' AND c.status IN ('active', 'degraded')`,
      ).map((r) => r.domain);
      return held.length ? held : ICLOUD_DOMAINS;
    }

    // Returning an empty list here surfaces as the dispatcher's generic "no
    // address available", which hides the actual cause: an account that failed
    // its check is skipped even when its address pool is full. Say so instead.
    const broken = accounts.find((a) => a.last_error);
    if (broken) {
      // The stored text is admin-only: imapHint writes the operator's own
      // forwarding mailbox into it, and this error reaches any API-key holder
      // through the dispatcher. Point at where the detail lives instead of
      // repeating it.
      log.warn('iCloud account unusable', { accountId: broken.id, error: broken.last_error });
      throw new Error('iCloud account is not usable — check its status on the admin iCloud page');
    }
    if (accounts.length) {
      throw new Error('iCloud account has not been tested yet — press Test on it first');
    }
    return [];
  }

  async createInbox(opts?: { domain?: string; inboxId?: string; account?: string }): Promise<InboxData> {
    const db = getDb();
    const inboxId = opts?.inboxId ?? `pending-${randomUUID()}`;

    // The dispatcher picks a domain from getDomains() after filtering blocks,
    // so honouring it is what makes a block on one iCloud domain mean anything.
    // Ignoring it would also hand a caller who asked for one domain an address
    // on another. Exact comparison, not LIKE: a caller-supplied '%' or '_'
    // would otherwise wildcard straight through a per-domain block.
    const domainFilter = opts?.domain ? ` AND substr(a.hme, instr(a.hme, '@') + 1) = ?` : '';
    const params: string[] = opts?.domain ? [opts.domain] : [];

    // Several Apple IDs are not interchangeable: each forwards to its own
    // mailbox, so which one an address came from decides who can read the mail.
    // Without this a caller had no way to say, and got whichever address had
    // been used least across every account.
    const accountFilter = opts?.account ? ` AND (c.id = ? OR c.apple_id = ?)` : '';
    if (opts?.account) params.push(opts.account, opts.account);

    // Claim in one conditional statement, exactly as Outlook does: the WHERE
    // clause is the lock, and changes === 0 means someone else won the race.
    const candidates = allRows<{ hme: string; account_id: string; anonymous_id: string }>(
      db,
      `SELECT a.hme, a.account_id, a.anonymous_id
         FROM icloud_addresses a
         JOIN icloud_accounts c ON c.id = a.account_id
        WHERE a.state = 'free' AND c.status IN ('active', 'degraded')${domainFilter}${accountFilter}
        ORDER BY a.use_count ASC, a.created_at ASC`,
      ...params,
    );

    for (const candidate of candidates) {
      const claimed = db.prepare(
        `UPDATE icloud_addresses
            SET state = 'assigned',
                assigned_inbox_id = ?,
                assigned_at = datetime('now'),
                use_count = use_count + 1
          WHERE hme = ? AND state = 'free'`,
      ).run(inboxId, candidate.hme);

      if (claimed.changes === 1) {
        return {
          address: candidate.hme,
          authData: {
            icloudAccountId: candidate.account_id,
            hme: candidate.hme,
            anonymousId: candidate.anonymous_id,
          },
          provider: this.meta.name,
          apiBase: 'https://www.icloud.com',
        };
      }
    }

    throw new Error(
      opts?.account
        ? `No free iCloud address for account '${opts.account}'; refill it, or omit the account to draw from any`
        : 'No free iCloud address in the pool; refill it before dispatching to this provider',
    );
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    const account = getAccountById(inbox.authData.icloudAccountId);
    if (!account) throw new Error(`iCloud account ${inbox.authData.icloudAccountId} not found`);
    // recipient is the exact check behind the substring SEARCH — see Task 2.
    // Hide My Email forwarding is DMARC-misaligned by construction, so the
    // forwarding mailbox junking a code is ordinary: read that folder too.
    return fetchHmeMessages(account, inbox.address);
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const account = getAccountById(inbox.authData.icloudAccountId);
    if (!account) throw new Error(`iCloud account ${inbox.authData.icloudAccountId} not found`);
    // A UID names a message anywhere in the shared forwarding mailbox — which
    // for iCloud is the operator's own personal inbox, not a mailbox that
    // exists only for these aliases. Anything whose recipient cannot be
    // verified is refused rather than handed over, and the id may only name
    // one of the two mailboxes the listing reads.
    return fetchHmeMessage(account, inbox.address, messageId);
  }

  /**
   * Left as the BaseProvider no-op on purpose.
   *
   * deleteExternal: true fires on every explicit user deletion, so deleting at
   * Apple here would permanently burn one of the account's 750 slots each time.
   * Apple-side deletion belongs only to retiring a burned address.
   */

  /**
   * Release the address only if this inbox is the one still holding it.
   *
   * Matching on `hme` as well would let a stale or replayed release free an
   * address that has since been claimed by someone else — and the hourly purge
   * re-releases an already-closed inbox a day after cleanup closed it
   * (app.ts:537-553), so the replay is routine, not hypothetical. Two live
   * inboxes on one alias read each other's mail.
   */
  async releaseInbox(_inbox: InboxData, inboxId?: string): Promise<void> {
    if (!inboxId) return;
    getDb().prepare(
      `UPDATE icloud_addresses
          SET state = 'free', assigned_inbox_id = NULL, assigned_at = NULL
        WHERE assigned_inbox_id = ?`,
    ).run(inboxId);
  }
}
