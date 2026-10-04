import { parseTimestamp, providerTime } from '../time.js';
import { ImapFlow, type SearchObject } from 'imapflow';
import { createHash } from 'crypto';
import type { Message, MessageDetail } from './base.js';
import { createLogger } from '../logger.js';
import { errorMessage, logIgnoredError } from '../errors.js';

const log = createLogger('imap-core');

/**
 * Everything a pooled IMAP connection needs, decoupled from any one table.
 *
 * `poolKey` is supplied by the caller rather than derived from an id: two
 * providers share this module's pool, and their account identifiers would
 * otherwise occupy the same key space. Callers namespace it — for example
 * `imap:${id}`, `icloud:${id}`, or `outlook:${email}`.
 */
export interface ImapCreds {
  poolKey: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  accessToken?: string;
  tls: boolean;
  proxy?: string;
  connectionTimeout?: number;
  socketTimeout?: number;
}

// A busy catch-all mailbox can match hundreds of UIDs; poll only the newest.
export const POLL_FETCH_LIMIT = 20;

async function connect(creds: ImapCreds): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: creds.accessToken
      ? { user: creds.user, accessToken: creds.accessToken }
      : { user: creds.user, pass: creds.password },
    ...(creds.proxy ? { proxy: creds.proxy } : {}),
    ...(creds.connectionTimeout ? { connectionTimeout: creds.connectionTimeout } : {}),
    ...(creds.socketTimeout ? { socketTimeout: creds.socketTimeout } : {}),
    logger: false,
  });
  try {
    await client.connect();
    return client;
  } catch (e) {
    client.close();
    throw e;
  }
}

/** The subset of imapflow's BODYSTRUCTURE tree this module needs. */
export interface BodyNode {
  part?: string;
  type?: string;
  disposition?: string;
  parameters?: { charset?: string };
  childNodes?: BodyNode[];
}

/**
 * Resolve which body parts actually hold the displayable text/html.
 *
 * Part numbers cannot be assumed: '1'/'2' only line up for a flat
 * multipart/alternative. A single-part message has no numbered children,
 * and under multipart/mixed the text lives at '1.1'/'1.2' while '2' is an
 * attachment. Worse, asking for a part that does not exist fails the whole
 * FETCH rather than just that part, so the structure must be read first.
 */
export function selectBodyParts(root: BodyNode | undefined): { text?: string; html?: string } {
  if (!root) return {};

  // Non-multipart message: RFC 3501 numbers the whole body as part 1.
  if (!root.childNodes?.length) {
    const type = root.type ?? '';
    if (type === 'text/html') return { html: '1' };
    if (type.startsWith('text/')) return { text: '1' };
    return {};
  }

  let text: string | undefined;
  let html: string | undefined;
  const walk = (node: BodyNode): void => {
    for (const child of node.childNodes ?? []) {
      if (child.childNodes?.length) {
        walk(child);
        continue;
      }
      // An attachment is not the message body even when it is text/*.
      if (child.disposition === 'attachment') continue;
      if (!text && child.type === 'text/plain') text = child.part;
      if (!html && child.type === 'text/html') html = child.part;
    }
  };
  walk(root);
  return { text, html };
}

/** Decode a body buffer using the part's declared charset, not a blind utf8 cast. */
export function decodeBody(buf: Buffer, charset?: string): string {
  if (!buf.length) return '';
  const label = (charset || 'utf-8').trim();
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    // Unknown/unsupported label — utf8 is the least-bad fallback.
    return buf.toString('utf8');
  }
}

interface PoolEntry {
  clientPromise: Promise<ImapFlow>;
  timer: ReturnType<typeof setTimeout>;
  credentialFingerprint: string;
}
const pool = new Map<string, PoolEntry>();
const IDLE_MS = 5 * 60 * 1000;

function credentialFingerprint(creds: ImapCreds): string {
  return createHash('sha256')
    .update(JSON.stringify([
      creds.host,
      creds.port,
      creds.user,
      creds.password,
      creds.accessToken,
      creds.tls,
      creds.proxy,
      creds.connectionTimeout,
      creds.socketTimeout,
    ]))
    .digest('hex');
}

