import { parseTimestamp, providerTime } from '../time.js';
import { createHash, randomUUID } from 'crypto';
import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail, type ProviderMeta } from './base.js';
import { allRows, getDb, getRow, getSetting } from '../db.js';
import { fetchWithTimeout, formatSender, randomString } from '../utils.js';
import { errorMessage, UpstreamHttpError } from '../errors.js';
import { config } from '../config.js';
import { isImapAuthenticationError } from './imap-core.js';
import {
  checkOutlookImap,
  fetchOutlookImapMessage,
  fetchOutlookImapMessages,
  outlookImapCreds,
} from './outlook-imap.js';

const OAUTH2_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_INBOX_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages';
const GRAPH_JUNK_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages';
const OUTLOOK_INBOX_URL = 'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages';
const OUTLOOK_JUNK_URL = 'https://outlook.office.com/api/v2.0/me/mailfolders/junkemail/messages';
const TOKEN_TTL = 55 * 60 * 1000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
}

interface OAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * The OAuth endpoint deterministically rejected the credentials (bad/expired
 * refresh token, revoked consent). Distinct from network errors, throttling
 * and 5xx, which say nothing about token validity.
 */
export class OAuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthRejectedError';
  }
}

class MailApiRejectedError extends Error {
  constructor(readonly apiType: Exclude<OutlookApiType, 'imap'>, readonly status: number) {
    super(`${apiType} mail API rejected access token`);
    this.name = 'MailApiRejectedError';
  }
}

export type TokenCheckStatus = 'valid' | 'invalid' | 'unknown';
export type OutlookApiType = 'graph' | 'outlook' | 'imap';

function normalizeApiType(value: string): OutlookApiType | '' {
  switch (value) {
    case 'graph':
    case 'outlook':
    case 'imap':
      return value;
    default:
      return '';
  }
}

interface CountRow { c: number }

const ALLOCABLE_ACCOUNT_WHERE = `assigned_inbox_id IS NULL
  AND client_id != ''
  AND refresh_token != ''
  AND COALESCE(token_status, '') NOT IN ('invalid', 'no_token', 'pending_oauth')`;

/**
 * Two accounts in the pool routinely share a client_id, so the refresh token is
 * the only thing telling their cached access tokens apart — and an access token
 * IS the mailbox. This used to key on `refreshToken.slice(-8)`, which throws
 * away all but 8 characters: two accounts whose tokens end alike collide, and
 * the second one is served the first one's mail. Real Microsoft tokens make that
 * astronomically unlikely, but the truncation bought nothing (this is an
 * in-memory map key, not storage), and "unlikely cross-account mail mixing" is
 * not a property worth keeping. Hash the whole token.
 */
function cacheKey(clientId: string, refreshToken: string): string {
  return `${clientId}:${createHash('sha256').update(refreshToken).digest('hex')}`;
}

/**
 * `local+tag@domain` → `local@domain`. Plus-addressed mail is delivered to the
 * base mailbox, so the account row is always keyed on the stripped form. Any
 * lookup that treats an inbox address as an account email must go through this
 * (or, better, read `authData.email`, which holds the account identity
 * verbatim). Returns the input unchanged when there is no tag.
 */
export function stripPlusTag(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  const local = address.slice(0, at);
  const plus = local.indexOf('+');
  if (plus < 0) return address;
  return local.slice(0, plus) + address.slice(at);
}

// RFC 5321 caps the local part at 64 octets; base + '+' + tag must fit.
const MAX_LOCAL_PART = 64;

/**
 * Microsoft accepts any legal SMTP local-part characters after the '+', but a
 * tag that reaches a signup form should be boring: letters, digits, dash,
 * underscore and dot only. Anything else is dropped rather than escaped, so a
 * caller-supplied tag can never produce an unroutable address.
 */
function sanitizeTag(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[.\-_]+/, '').slice(0, 24);
}

/**
 * Builds `local+tag@domain`, truncating the tag (never the base) if the local
 * part would exceed the RFC limit. Returns null when no usable tag survives, so
 * the caller falls back to the plain account address instead of shipping a
 * malformed one.
 */
