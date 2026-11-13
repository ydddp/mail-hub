import { parseTimestamp, providerTime } from '../time.js';
import { createHash, randomUUID } from 'crypto';
import { BaseProvider, MESSAGE_RECIPIENTS, PROVIDER, type InboxData, type Message, type MessageDetail, type ProviderMeta, type MailboxScanControl, type MailboxScanMeta } from './base.js';
import { allRows, getDb, getRow, getSetting } from '../db.js';
import { fetchWithTimeout, formatSender, randomString } from '../utils.js';
import { currentReadBudget, withReadBudget } from '../read-budget.js';
import { MessageNotFoundError, NoAssetCreatedError, UpstreamHttpError } from '../errors.js';
import { config } from '../config.js';
import { foldAsciiCase } from '../mail-address.js';
import { readOutlookHistory, type HistoryReadControl, type HistoryFolder, type OutlookHistoryState } from '../outlook-history.js';
import { isImapAuthenticationError } from './imap-core.js';
import {
  assertCurrentCredentials, beginCredentialRequest, checkpointCredentialResponse,
  currentCredentialContext, credentialsCurrent, OutlookCredentialStorageError, StaleOutlookCredentialsError,
  updateCredentialAccount, type OutlookCredentialContext,
} from '../outlook-credentials.js';
import {
  checkOutlookImap,
  fetchOutlookImapMessage,
  fetchOutlookImapMessages,
  scanOutlookImapMessages,
  initializeOutlookImapHistory,
  fetchOutlookImapHistoryPage,
  checkOutlookImapHistoryGenerations,
  outlookImapCreds,
} from './outlook-imap.js';

const OAUTH2_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_INBOX_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages';
const GRAPH_JUNK_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages';
const OUTLOOK_INBOX_URL = 'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages';
const OUTLOOK_JUNK_URL = 'https://outlook.office.com/api/v2.0/me/mailfolders/junkemail/messages';
const TOKEN_TTL = 55 * 60 * 1000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const MESSAGE_FIELDS = 'id,subject,from,receivedDateTime,body,bodyPreview,toRecipients,ccRecipients';

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
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