export function evictClient(poolKey: string, entry?: PoolEntry): void {
  const current = pool.get(poolKey);
  if (!current) return;
  // Entry-matched eviction: an async error callback must not kill a newer
  // client that has since replaced the failed one.
  if (entry && current !== entry) return;
  clearTimeout(current.timer);
  pool.delete(poolKey);
  current.clientPromise
    .then((client) => client.logout().catch(() => client.close()))
    .catch((error: unknown) => {
      logIgnoredError(log, 'IMAP pooled client logout failed', error, { poolKey });
    });
}

/**
 * Hand back the entry alongside the client.
 *
 * Callers need it to evict the connection they actually used. Evicting by key
 * alone races: between a request failing and its catch block running, another
 * caller can have replaced a dead entry with a fresh client, and the bare
 * eviction would log that newcomer out from under every request now sharing it.
 * A local failure (a malformed body, a missing part) would take down a healthy
 * connection the same way.
 */
async function acquire(creds: ImapCreds): Promise<{ client: ImapFlow; entry: PoolEntry }> {
  const fingerprint = credentialFingerprint(creds);
  const existing = pool.get(creds.poolKey);
  if (existing?.credentialFingerprint === fingerprint) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => evictClient(creds.poolKey, existing), IDLE_MS);
    return { client: await existing.clientPromise, entry: existing };
  }
  if (existing) evictClient(creds.poolKey, existing);
  // The entry is registered synchronously (holding a promise) so concurrent
  // callers share one connection instead of racing to open duplicates.
  const entry: PoolEntry = {
    clientPromise: connect(creds).then((client) => {
      client.once('error', () => evictClient(creds.poolKey, entry));
      return client;
    }),
    timer: setTimeout(() => evictClient(creds.poolKey, entry), IDLE_MS),
    credentialFingerprint: fingerprint,
  };
  pool.set(creds.poolKey, entry);
  try {
    return { client: await entry.clientPromise, entry };
  } catch (e) {
    if (pool.get(creds.poolKey) === entry) {
      clearTimeout(entry.timer);
      pool.delete(creds.poolKey);
    }
    throw e;
  }
}

/** Case-insensitive exact address match against the envelope recipients. */
function addressedTo(
  envelope: { to?: { address?: string }[]; cc?: { address?: string }[] } | undefined,
  recipient: string,
  strictRecipient = false,
): boolean {
  const all = [...(envelope?.to ?? []), ...(envelope?.cc ?? [])];
  // A catch-all mailbox fails open for Bcc-only mail. Personal forwarding
  // mailboxes fail closed because an unverifiable message may be private.
  if (all.length === 0) return !strictRecipient;
  const want = recipient.toLowerCase();
  return all.some((a) => (a.address ?? '').toLowerCase() === want);
}

/**
 * List the newest messages matching `criteria`.
 *
 * The criteria is a parameter rather than a fixed `{ to }` because two
 * providers sort the same shared mailbox by different recipient evidence:
 * a catch-all domain answers on To, and which header an iCloud alias
 * survives in is settled empirically (see scripts/verify-icloud-imap.ts).
 */
export async function fetchMessagesBySearch(
  creds: ImapCreds,
  criteria: SearchObject,
  opts: { limit?: number; recipient?: string; strictRecipient?: boolean; mailbox?: string } = {},
): Promise<Message[]> {
  const limit = opts.limit ?? POLL_FETCH_LIMIT;
  const { client, entry } = await acquire(creds);
  try {
    const lock = await client.getMailboxLock(opts.mailbox ?? 'INBOX', { readOnly: true });
    try {
      const uids = await client.search(criteria, { uid: true });
      if (!uids || uids.length === 0) return [];
      const recent = uids.slice(-limit);
      const messages: Message[] = [];
      for await (const fetched of client.fetch(recent, { envelope: true, internalDate: true }, { uid: true })) {
        // SEARCH narrows; this decides. TO is a substring match on the
        // envelope field, so the search alone would hand one tenant another
        // tenant's mail whenever one address is a prefix of the other.
        if (opts.recipient && !addressedTo(fetched.envelope, opts.recipient, opts.strictRecipient)) continue;
        messages.push({
          id: String(fetched.uid),
          from: fetched.envelope?.from?.[0]?.address ?? '',
          subject: fetched.envelope?.subject ?? '',
          excerpt: '',
          receivedAt: fetched.internalDate
            ? (fetched.internalDate instanceof Date ? fetched.internalDate.toISOString() : providerTime(fetched.internalDate))
            : fetched.envelope?.date?.toISOString() ?? '',
        });
      }
      return messages;
    } finally {
      lock.release();
    }
  } catch (e) {
    evictClient(creds.poolKey, entry);
    throw e;
  }
}