export function buildAliasAddress(accountEmail: string, tag: string): string | null {
  const at = accountEmail.lastIndexOf('@');
  if (at <= 0) return null;
  const base = accountEmail.slice(0, at);
  const domain = accountEmail.slice(at);
  const budget = MAX_LOCAL_PART - base.length - 1;
  if (budget < 1) return null;
  const clean = sanitizeTag(tag).slice(0, budget);
  if (!clean) return null;
  return `${base}+${clean}${domain}`;
}

function getCachedToken(clientId: string, refreshToken: string): string | null {
  const entry = tokenCache.get(cacheKey(clientId, refreshToken));
  if (entry && Date.now() < entry.expiresAt) return entry.token;
  return null;
}

function setCachedToken(clientId: string, refreshToken: string, token: string, expiresIn?: number): void {
  const ttl = Number.isFinite(expiresIn) && expiresIn! > 0
    ? Math.max(60_000, expiresIn! * 1000 - 60_000)
    : TOKEN_TTL;
  tokenCache.set(cacheKey(clientId, refreshToken), { token, expiresAt: Date.now() + ttl });
}

export function evictCachedToken(clientId: string, refreshToken: string): void {
  tokenCache.delete(cacheKey(clientId, refreshToken));
}

/** Test hook: module-level cache must not leak between test cases. */
export function resetTokenCache(): void {
  tokenCache.clear();
}

async function fetchOAuthToken(clientId: string, refreshToken: string): Promise<{ accessToken: string; newRefreshToken?: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchWithTimeout(OAUTH2_URL, {
    timeout: 10000,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({})) as OAuthResponse;
  if (!res.ok) {
    const detail = [data.error, data.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
    // 400/401/403 carry an OAuth error verdict; anything else (429/5xx) is infrastructure.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new OAuthRejectedError(`OAuth refresh rejected: ${detail}`);
    }
    throw new UpstreamHttpError(`OAuth token endpoint error: ${detail}`, res.status, res.headers.get('Retry-After'));
  }
  if (!data.access_token) throw new Error('OAuth response missing access_token');
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token, expiresIn: data.expires_in };
}

async function obtainAccessToken(email: string, clientId: string, refreshToken: string): Promise<string> {
  const cached = getCachedToken(clientId, refreshToken);
  if (cached) return cached;
  const result = await fetchOAuthToken(clientId, refreshToken);
  const effectiveRefreshToken = result.newRefreshToken || refreshToken;
  if (result.newRefreshToken) {
    getDb().prepare(
      `UPDATE outlook_accounts
       SET refresh_token = ?, token_renewed_at = datetime('now')
       WHERE email = ? AND refresh_token = ?`,
    ).run(result.newRefreshToken, email, refreshToken);
    evictCachedToken(clientId, refreshToken);
  }
  setCachedToken(clientId, effectiveRefreshToken, result.accessToken, result.expiresIn);
  return result.accessToken;
}

