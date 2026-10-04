import { parseTimestamp } from './time.js';
import { registry } from './providers/registry.js';
import { PROVIDER, type InboxData } from './providers/base.js';
import { createLogger } from './logger.js';
import { logIgnoredError } from './errors.js';

const log = createLogger('inbox-lifecycle');

export interface StoredInbox extends InboxData {
  id: string;
}

/**
 * SQLite writes created_at via datetime('now'), which is UTC in the shape
 * 'YYYY-MM-DD HH:MM:SS' — no zone marker. `new Date()` reads that as LOCAL
 * time, so on a host east of UTC the boundary lands earlier than the real
 * creation instant and history leaks through; west of UTC it lands later and
 * hides the tenant's own mail. Normalize to UTC before parsing. Returns 0 when
 * there is no usable timestamp, which callers treat as "no boundary known, do
 * not filter".
 */
export function parseInboxTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = parseTimestamp(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * SQLite datetime() records only the containing second, not the creation
 * instant within it. The first timestamp that is certainly not older than the
 * inbox is therefore the start of the following second.
 */
export function parseInboxStartTimestamp(value: string | null | undefined): number {
  const timestamp = parseInboxTimestamp(value);
  return timestamp ? timestamp + 1000 : 0;
}

/**
 * Pool providers reuse mailboxes that already hold the previous tenant's mail
 * (Outlook accounts are recycled, YYDS keys and IMAP catch-alls are shared), so
 * the inbox's own creation time is the only boundary between "mine" and
 * "history". The lower bound is strict: even a one-second overlap can expose
 * a previous tenant's message during a physical-mailbox handoff.
 *
 * Open leases keep missing or unparseable timestamps: dropping them would
 * silently lose real mail from providers with sloppy date fields. Once a lease
 * has ended, the same uncertainty fails closed so historical mail cannot cross
 * the durable tenant boundary.
 */
export interface InboxMessageWindow {
  created_at?: string | null;
  closed_at?: string | null;
  expires_at?: string | null;
  status?: string | null;
}

export function isMessageWithinInboxLifetime(
  receivedAt: string | undefined,
  inbox: number | InboxMessageWindow,
): boolean {
  if (typeof inbox === 'number') {
    if (!inbox) return true;
    if (!receivedAt) return true;
    const received = parseTimestamp(receivedAt);
    if (!Number.isFinite(received)) return true;
    return received >= inbox;
  }

  const start = parseInboxStartTimestamp(inbox.created_at);
  const validEnds = [parseInboxTimestamp(inbox.closed_at), parseInboxTimestamp(inbox.expires_at)].filter((value) => value > 0);
  const end = validEnds.length > 0 ? Math.min(...validEnds) : undefined;
  const ended = inbox.status === 'closed' || (end !== undefined && end <= Date.now());
  if (inbox.status === 'closed' && end === undefined) return false;
  if (!receivedAt) return !ended;
  const received = parseTimestamp(receivedAt);
  if (!Number.isFinite(received)) return !ended;
  const lower = start || undefined;
  if (lower !== undefined && received < lower) return false;
  return end === undefined || received < end;
}

export function rowToInboxData(row: { id: string; address: string; auth_data: string; provider: string; api_base: string | null }): InboxData {
  const storedAuthData = JSON.parse(row.auth_data) as Record<string, string>;
  return {
    address: row.address,
    // YYDS refreshes its per-inbox token by row id; the same address can live on
    // several rows (current + closed history), so the id must ride along in
    // authData or the refresh would match by address and clobber siblings.
    authData: row.provider === PROVIDER.YYDS
      ? { ...storedAuthData, inboxId: row.id }
      : storedAuthData,
    provider: row.provider,
    apiBase: row.api_base || '',
  };
}

export function parseStoredInbox(row: {
  id: string;
  provider: string;
  address: string;
  auth_data: string;
  api_base: string | null;
}): StoredInbox {
  return { id: row.id, ...rowToInboxData(row) };
}

export async function releaseInboxResources(
  inbox: StoredInbox,
  opts: { deleteExternal?: boolean } = {}
): Promise<void> {
  const provider = registry.get(inbox.provider);

  if (opts.deleteExternal) {
    await provider?.deleteInbox(inbox).catch((error: unknown) => {
      logIgnoredError(log, 'provider inbox deletion failed', error, { inboxId: inbox.id, provider: inbox.provider });
    });
  }

  await provider?.releaseInbox(inbox, inbox.id).catch((error: unknown) => {
    logIgnoredError(log, 'provider inbox release failed', error, { inboxId: inbox.id, provider: inbox.provider });
  });
}