/**
 * Read one message by UID.
 *
 * `opts.recipient` is not optional in spirit: a UID names a message in the
 * whole shared mailbox, and callers reach this with an id straight off the
 * request path. Without the check, a tenant who guesses a UID — they are small
 * sequential integers — reads a neighbour's body, verification code included,
 * even though the listing correctly hid it.
 */
export async function fetchMessageDetail(
  creds: ImapCreds,
  uid: string,
  opts: { recipient?: string; strictRecipient?: boolean; mailbox?: string } = {},
): Promise<MessageDetail> {
  const { client, entry } = await acquire(creds);
  try {
    const lock = await client.getMailboxLock(opts.mailbox ?? 'INBOX', { readOnly: true });
    try {
      const fetched = await client.fetchOne(uid, {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
      }, { uid: true });

      if (!fetched) throw new Error(`Message ${uid} not found`);

      // Same error as a genuinely absent UID, deliberately: distinguishing the
      // two would turn this endpoint into an oracle for which UIDs are live.
      //
      // `strictRecipient` decides what a message with no envelope recipients at
      // all means, and the right answer differs by whose mailbox is being read.
      // A catch-all domain mailbox exists only to serve these addresses, so
      // failing open there costs at most a stray while failing closed would
      // silently lose Bcc-only mail. An iCloud forwarding mailbox is the
      // operator's own personal inbox, where the same leniency hands a tenant
      // their private mail — so that caller asks to fail closed.
      if (opts.recipient) {
        if (!addressedTo(fetched.envelope, opts.recipient, opts.strictRecipient)) {
          throw new Error(`Message ${uid} not found`);
        }
      }

      const parts = selectBodyParts(fetched.bodyStructure as BodyNode | undefined);

      // download() applies the Content-Transfer-Encoding decoder, so
      // quoted-printable soft breaks cannot split a verification code the
      // way a raw toString() left them.
      const readPart = async (part: string): Promise<string> => {
        const { meta, content } = await client.download(uid, part, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of content) chunks.push(chunk as Buffer);
        return decodeBody(Buffer.concat(chunks), meta?.charset);
      };

      let text = '';
      let html = '';
      if (parts.text) {
        try { text = await readPart(parts.text); } catch (error) {
          log.warn('failed to read IMAP text body part', { poolKey: creds.poolKey, uid, part: parts.text, error: errorMessage(error) });
        }
      }
      if (parts.html) {
        try { html = await readPart(parts.html); } catch (error) {
          log.warn('failed to read IMAP html body part', { poolKey: creds.poolKey, uid, part: parts.html, error: errorMessage(error) });
        }
      }

      return {
        id: uid,
        from: fetched.envelope?.from?.[0]?.address ?? '',
        subject: fetched.envelope?.subject ?? '',
        excerpt: text.slice(0, 200),
        receivedAt: fetched.internalDate
          ? (fetched.internalDate instanceof Date ? fetched.internalDate.toISOString() : providerTime(fetched.internalDate))
          : fetched.envelope?.date?.toISOString() ?? '',
        text: text || undefined,
        html: html || undefined,
      };
    } finally {
      lock.release();
    }
  } catch (e) {
    evictClient(creds.poolKey, entry);
    throw e;
  }
}

/**
 * Say what the server actually refused.
 *
 * imapflow's `message` is the bare word "Command failed" for every rejection,
 * which tells an operator nothing about whether their password is wrong, the
 * mailbox is missing, or the host refused the connection. The useful text is
 * on the error object next to it, so read it.
 */