async function fetchMailsGraph(accessToken: string, folderUrl: string, count = 20): Promise<GraphMessage[]> {
  const params = new URLSearchParams({
    $top: String(count),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,receivedDateTime,body,bodyPreview',
  });
  const res = await fetchWithTimeout(`${folderUrl}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const apiType = folderUrl.startsWith('https://graph.microsoft.com') ? 'graph' : 'outlook';
  if (res.status === 401 || res.status === 403) throw new MailApiRejectedError(apiType, res.status);
  if (!res.ok) throw new UpstreamHttpError(`${apiType} mail API error`, res.status, res.headers.get('Retry-After'));
  const data = await res.json() as { value?: GraphMessage[] };
  // Normalize immediately: the Outlook REST API returns PascalCase fields, and
  // downstream dedup/sort must never see un-normalized ids/timestamps.
  return (data.value || []).map(normalizeMessage);
}

async function fetchMailsBothApis(accessToken: string, apiType: OutlookApiType | '', count = 20): Promise<{ messages: GraphMessage[]; apiType: Exclude<OutlookApiType, 'imap'> }> {
  if (apiType === 'outlook') {
    const [inboxMsgs, junkMsgs] = await Promise.all([
      fetchMailsGraph(accessToken, OUTLOOK_INBOX_URL, count),
      fetchMailsGraph(accessToken, OUTLOOK_JUNK_URL, count),
    ]);
    return { messages: mergeMessages(inboxMsgs, junkMsgs, count), apiType: 'outlook' };
  }
  try {
    const [inboxMsgs, junkMsgs] = await Promise.all([
      fetchMailsGraph(accessToken, GRAPH_INBOX_URL, count),
      fetchMailsGraph(accessToken, GRAPH_JUNK_URL, count),
    ]);
    return { messages: mergeMessages(inboxMsgs, junkMsgs, count), apiType: 'graph' };
  } catch (e) {
    if (e instanceof MailApiRejectedError || !apiType) {
      const [inboxMsgs, junkMsgs] = await Promise.all([
        fetchMailsGraph(accessToken, OUTLOOK_INBOX_URL, count),
        fetchMailsGraph(accessToken, OUTLOOK_JUNK_URL, count),
      ]);
      return { messages: mergeMessages(inboxMsgs, junkMsgs, count), apiType: 'outlook' };
    }
    throw e;
  }
}

function mergeMessages(inboxMsgs: GraphMessage[], junkMsgs: GraphMessage[], limit = 20): GraphMessage[] {
  const merged = new Map<string, GraphMessage>();
  for (const m of [...inboxMsgs, ...junkMsgs]) {
    if (!merged.has(m.id)) merged.set(m.id, m);
  }
  return [...merged.values()]
    .sort((a, b) => (parseTimestamp(b.receivedDateTime) || 0) - (parseTimestamp(a.receivedDateTime) || 0))
    .slice(0, limit);
}

async function fetchSingleMessage(accessToken: string, messageId: string, apiType: OutlookApiType | ''): Promise<GraphMessage> {
  const urls = apiType === 'outlook'
    ? [`https://outlook.office.com/api/v2.0/me/messages/${messageId}?$select=id,subject,from,receivedDateTime,body,bodyPreview`]
    : [
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=id,subject,from,receivedDateTime,body,bodyPreview`,
        `https://outlook.office.com/api/v2.0/me/messages/${messageId}?$select=id,subject,from,receivedDateTime,body,bodyPreview`,
      ];
  for (const url of urls) {
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401 || res.status === 403) {
      throw new MailApiRejectedError(url.startsWith('https://graph.microsoft.com') ? 'graph' : 'outlook', res.status);
    }
    if (res.ok) return normalizeMessage(await res.json());
    if (res.status === 429 || res.status >= 500) {
      throw new UpstreamHttpError('mail detail API error', res.status, res.headers.get('Retry-After'));
    }
  }
  throw new Error('无法获取邮件详情');
}

function normalizeMessage(msg: any): GraphMessage {
  return {
    id: msg.id || msg.Id || '',
    subject: msg.subject || msg.Subject || '',
    from: msg.from || msg.From ? {
      emailAddress: {
        name: (msg.from?.emailAddress || msg.From?.EmailAddress)?.name || (msg.from?.emailAddress || msg.From?.EmailAddress)?.Name || '',
        address: (msg.from?.emailAddress || msg.From?.EmailAddress)?.address || (msg.from?.emailAddress || msg.From?.EmailAddress)?.Address || '',
      }
    } : undefined,
    receivedDateTime: providerTime(msg.receivedDateTime || msg.ReceivedDateTime),
    body: msg.body || msg.Body ? {
      content: (msg.body || msg.Body)?.content || (msg.body || msg.Body)?.Content || '',
      contentType: ((msg.body || msg.Body)?.contentType || (msg.body || msg.Body)?.ContentType || '').toLowerCase(),
    } : undefined,
    bodyPreview: msg.bodyPreview || msg.BodyPreview || '',
  };
}