async function fetchOAuthToken(context: OutlookCredentialContext): Promise<{ accessToken: string; newRefreshToken?: string; expiresIn?: number }> {
  assertCurrentCredentials(context);
  beginCredentialRequest(context);
  const body = new URLSearchParams({
    client_id: context.clientId,
    refresh_token: context.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchWithTimeout(OAUTH2_URL, {
    diagnostic: 'oauth',
    timeout: 10000,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = checkpointCredentialResponse(context, res.status, await res.text()) as OAuthResponse;
  if (!res.ok) {
    // 400/401/403 carry an OAuth error verdict; anything else (429/5xx) is infrastructure.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new OAuthRejectedError('OAuth refresh rejected');
    }
    throw new UpstreamHttpError('OAuth token endpoint unavailable', res.status, res.headers.get('Retry-After'));
  }
  if (typeof data.access_token !== 'string' || !data.access_token || data.error) throw new Error('OAuth response missing usable access_token');
  return { accessToken: data.access_token, newRefreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : undefined, expiresIn: data.expires_in };
}

function commitRefreshedToken(context: OutlookCredentialContext, result: { accessToken: string; newRefreshToken?: string; expiresIn?: number }): string {
  assertCurrentCredentials(context);
  if (result.newRefreshToken) {
    if (!updateCredentialAccount(context, "refresh_token = ?, token_renewed_at = datetime('now')", [result.newRefreshToken])) {
      throw new StaleOutlookCredentialsError();
    }
    evictCachedToken(context.clientId, context.refreshToken);
    context.refreshToken = result.newRefreshToken;
  }
  setCachedToken(context.clientId, context.refreshToken, result.accessToken, result.expiresIn);
  return result.accessToken;
}

async function obtainAccessToken(context: OutlookCredentialContext): Promise<string> {
  assertCurrentCredentials(context);
  const cached = getCachedToken(context.clientId, context.refreshToken);
  if (cached) return cached;
  return commitRefreshedToken(context, await fetchOAuthToken(context));
}

async function fetchMailsGraph(accessToken: string, folderUrl: string, count = 20): Promise<GraphMessage[]> {
  const params = new URLSearchParams({
    $top: String(count),
    $orderby: 'receivedDateTime desc',
    $select: SCAN_FIELDS,
  });
  const res = await fetchWithTimeout(`${folderUrl}?${params}`, {
    diagnostic: /\/inbox\//i.test(folderUrl) ? 'inbox' : 'junk',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const apiType = folderUrl.startsWith('https://graph.microsoft.com') ? 'graph' : 'outlook';
  if (!res.ok) await res.body?.cancel();
  if (res.status === 401 || res.status === 403) throw new MailApiRejectedError(apiType, res.status);
  if (!res.ok) throw new UpstreamHttpError(`${apiType} mail API error`, res.status, res.headers.get('Retry-After'));
  const data = await res.json() as { value?: GraphMessage[] };
  // Normalize immediately: the Outlook REST API returns PascalCase fields, and
  // downstream dedup/sort must never see un-normalized ids/timestamps.
  return (data.value || []).map(normalizeMessage);
}

async function fetchMailsBothApis(accessToken: string, apiType: OutlookApiType | '', count = 20): Promise<{ messages: GraphMessage[]; apiType: Exclude<OutlookApiType, 'imap'> }> {
  const folders = async (inboxUrl: string, junkUrl: string) => {
    const controller = new AbortController();
    return withReadBudget({ signal: controller.signal }, async () => {
      const reads = [fetchMailsGraph(accessToken, inboxUrl, count), fetchMailsGraph(accessToken, junkUrl, count)];
      try { return await Promise.all(reads); }
      catch (error) {
        controller.abort(error);
        await Promise.allSettled(reads);
        throw error;
      }
    });
  };
  if (apiType === 'outlook') {
    const [inboxMsgs, junkMsgs] = await folders(OUTLOOK_INBOX_URL, OUTLOOK_JUNK_URL);
    return { messages: mergeMessages(inboxMsgs, junkMsgs, count), apiType: 'outlook' };
  }
  try {
    const [inboxMsgs, junkMsgs] = await folders(GRAPH_INBOX_URL, GRAPH_JUNK_URL);
    return { messages: mergeMessages(inboxMsgs, junkMsgs, count), apiType: 'graph' };
  } catch (e) {
    currentReadBudget()?.signal?.throwIfAborted();
    if (e instanceof MailApiRejectedError || !apiType) {
      const [inboxMsgs, junkMsgs] = await folders(OUTLOOK_INBOX_URL, OUTLOOK_JUNK_URL);
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

async function fetchSingleMessage(accessToken: string, messageId: string, apiType: OutlookApiType | '', control?: MailboxScanControl): Promise<GraphMessage> {
  const run = <T>(operation: () => Promise<T>) => control ? control.run(operation) : operation();
  const urls = apiType === 'outlook'
    ? [`https://outlook.office.com/api/v2.0/me/messages/${messageId}?$select=${MESSAGE_FIELDS}`]
    : [
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=${MESSAGE_FIELDS}`,
        `https://outlook.office.com/api/v2.0/me/messages/${messageId}?$select=${MESSAGE_FIELDS}`,
      ];
  let allNotFound = true;
  for (const url of urls) {
    const res = await run(() => fetchWithTimeout(url, { diagnostic: 'detail', headers: { Authorization: `Bearer ${accessToken}` }, ...(control ? { retries: 0, retryMode: 'never' as const, redirect: 'error' as const } : {}) }));
    if (!res.ok) await res.body?.cancel();
    if (res.status === 401 || res.status === 403) {
      throw new MailApiRejectedError(url.startsWith('https://graph.microsoft.com') ? 'graph' : 'outlook', res.status);
    }
    if (res.ok) return normalizeMessage(await run(() => res.json()));
    if (res.status !== 404) allNotFound = false;
    if (res.status === 429 || res.status >= 500) {
      throw new UpstreamHttpError('mail detail API error', res.status, res.headers.get('Retry-After'));
    }
  }
  if (allNotFound) throw new MessageNotFoundError();
  throw new Error('无法获取邮件详情');
}

function normalizeRecipients(recipients: any): GraphRecipient[] {
  if (!Array.isArray(recipients)) return [];
  return recipients.map((recipient) => {
    const address = recipient?.emailAddress || recipient?.EmailAddress;
    return { emailAddress: { name: address?.name || address?.Name || '', address: address?.address || address?.Address || '' } };
  });
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
    toRecipients: normalizeRecipients(msg.toRecipients || msg.ToRecipients),
    ccRecipients: normalizeRecipients(msg.ccRecipients || msg.CcRecipients),
  };
}

function hasRecipient(message: GraphMessage, recipient: string): boolean {
  const want = foldAsciiCase(recipient);
  return [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]
    .some((entry) => foldAsciiCase(entry.emailAddress?.address ?? '') === want);
}

function graphMsgToMessage(normalized: GraphMessage): Message {
  return {
    [MESSAGE_RECIPIENTS]: [...(normalized.toRecipients ?? []), ...(normalized.ccRecipients ?? [])]
      .map(recipient => recipient.emailAddress?.address ?? '').filter(address => typeof address === 'string' && !!address.trim()),
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

/** Only the account's own address permits a whole-mailbox tenant lease. */
function aliasRecipientOf(inbox: InboxData): string | undefined {
  if (!inbox.address.trim()) throw new MessageNotFoundError();
  // Old rows can differ from the account in more than the generated +tag.
  // Keep every distinct address scoped instead of broadening it to the whole
  // mailbox when its base/domain does not match. Admin reads bypass this path.
  return foldAsciiCase(inbox.address) === foldAsciiCase(accountEmailOf(inbox))
    ? undefined : inbox.address;
}

/**
 * One access-token attempt with a single retry after a mail API rejection or
 * an IMAP authentication rejection. Both the inbox path and the account-mailbox
 * path funnel through here so token rotation and retry behavior cannot drift.
 */
async function withAccessToken<T>(context: OutlookCredentialContext, run: (token: string) => Promise<T>, control?: Pick<MailboxScanControl, 'run' | 'checkpoint'>): Promise<T> {
  const awaited = <R>(operation: () => Promise<R>) => control ? control.run(operation) : operation();
  const accessToken = await awaited(() => obtainAccessToken(context));
  try {
    assertCurrentCredentials(context);
    const result = await awaited(() => run(accessToken));
    assertCurrentCredentials(context);
    return result;
  } catch (e) {
    control?.checkpoint();
    assertCurrentCredentials(context);
    if (!(e instanceof MailApiRejectedError) && !isImapAuthenticationError(e)) throw e;
    evictCachedToken(context.clientId, context.refreshToken);
    const token = await awaited(() => obtainAccessToken(context));
    assertCurrentCredentials(context);
    const result = await awaited(() => run(token));
    assertCurrentCredentials(context);
    return result;
  }
}

async function pollMailbox(context: OutlookCredentialContext, limit: number, recipient?: string): Promise<Message[]> {
  const { email } = context;
  const apiType = normalizeApiType(context.apiType);
  return withAccessToken(context, async (token) => {
    if (apiType === 'imap') {
      return fetchOutlookImapMessages(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl), limit, recipient);
    }
    let result: { messages: GraphMessage[]; apiType: Exclude<OutlookApiType, 'imap'> };
    try {
      result = await fetchMailsBothApis(token, apiType, limit);
    } catch (e) {
      currentReadBudget()?.signal?.throwIfAborted();
      assertCurrentCredentials(context);
      if (apiType) throw e;
      return fetchOutlookImapMessages(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl), limit, recipient)
        .then((messages) => {
          if (!updateCredentialAccount(context, "api_type = 'imap'")) throw new StaleOutlookCredentialsError();
          return messages;
        });
    }
    if (result.apiType && result.apiType !== apiType) {
      if (!updateCredentialAccount(context, 'api_type = ?', [result.apiType])) throw new StaleOutlookCredentialsError();
    }
    return result.messages.filter((message) => !recipient || hasRecipient(message, recipient)).map(graphMsgToMessage);
  });
}

const SCAN_FIELDS = 'id,subject,from,receivedDateTime,bodyPreview,toRecipients,ccRecipients';

/** Microsoft canonicalizes folder names to OData IDs. Keep requests on our own folder path. */
function validateScanContinuation(value: unknown, folderUrl: string): string {
  if (typeof value !== 'string') throw new Error('Invalid Outlook scan continuation');
  const expected = new URL(folderUrl);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Outlook scan continuation'); }
  const canonicalFolderPath = /^\/(v1\.0|api\/v2\.0)\/me\/mailFolders\('[a-z0-9_~.%+=-]+'\)\/messages$/i;
  const canonical = canonicalFolderPath.exec(url.pathname);
  const sameFolderPath = url.pathname.toLowerCase() === expected.pathname.toLowerCase();
  const sameApiFolderPath = canonical && expected.pathname.toLowerCase().startsWith(`/${canonical[1].toLowerCase()}/`);
  if (url.protocol !== 'https:' || url.hostname !== expected.hostname || url.username || url.password
    || (url.port && url.port !== '443') || (!sameFolderPath && !sameApiFolderPath) || url.hash) {
    throw new Error('Untrusted Outlook scan continuation');
  }
  // Preserve the provider's opaque paging query; never send the bearer token
  // to a returned path, even when it uses a valid-looking folder/account ID.
  expected.search = url.search;
  return expected.href;
}

async function scanHttpMailbox(token: string, apiType: 'graph' | 'outlook', control: MailboxScanControl, recipient?: string) {
  const bases = apiType === 'graph' ? [GRAPH_INBOX_URL, GRAPH_JUNK_URL] : [OUTLOOK_INBOX_URL, OUTLOOK_JUNK_URL];
  const folders = bases.map((base, i) => ({ base, folder: i === 0 ? 'Inbox' : 'Junk', complete: false,
    next: `${base}?${new URLSearchParams({ $top: '20', $orderby: 'receivedDateTime desc', $select: SCAN_FIELDS })}` }));
  const messages = new Map<string, Message>();
  const meta = (): MailboxScanMeta => ({ scope: 'inbox_and_junk', pages: control.budget.pages, metadata: control.budget.metadata,
    complete: folders.every(folder => folder.complete), truncated: folders.some(folder => !folder.complete),
    partial: false, folders: folders.map(({ folder, complete }) => ({ folder, complete })) });
  control.progress?.(meta());
  try {
    // Round robin prevents a busy Inbox from consuming Junk's entire budget.
    while (folders.some(folder => !folder.complete) && control.budget.pages < 5 && control.budget.metadata < 100) {
      for (const folder of folders) {
        control.checkpoint();
        if (folder.complete || control.budget.pages >= 5 || control.budget.metadata >= 100) continue;
        const page = await control.read(async () => {
          control.budget.pages++;
          control.progress?.(meta());
          const response = await control.run(() => fetchWithTimeout(folder.next, {
            diagnostic: folder.folder === 'Inbox' ? 'inbox' : 'junk',
            headers: { Authorization: `Bearer ${token}` }, retries: 0, retryMode: 'never', redirect: 'error',
          }));
          if (!response.ok) await response.body?.cancel();
          if (response.status === 401 || response.status === 403) throw new MailApiRejectedError(apiType, response.status);
          if (!response.ok) throw new UpstreamHttpError(`${apiType} scan mail API error`, response.status, response.headers.get('Retry-After'));
          return control.run(() => response.json()) as Promise<{ value?: unknown[]; '@odata.nextLink'?: unknown; 'odata.nextLink'?: unknown }>;
        });
        control.checkpoint();
        const next = page['@odata.nextLink'] ?? page['odata.nextLink'];
        // Validate even when the current page exhausts the remaining budget.
        folder.next = next === undefined || next === null ? '' : validateScanContinuation(next, folder.base);
        if (!Array.isArray(page.value)) throw new Error('Malformed Outlook scan list response');
        const values = page.value;
        const available = 100 - control.budget.metadata;
        for (const raw of values.slice(0, available)) {
          control.budget.metadata++;
          const message = normalizeMessage(raw);
          if (message.id && (!recipient || hasRecipient(message, recipient)) && !messages.has(message.id)) {
            messages.set(message.id, graphMsgToMessage(message));
          }
        }
        folder.complete = !folder.next && values.length <= available;
        control.progress?.(meta());
      }
    }
    return { messages: [...messages.values()].sort((a, b) => (parseTimestamp(b.receivedAt) || 0) - (parseTimestamp(a.receivedAt) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), scan: meta() };
  } catch (error) {
    if (error && typeof error === 'object') Object.assign(error, { scan: { ...meta(), complete: false, partial: control.budget.pages > 1 } });
    throw error;
  }
}

async function readMailboxMessage(context: OutlookCredentialContext, messageId: string, recipient?: string, control?: MailboxScanControl): Promise<MessageDetail> {
  const { email } = context;
  const apiType = normalizeApiType(context.apiType);
  if (apiType === 'imap') {
    return withAccessToken(context, async (token) => (
      fetchOutlookImapMessage(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl), messageId, recipient, control)
    ), control);
  }
  return withAccessToken(context, async (token) => {
    const message = await fetchSingleMessage(token, messageId, apiType, control);
    if (recipient && !hasRecipient(message, recipient)) throw new MessageNotFoundError();
    return graphMsgToDetail(message);
  }, control);
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
  return pollMailbox(currentCredentialContext(email, 'admin-mailbox-list'), limit);
}

/** Admin history keeps only metadata and continuation positions, never access tokens. */
export async function fetchAccountMailboxPage(email: string, adminKey: string, limit = 50, pageToken?: string, signal?: AbortSignal) {
  const context = currentCredentialContext(email, 'admin-mailbox-history');
  const deadline = Date.now() + 30_000;
  let initialApi = normalizeApiType(context.apiType) || 'graph';
  const imapCreds = async (control: HistoryReadControl) => {
    const token = await control.run(() => obtainAccessToken(context));
    assertCurrentCredentials(context);
    return outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl);
  };
  const fingerprint = () => createHash('sha256').update(JSON.stringify([context.clientId, context.refreshToken, context.oauthSessionId])).digest('hex');
  const validate = (state: OutlookHistoryState) => {
    assertCurrentCredentials(context);
    if (state.credentials.fingerprint !== fingerprint()) throw new Error('Outlook history credentials changed; reload the mailbox');
  };
  const retainOwnRotation = async (state: OutlookHistoryState, operation: () => Promise<void>) => {
    validate(state);
    try { await operation(); }
    finally {
      // A failed mail read does not undo a successfully committed OAuth refresh.
      // Never bless an external credential replacement or a stale operation.
      if (credentialsCurrent(context)) state.credentials.fingerprint = fingerprint();
    }
  };
  const initialize = async (control: HistoryReadControl): Promise<OutlookHistoryState> => {
    const apiType = initialApi;
    if (apiType === 'imap') {
      const folders = await initializeOutlookImapHistory(await imapCreds(control), control);
      return { apiType, limit, emitted: new Set(), credentials: { fingerprint: fingerprint() }, folders };
    }
    const bases = apiType === 'graph' ? [GRAPH_INBOX_URL, GRAPH_JUNK_URL] : [OUTLOOK_INBOX_URL, OUTLOOK_JUNK_URL];
    return { apiType, limit, emitted: new Set(), credentials: { fingerprint: fingerprint() }, folders: bases.map((base, index) => ({ folder: index === 0 ? 'Inbox' : 'Junk', buffer: [], next: `${base}?${new URLSearchParams({ $top: String(limit), $orderby: 'receivedDateTime desc', $select: SCAN_FIELDS })}` })) };
  };
  const load = (state: OutlookHistoryState, folder: HistoryFolder, control: HistoryReadControl) => retainOwnRotation(state, async () => {
    if (state.apiType === 'imap') {
      await fetchOutlookImapHistoryPage(await imapCreds(control), folder, state.limit, control);
      return;
    }
    const readPage = (token: string) => control.read(async () => {
      assertCurrentCredentials(context);
      const response = await control.run(() => fetchWithTimeout(folder.next!, { diagnostic: folder.folder === 'Inbox' ? 'inbox' : 'junk', headers: { Authorization: `Bearer ${token}` }, retries: 0, retryMode: 'never', redirect: 'error' }));
      assertCurrentCredentials(context);
      if (!response.ok) await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new MailApiRejectedError(state.apiType as 'graph' | 'outlook', response.status);
      if (!response.ok) throw new UpstreamHttpError('Outlook history mail API error', response.status, response.headers.get('Retry-After'));
      const page = await control.run(() => response.json()) as Record<string, unknown>;
      assertCurrentCredentials(context);
      if (!page || !Array.isArray(page.value)) throw new Error('Malformed Outlook history list response');
      const base = state.apiType === 'graph' ? (folder.folder === 'Inbox' ? GRAPH_INBOX_URL : GRAPH_JUNK_URL) : (folder.folder === 'Inbox' ? OUTLOOK_INBOX_URL : OUTLOOK_JUNK_URL);
      const next = page['@odata.nextLink'] ?? page['odata.nextLink'];
      folder.next = next === undefined || next === null ? null : validateScanContinuation(next, base);
      folder.buffer = page.value.map(normalizeMessage).filter(message => !!message.id).map(graphMsgToMessage)
        .sort((a, b) => (parseTimestamp(b.receivedAt) || 0) - (parseTimestamp(a.receivedAt) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
    if (context.apiType) await withAccessToken(context, readPage, control);
    else await readPage(await control.run(() => obtainAccessToken(context)));
  });
  const prepare = (state: OutlookHistoryState, control: HistoryReadControl) => retainOwnRotation(state, async () => {
    if (state.apiType === 'imap') await checkOutlookImapHistoryGenerations(await imapCreds(control), state.folders, control);
  });
  const read = () => readOutlookHistory(email, adminKey, pageToken, limit, initialize, load, validate, signal, deadline, prepare);
  let result;
  try { result = await read(); }
  catch (error) {
    if (pageToken !== undefined || context.apiType || !(error instanceof MailApiRejectedError) || error.apiType !== 'graph') throw error;
    initialApi = 'outlook';
    result = await read();
  }
  if (!pageToken && initialApi !== context.apiType && !updateCredentialAccount(context, 'api_type = ?', [initialApi])) throw new StaleOutlookCredentialsError();
  return result;
}

export async function fetchAccountMessage(email: string, messageId: string): Promise<MessageDetail> {
  return readMailboxMessage(currentCredentialContext(email, 'admin-mailbox-detail'), messageId);
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
        throw new NoAssetCreatedError(`Outlook 账号池中无可用账号 (${parts.join(', ')})`);
      }

      const { email, password, client_id: clientId, refresh_token: refreshToken } = row;
      if (!clientId || !refreshToken) {
        throw new NoAssetCreatedError(`Outlook 账号 ${email} 缺少令牌凭据`);
      }

      // Plus addressing is opt-in per request: the caller asks for an alias and
      // the tag is generated here, so no caller has to invent one or can probe
      // for which tags exist. The account still serves exactly one inbox, so the
      // tag buys a distinct address at the target service, not extra pool
      // capacity. Reads still scope each alias to its exact To/Cc recipients,
      // because mail to a previous tag can arrive after account reassignment.
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
    const recipient = aliasRecipientOf(inbox);
    return pollMailbox(currentCredentialContext(email, 'tenant-mailbox-list'), 20, recipient);
  }

  async scanMessages(inbox: InboxData, control: MailboxScanControl) {
    const context = currentCredentialContext(accountEmailOf(inbox), 'tenant-mailbox-list');
    const recipient = aliasRecipientOf(inbox);
    const apiType = normalizeApiType(context.apiType);
    return control.run(() => withAccessToken(context, async token => {
      control.checkpoint();
      if (apiType === 'imap') return scanOutlookImapMessages(outlookImapCreds(context.email, token, getSetting('proxy_url') || config.proxyUrl), control, recipient);
      // Never reuse folder continuations after changing APIs or refreshing a token.
      // An unknown account tries Graph, then REST only on a deterministic rejection.
      let result;
      let resolvedType: 'graph' | 'outlook' = apiType || 'graph';
      try { result = await scanHttpMailbox(token, resolvedType, control, recipient); }
      catch (error) {
        control.checkpoint();
        if (apiType || !(error instanceof MailApiRejectedError)) throw error;
        resolvedType = 'outlook';
        result = await scanHttpMailbox(token, resolvedType, control, recipient);
      }
      control.checkpoint();
      if (resolvedType !== apiType && !updateCredentialAccount(context, 'api_type = ?', [resolvedType])) throw new StaleOutlookCredentialsError();
      return result;
    }, control));
  }

  async getMessage(inbox: InboxData, messageId: string, control?: MailboxScanControl): Promise<MessageDetail> {
    const email = accountEmailOf(inbox);
    const recipient = aliasRecipientOf(inbox);
    const read = () => readMailboxMessage(currentCredentialContext(email, 'tenant-mailbox-detail'), messageId, recipient, control);
    return control ? control.run(read) : read();
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
 * 'invalid' only on a deterministic OAuth rejection or definitive
 * rejection by Graph, Outlook REST, and IMAP; network errors, throttling and 5xx
 * yield 'unknown' so callers never destroy accounts over an infrastructure blip.
 */
async function checkAccessToken(email: string, token: string, context?: OutlookCredentialContext): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }> {
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
    if (context) assertCurrentCredentials(context);
    try {
      if (probe.apiType === 'imap') {
        await checkOutlookImap(outlookImapCreds(email, token, getSetting('proxy_url') || config.proxyUrl));
        if (context) assertCurrentCredentials(context);
        return { status: 'valid', apiType: 'imap' };
      }
      const res = await fetchWithTimeout(`${probe.url}?$top=1`, {
        diagnostic: 'token_check',
        headers: { Authorization: `Bearer ${token}` },
      });
      await res.body?.cancel();
      if (context) assertCurrentCredentials(context);
      if (res.ok) return { status: 'valid', apiType: probe.apiType };
      if (res.status !== 401 && res.status !== 403) inconclusive = true;
    } catch (e) {
      if (context) assertCurrentCredentials(context);
      if (probe.apiType !== 'imap' || !isImapAuthenticationError(e)) inconclusive = true;
    }
  }
  return { status: inconclusive ? 'unknown' : 'invalid', apiType: '' };
}

/** OAuth owns the final session CAS; its just-issued RT is not in the account yet. */
export async function probeIssuedAccessToken(email: string, accessToken: string): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }> {
  return checkAccessToken(email, accessToken);
}

export function checkToken(context: OutlookCredentialContext, accessToken?: string): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }>;
export function checkToken(email: string, clientId: string, refreshToken: string): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }>;
export async function checkToken(
  input: OutlookCredentialContext | string, second?: string, refreshToken?: string,
): Promise<{ status: TokenCheckStatus; apiType: OutlookApiType | '' }> {
  let context: OutlookCredentialContext | undefined;
  try {
    context = typeof input === 'string' ? currentCredentialContext(input, 'account-check') : input;
    // Legacy utility callers may supply a pair, but never silently adopt a
    // different current pair. Production queued jobs pass their frozen context.
    if (typeof input === 'string' && (context.clientId !== second || context.refreshToken !== refreshToken)) throw new StaleOutlookCredentialsError();
    assertCurrentCredentials(context);
    if (typeof input !== 'string' && second) return await checkAccessToken(context.email, second, context);
    const cachedToken = getCachedToken(context.clientId, context.refreshToken);
    if (cachedToken) {
      const capability = await checkAccessToken(context.email, cachedToken, context);
      if (capability.status !== 'invalid') return capability;
      evictCachedToken(context.clientId, context.refreshToken);
    }
    const token = await obtainAccessToken(context);
    return await checkAccessToken(context.email, token, context);
  } catch (e) {
    if (e instanceof OutlookCredentialStorageError) throw e;
    let current = false;
    if (context) {
      try { assertCurrentCredentials(context); current = true; } catch { /* Stale results carry no verdict. */ }
    }
    return { status: current && e instanceof OAuthRejectedError ? 'invalid' : 'unknown', apiType: '' };
  }
}

/**
 * Returns the usable access token and an optional rotated refresh token.
 * Throws OAuthRejectedError on deterministic rejection and
 * UpstreamHttpError/network errors on infrastructure failure — callers must
 * only mark accounts invalid on OAuthRejectedError.
 */
export async function renewToken(context: OutlookCredentialContext): Promise<{ newRefreshToken?: string; accessToken: string }> {
  const result = await fetchOAuthToken(context);
  commitRefreshedToken(context, result);
  return { newRefreshToken: result.newRefreshToken, accessToken: result.accessToken };
}