export function describeImapError(error: unknown): string {
  const base = errorMessage(error);
  if (!error || typeof error !== 'object') return base;

  const e = error as {
    responseText?: string;
    responseStatus?: string;
    serverResponseCode?: string;
    authenticationFailed?: boolean;
    code?: string;
  };

  const detail = e.responseText?.trim();
  const parts = [detail && detail !== base ? detail : undefined];

  if (e.serverResponseCode) parts.push(`[${e.serverResponseCode}]`);
  if (e.code && e.code !== e.serverResponseCode) parts.push(`(${e.code})`);

  const described = parts.filter(Boolean).join(' ');
  if (!described) return base;

  // The server's own words first — "Command failed" adds nothing in front of
  // them, but the auth verdict is worth stating because it decides which
  // credential to go fix.
  return e.authenticationFailed ? `authentication rejected: ${described}` : described;
}

export function isImapAuthenticationError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { authenticationFailed?: unknown }).authenticationFailed === true);
}

export async function findMailboxBySpecialUse(creds: ImapCreds, specialUse: string): Promise<string | undefined> {
  const { client, entry } = await acquire(creds);
  try {
    const mailboxes = await client.list();
    return mailboxes.find((mailbox) => mailbox.specialUse?.toLowerCase() === specialUse.toLowerCase())?.path;
  } catch (e) {
    evictClient(creds.poolKey, entry);
    throw e;
  }
}

export const JUNK_SPECIAL_USE = '\\Junk';

/**
 * Every mailbox a shared receiving account actually delivers into.
 *
 * Reading INBOX alone loses whatever the receiving server decided was spam,
 * and that decision is not ours to trust: a forwarded address breaks DMARC
 * alignment by construction — the Return-Path is rewritten while the header
 * From is not — so the mail most likely to be junked is exactly the
 * verification mail these providers exist to read. Observed in production on
 * 2026-08-23: four iCloud aliases received codes that Gmail filed under Junk,
 * and every poll reported an empty mailbox while the codes sat there.
 *
 * Junk is located by special-use rather than by name because the folder is
 * localised — the same Gmail account answers '[Gmail]/垃圾邮件' where an
 * English one answers '[Gmail]/Spam'.
 *
 * A failed LIST is deliberately not softened into "no junk folder". It fails
 * for the same reasons SELECT is about to — a dropped connection, a rejected
 * credential — and swallowing it here would hide an expired token from the
 * caller's own retry path, which then spends a second doomed connection
 * before noticing.
 */
export async function inboxAndJunkMailboxes(creds: ImapCreds): Promise<string[]> {
  const junk = await findMailboxBySpecialUse(creds, JUNK_SPECIAL_USE);
  return ['INBOX', ...(junk && junk.toUpperCase() !== 'INBOX' ? [junk] : [])];
}

export const IMAP_ID_PREFIX = 'imap:';

/** A single IMAP UID, never a range like `1:*` and never the `*` wildcard. */
const UID_PATTERN = /^[1-9]\d{0,9}$/;

/**
 * Name a message by its mailbox as well as its UID.
 *
 * A UID is unique only within one mailbox, so the moment a provider reads two
 * of them the bare UID it used to hand out stops identifying anything: INBOX
 * uid 7 and Junk uid 7 are different messages, and a detail read would serve
 * whichever mailbox it happened to open.
 */
export function encodeMailboxMessageId(mailbox: string, uid: string): string {
  return `${IMAP_ID_PREFIX}${Buffer.from(JSON.stringify([mailbox, uid])).toString('base64url')}`;
}

/**
 * `allowBareUid` is for the two providers that handed out bare UIDs before
 * mailboxes were part of the id: a listing taken seconds before an upgrade is
 * still in a caller's hand, and the admin address viewer accepts a UID typed
 * straight into the URL. Such an id can only ever have meant INBOX, which is
 * the only mailbox those providers ever read. Outlook never minted one and so
 * never accepts one.
 */