function graphMsgToMessage(normalized: GraphMessage): Message {
  return {
    id: normalized.id,
    from: formatSender(normalized.from?.emailAddress || {}),
    subject: normalized.subject || '',
    excerpt: normalized.bodyPreview || '',
    receivedAt: normalized.receivedDateTime || '',
  };
}

function graphMsgToDetail(normalized: GraphMessage): MessageDetail {
  const bodyObj = normalized.body || {};
  const content = bodyObj.content || '';
  const isHtml = bodyObj.contentType === 'html';
  return {
    ...graphMsgToMessage(normalized),
    text: isHtml ? '' : content,
    html: isHtml ? content : '',
  };
}

/**
 * The account identity behind an inbox. `authData.email` holds it verbatim;
 * the fallback exists for rows written before that field, where `address` was
 * always the bare account email — strip any tag so an alias inbox can never
 * resolve to a non-existent account row.
 */
function accountEmailOf(inbox: InboxData): string {
  return inbox.authData.email || stripPlusTag(inbox.address);
}

/**
 * One access-token attempt with a single retry after a mail API rejection or
 * an IMAP authentication rejection. Both the inbox path and the account-mailbox
 * path funnel through here so token rotation and retry behavior cannot drift.
 */
async function withAccessToken<T>(email: string, clientId: string, refreshToken: string, run: (token: string) => Promise<T>): Promise<T> {
  let effectiveRefreshToken = getRow<{ refresh_token: string }>(
    getDb(),
    `SELECT refresh_token FROM outlook_accounts WHERE email = ?`,
    email,
  )?.refresh_token || refreshToken;
  const accessToken = await obtainAccessToken(email, clientId, effectiveRefreshToken);
  effectiveRefreshToken = getRow<{ refresh_token: string }>(
    getDb(),
    `SELECT refresh_token FROM outlook_accounts WHERE email = ?`,
    email,
  )?.refresh_token || effectiveRefreshToken;
  try {
    return await run(accessToken);
  } catch (e) {
    if (!(e instanceof MailApiRejectedError) && !isImapAuthenticationError(e)) throw e;
    evictCachedToken(clientId, effectiveRefreshToken);
    effectiveRefreshToken = getRow<{ refresh_token: string }>(
      getDb(),
      `SELECT refresh_token FROM outlook_accounts WHERE email = ?`,
      email,
    )?.refresh_token || effectiveRefreshToken;
    return run(await obtainAccessToken(email, clientId, effectiveRefreshToken));
  }
}

async function pollMailbox(email: string, clientId: string, refreshToken: string, limit: number): Promise<Message[]> {
  const db = getDb();
  const apiType = normalizeApiType(
    getRow<{ api_type: string }>(db, `SELECT api_type FROM outlook_accounts WHERE email = ?`, email)?.api_type || '',
  );
  return withAccessToken(email, clientId, refreshToken, async (token) => {
    if (apiType === 'imap') {
      return fetchOutlookImapMessages(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl), limit);
    }
    let result: { messages: GraphMessage[]; apiType: Exclude<OutlookApiType, 'imap'> };
    try {
      result = await fetchMailsBothApis(token, apiType, limit);
    } catch (e) {
      if (apiType) throw e;
      return fetchOutlookImapMessages(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl), limit)
        .then((messages) => {
          db.prepare(`UPDATE outlook_accounts SET api_type = 'imap' WHERE email = ?`).run(email);
          return messages;
        });
    }
    if (result.apiType && result.apiType !== apiType) {
      db.prepare(`UPDATE outlook_accounts SET api_type = ? WHERE email = ?`).run(result.apiType, email);
    }
    return result.messages.map(graphMsgToMessage);
  });
}

async function readMailboxMessage(email: string, clientId: string, refreshToken: string, messageId: string): Promise<MessageDetail> {
  const apiType = normalizeApiType(
    getRow<{ api_type: string }>(getDb(), `SELECT api_type FROM outlook_accounts WHERE email = ?`, email)?.api_type || '',
  );
  if (apiType === 'imap') {
    return withAccessToken(email, clientId, refreshToken, async (token) => (
      fetchOutlookImapMessage(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl), messageId)
    ));
  }
  return withAccessToken(email, clientId, refreshToken, async (token) => graphMsgToDetail(await fetchSingleMessage(token, messageId, apiType)));
}

function accountCredentials(email: string): { clientId: string; refreshToken: string } {
  const row = getRow<{ client_id: string; refresh_token: string }>(
    getDb(),
    `SELECT client_id, refresh_token FROM outlook_accounts WHERE email = ?`,
    email,
  );
  if (!row) throw new Error(`Outlook 账号不存在: ${email}`);
  if (!row.client_id || !row.refresh_token) throw new Error(`Outlook 账号 ${email} 缺少令牌凭据`);
  return { clientId: row.client_id, refreshToken: row.refresh_token };
}

/**
 * The whole mailbox behind an account, with no inbox lease in the picture.
 * An inbox is a lease over this mailbox, so its message list is deliberately
 * clipped to the lease window (isMessageWithinInboxLifetime) — that boundary is
 * a tenant boundary and must never be widened. Seeing what else is in the
 * mailbox is a different question, asked of the account, and answerable only to
 * an admin. Bounded by `limit` because upstream mailbox reads are deliberately
 * kept finite.
 */
export async function fetchAccountMailbox(email: string, limit = 50): Promise<Message[]> {
  const { clientId, refreshToken } = accountCredentials(email);
  return pollMailbox(email, clientId, refreshToken, limit);
}

export async function fetchAccountMessage(email: string, messageId: string): Promise<MessageDetail> {
  const { clientId, refreshToken } = accountCredentials(email);
  return readMailboxMessage(email, clientId, refreshToken, messageId);
}

export class OutlookProvider extends BaseProvider {
  meta: ProviderMeta = {
    name: PROVIDER.OUTLOOK,
    displayName: 'Outlook',
    type: 'api',
    tier: 'paid',
    trustLevel: 4,
    rateLimit: { createPerMinute: 60, pollPerMinute: 30 },
    retention: 'Permanent',
    features: {
      // The account's local part is fixed, so an arbitrary username is not
      // possible — only a `+tag` suffix on that fixed base. Advertising
      // customUsername would promise something this provider cannot do.
      customUsername: false,
      pollInbox: true,
      realtime: false,
      attachments: true,
      alias: true,
    },
  };

  private getFreshRefreshToken(email: string): string | null {
    const row = getRow<{ refresh_token: string }>(getDb(), `SELECT refresh_token FROM outlook_accounts WHERE email = ?`, email);
    return row?.refresh_token || null;
  }

  async getDomains(opts?: { for?: string; alias?: boolean }): Promise<string[]> {
    const db = getDb();
    let whereClauses = ALLOCABLE_ACCOUNT_WHERE;
    const params: unknown[] = [];
    if (opts?.for && !opts.alias) {
      whereClauses += ` AND (used_services IS NULL OR used_services NOT LIKE ?)`;
      params.push(`%"${opts.for.replace(/"/g, '\\"')}"%`);
    }
    const rows = allRows<{ domain: string }>(db,
      `SELECT DISTINCT SUBSTR(email, INSTR(email, '@') + 1) as domain
       FROM outlook_accounts WHERE ${whereClauses}`,
      ...params,
    );
    return rows.map((r) => r.domain);
  }