export function decodeMailboxMessageId(
  messageId: string,
  opts: { allowBareUid?: boolean; invalidMessage?: string } = {},
): { mailbox: string; uid: string } {
  const invalid = (): Error => new Error(opts.invalidMessage ?? 'Invalid IMAP message id');

  if (!messageId.startsWith(IMAP_ID_PREFIX)) {
    if (opts.allowBareUid && UID_PATTERN.test(messageId)) return { mailbox: 'INBOX', uid: messageId };
    throw invalid();
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(messageId.slice(IMAP_ID_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (
    !Array.isArray(value)
    || value.length !== 2
    || typeof value[0] !== 'string'
    || typeof value[1] !== 'string'
    || !UID_PATTERN.test(value[1])
    || Number(value[1]) > 0xffffffff
  ) {
    throw invalid();
  }
  return { mailbox: value[0], uid: value[1] };
}

/**
 * Poll every mailbox the account delivers into, oldest first.
 *
 * Ascending order is the contract callers already hold — the SPA reverses this
 * list to show newest first — so the merge sorts up and takes the newest
 * `limit` off the tail rather than re-ordering what every reader sees. The
 * sort is stable, so messages a server timestamps identically keep the order
 * their mailbox handed them over in instead of shuffling between polls.
 *
 * Only INBOX is allowed to fail the call. A junk mailbox that cannot be read
 * is reported and skipped, because the alternative is that one unreadable
 * folder hides mail that did arrive in the ordinary one.
 */
export async function fetchMessagesAcrossMailboxes(
  creds: ImapCreds,
  criteria: SearchObject,
  opts: { limit?: number; recipient?: string; strictRecipient?: boolean } = {},
): Promise<Message[]> {
  const limit = opts.limit ?? POLL_FETCH_LIMIT;
  const merged: Message[] = [];

  for (const mailbox of await inboxAndJunkMailboxes(creds)) {
    let messages: Message[];
    try {
      messages = await fetchMessagesBySearch(creds, criteria, { ...opts, limit, mailbox });
    } catch (error) {
      if (mailbox === 'INBOX') throw error;
      log.warn('failed to read junk mailbox', { poolKey: creds.poolKey, mailbox, error: errorMessage(error) });
      continue;
    }
    for (const message of messages) {
      merged.push({ ...message, id: encodeMailboxMessageId(mailbox, message.id) });
    }
  }

  return merged
    .sort((a, b) => (parseTimestamp(a.receivedAt) || 0) - (parseTimestamp(b.receivedAt) || 0))
    .slice(-limit);
}

/**
 * Read one message out of the mailbox its id names.
 *
 * The mailbox is checked against the same two this module ever lists, because
 * the id arrives straight off the request path. For iCloud the shared mailbox
 * is the operator's own personal account, so an unchecked mailbox name would
 * let a caller reach into their private folders instead of the alias's mail.
 */
export async function fetchMessageDetailAcrossMailboxes(
  creds: ImapCreds,
  messageId: string,
  opts: {
    recipient?: string;
    strictRecipient?: boolean;
    allowBareUid?: boolean;
    invalidMessage?: string;
  } = {},
): Promise<MessageDetail> {
  const { mailbox, uid } = decodeMailboxMessageId(messageId, opts);

  // INBOX needs no lookup, which keeps the ordinary read at one round trip.
  if (mailbox !== 'INBOX') {
    const junk = await findMailboxBySpecialUse(creds, JUNK_SPECIAL_USE);
    if (!junk || mailbox !== junk) throw new Error(opts.invalidMessage ?? 'Invalid IMAP message id');
  }

  const message = await fetchMessageDetail(creds, uid, {
    mailbox,
    recipient: opts.recipient,
    strictRecipient: opts.strictRecipient,
  });
  return { ...message, id: messageId };
}

export async function assertMailboxReadable(creds: ImapCreds, mailbox = 'INBOX'): Promise<void> {
  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      await client.search({ all: true }, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function testConnection(creds: ImapCreds): Promise<{ ok: boolean; error?: string }> {
  try {
    await assertMailboxReadable(creds);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeImapError(e) };
  }
}