  async createInbox(opts?: { domain?: string; for?: string; inboxId?: string; alias?: boolean }): Promise<InboxData> {
    const db = getDb();
    const inboxId = opts?.inboxId ?? `pending-${randomUUID()}`;

    let whereClauses = ALLOCABLE_ACCOUNT_WHERE;
    const selectParams: unknown[] = [];
    if (opts?.domain) {
      // Exact comparison, not LIKE: a caller-supplied '%' or '_' would
      // otherwise wildcard past the domain the dispatcher chose.
      whereClauses += ` AND SUBSTR(email, INSTR(email, '@') + 1) = ?`;
      selectParams.push(opts.domain);
    }
    // used_services is the anti-reuse blacklist for the ACCOUNT's own address.
    // A fresh alias is a new address at the target service, which is the point
    // of asking for one, so an aliased request may reuse a burned account. The
    // record is still written on report, so a later PLAIN request for that
    // service still finds the account excluded.
    if (opts?.for && !opts.alias) {
      whereClauses += ` AND (used_services IS NULL OR used_services NOT LIKE ?)`;
      selectParams.push(`%"${opts.for.replace(/"/g, '\\"')}"%`);
    }
    const params: unknown[] = [inboxId, ...selectParams];

    const sql = `UPDATE outlook_accounts SET assigned_inbox_id = ?, assigned_at = datetime('now')
      WHERE email = (
        SELECT email FROM outlook_accounts
        WHERE ${whereClauses}
        ORDER BY CASE WHEN token_status = 'valid' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
      ) AND assigned_inbox_id IS NULL
      RETURNING email, password, client_id, refresh_token`;

    const allocate = db.transaction(() => {
      const row = db.prepare(sql).get(...params) as { email: string; password: string; client_id: string; refresh_token: string } | undefined;

      if (!row) {
        const total = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts`)?.c ?? 0;
        const invalid = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts WHERE token_status = 'invalid'`)?.c ?? 0;
        const pending = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts WHERE token_status IN ('pending_oauth', 'no_token') OR client_id = '' OR refresh_token = ''`)?.c ?? 0;
        const assigned = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts WHERE assigned_inbox_id IS NOT NULL AND COALESCE(token_status, '') NOT IN ('invalid', 'no_token', 'pending_oauth')`)?.c ?? 0;
        const available = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts WHERE ${whereClauses}`, ...selectParams)?.c ?? 0;
        const valid = available;
        const parts: string[] = [`共${total}个账号`];
        if (invalid > 0) parts.push(`${invalid}个无效`);
        if (pending > 0) parts.push(`${pending}个待补全`);
        if (assigned > 0) parts.push(`${assigned}个已分配`);
        if (valid > 0 && opts?.for) parts.push(`剩余${valid}个均已用于 ${opts.for}`);
        if (valid === 0 && !opts?.for) parts.push(`无空闲账号`);
        throw new Error(`Outlook 账号池中无可用账号 (${parts.join(', ')})`);
      }

      const { email, password, client_id: clientId, refresh_token: refreshToken } = row;
      if (!clientId || !refreshToken) {
        throw new Error(`Outlook 账号 ${email} 缺少令牌凭据`);
      }

      // Plus addressing is opt-in per request: the caller asks for an alias and
      // the tag is generated here, so no caller has to invent one or can probe
      // for which tags exist. The account still serves exactly one inbox, so the
      // tag buys a distinct address at the target service, not extra pool
      // capacity — and nothing has to sort shared mail by recipient.
      // `authData.email` stays the ACCOUNT address: every credential lookup
      // (refresh token, api_type, used_services) keys off it, and only
      // `address` carries the tag.
      const aliasAddress = opts?.alias ? buildAliasAddress(email, randomString(8)) : null;

      return {
        address: aliasAddress ?? email,
        authData: { email, password, clientId, refreshToken },
        provider: this.meta.name,
        apiBase: '',
      };
    });

    return allocate();
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    const email = accountEmailOf(inbox);
    const freshToken = this.getFreshRefreshToken(email) || inbox.authData.refreshToken;
    return pollMailbox(email, inbox.authData.clientId, freshToken, 20);
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const email = accountEmailOf(inbox);
    const freshToken = this.getFreshRefreshToken(email) || inbox.authData.refreshToken;
    return readMailboxMessage(email, inbox.authData.clientId, freshToken, messageId);
  }

  /**
   * Nothing to do here.
   *
   * Freeing by email alone would steal the account from whichever inbox holds
   * it now, and releaseInboxResources calls releaseInbox straight afterwards
   * on every path that reaches this one — so the release was redundant as well
   * as wrong.
   */
  async deleteInbox(_inbox: InboxData): Promise<void> {}

  /**
   * Release the account only if this inbox is the one still holding it.
   *
   * Matching on email as well would let a stale or replayed release free an
   * account already reassigned to another inbox; the hourly purge re-releases
   * an already-closed inbox a day after cleanup closed it (app.ts:537-553), so
   * that replay happens as a matter of course. Two live inboxes on one mailbox
   * read each other's mail.
   */
  async releaseInbox(_inbox: InboxData, inboxId: string): Promise<void> {
    if (!inboxId) return;
    getDb().prepare(
      `UPDATE outlook_accounts SET assigned_inbox_id = NULL, assigned_at = NULL WHERE assigned_inbox_id = ?`
    ).run(inboxId);
  }
}

/**
 * Never throws. 'invalid' only on a deterministic OAuth rejection or definitive
 * rejection by Graph, Outlook REST, and IMAP; network errors, throttling and 5xx
 * yield 'unknown' so callers never destroy accounts over an infrastructure blip.
 */
async function checkAccessToken(email: string, token: string): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }> {
  const storedType = normalizeApiType(
    getRow<{ api_type: string }>(getDb(), `SELECT api_type FROM outlook_accounts WHERE email = ?`, email)?.api_type || '',
  );
  const httpProbes = storedType === 'outlook'
    ? [[OUTLOOK_INBOX_URL, 'outlook'], [GRAPH_INBOX_URL, 'graph']] as const
    : [[GRAPH_INBOX_URL, 'graph'], [OUTLOOK_INBOX_URL, 'outlook']] as const;
  const probes: Array<{ apiType: OutlookApiType; url?: string }> = [
    ...httpProbes.map(([url, apiType]) => ({ url, apiType })),
    { apiType: 'imap' },
  ];
  if (storedType === 'imap') {
    probes.unshift(probes.pop()!);
  }

  let inconclusive = false;
  for (const probe of probes) {
    try {
      if (probe.apiType === 'imap') {
        await checkOutlookImap(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl));
        return { status: 'valid', apiType: 'imap' };
      }
      const res = await fetchWithTimeout(`${probe.url}?$top=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return { status: 'valid', apiType: probe.apiType };
      if (res.status !== 401 && res.status !== 403) inconclusive = true;
    } catch (e) {
      if (probe.apiType !== 'imap' || !isImapAuthenticationError(e)) inconclusive = true;
    }
  }
  return { status: inconclusive ? 'unknown' : 'invalid', apiType: '' };
}

export async function checkToken(
  email: string,
  clientId: string,
  refreshToken: string,
  accessToken?: string,
): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }> {
  if (accessToken) return checkAccessToken(email, accessToken);

  const cachedToken = getCachedToken(clientId, refreshToken);
  if (cachedToken) {
    const cachedCapability = await checkAccessToken(email, cachedToken);
    if (cachedCapability.status !== 'invalid') return cachedCapability;
    evictCachedToken(clientId, refreshToken);
  }

  let token: string;
  try {
    token = await obtainAccessToken(email, clientId, refreshToken);
  } catch (e) {
    return { status: e instanceof OAuthRejectedError ? 'invalid' : 'unknown', apiType: '' };
  }
  return checkAccessToken(email, token);
}

/**
 * Returns the usable access token and an optional rotated refresh token.
 * Throws OAuthRejectedError on deterministic rejection and
 * UpstreamHttpError/network errors on infrastructure failure — callers must
 * only mark accounts invalid on OAuthRejectedError.
 */
export async function renewToken(clientId: string, refreshToken: string): Promise<{ newRefreshToken?: string; accessToken: string }> {
  const result = await fetchOAuthToken(clientId, refreshToken);
  const effectiveRefreshToken = result.newRefreshToken || refreshToken;
  if (result.newRefreshToken) evictCachedToken(clientId, refreshToken);
  setCachedToken(clientId, effectiveRefreshToken, result.accessToken, result.expiresIn);
  return { newRefreshToken: result.newRefreshToken, accessToken: result.accessToken };
}
