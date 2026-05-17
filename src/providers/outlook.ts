import { randomUUID } from 'crypto';
import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail, type ProviderMeta } from './base.js';
import { allRows, getDb, getRow } from '../db.js';
import { createConnection } from 'net';
import { fetchWithTimeout, formatSender } from '../utils.js';
import { errorMessage } from '../errors.js';

const OAUTH2_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_INBOX_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages';
const GRAPH_JUNK_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages';
const OUTLOOK_INBOX_URL = 'https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages';
const OUTLOOK_JUNK_URL = 'https://outlook.office.com/api/v2.0/me/mailfolders/junkemail/messages';
const IMAP_HOST = 'outlook.office365.com';
const IMAP_PORT = 993;

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
}

interface CountRow { c: number }

function cacheKey(clientId: string, refreshToken: string): string {
  return `${clientId}:${refreshToken.slice(-8)}`;
}

function getCachedToken(clientId: string, refreshToken: string): string | null {
  const entry = tokenCache.get(cacheKey(clientId, refreshToken));
  if (entry && Date.now() < entry.expiresAt) return entry.token;
  return null;
}

function setCachedToken(clientId: string, refreshToken: string, token: string): void {
  tokenCache.set(cacheKey(clientId, refreshToken), { token, expiresAt: Date.now() + TOKEN_TTL });
}

export function evictCachedToken(clientId: string, refreshToken: string): void {
  tokenCache.delete(cacheKey(clientId, refreshToken));
}

async function fetchOAuthToken(clientId: string, refreshToken: string): Promise<{ accessToken: string; newRefreshToken?: string } | null> {
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
  if (!res.ok) return null;
  const data = await res.json() as OAuthResponse;
  const accessToken = data.access_token;
  if (!accessToken) return null;
  return { accessToken, newRefreshToken: data.refresh_token };
}

async function obtainAccessToken(clientId: string, refreshToken: string): Promise<string | null> {
  const cached = getCachedToken(clientId, refreshToken);
  if (cached) return cached;
  const result = await fetchOAuthToken(clientId, refreshToken);
  if (!result) return null;
  setCachedToken(clientId, refreshToken, result.accessToken);
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
  if (res.status === 401) throw new Error('API 401');
  if (!res.ok) return [];
  const data = await res.json() as { value?: GraphMessage[] };
  return data.value || [];
}

async function fetchMailsBothApis(accessToken: string, apiType: string, count = 20): Promise<{ messages: GraphMessage[]; apiType: string }> {
  if (apiType === 'outlook') {
    const [inboxMsgs, junkMsgs] = await Promise.all([
      fetchMailsGraph(accessToken, OUTLOOK_INBOX_URL, count),
      fetchMailsGraph(accessToken, OUTLOOK_JUNK_URL, count),
    ]);
    return { messages: mergeMessages(inboxMsgs, junkMsgs), apiType: 'outlook' };
  }
  try {
    const [inboxMsgs, junkMsgs] = await Promise.all([
      fetchMailsGraph(accessToken, GRAPH_INBOX_URL, count),
      fetchMailsGraph(accessToken, GRAPH_JUNK_URL, count),
    ]);
    return { messages: mergeMessages(inboxMsgs, junkMsgs), apiType: 'graph' };
  } catch (e) {
    if (errorMessage(e).includes('401')) {
      const [inboxMsgs, junkMsgs] = await Promise.all([
        fetchMailsGraph(accessToken, OUTLOOK_INBOX_URL, count),
        fetchMailsGraph(accessToken, OUTLOOK_JUNK_URL, count),
      ]);
      return { messages: mergeMessages(inboxMsgs, junkMsgs), apiType: 'outlook' };
    }
    throw e;
  }
}

function mergeMessages(inboxMsgs: GraphMessage[], junkMsgs: GraphMessage[]): GraphMessage[] {
  const merged = new Map<string, GraphMessage>();
  for (const m of [...inboxMsgs, ...junkMsgs]) {
    if (!merged.has(m.id)) merged.set(m.id, m);
  }
  return [...merged.values()]
    .sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''))
    .slice(0, 20);
}

async function fetchSingleMessage(accessToken: string, messageId: string, apiType: string): Promise<GraphMessage> {
  const urls = apiType === 'outlook'
    ? [`https://outlook.office.com/api/v2.0/me/messages/${messageId}?$select=id,subject,from,receivedDateTime,body,bodyPreview`]
    : [
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=id,subject,from,receivedDateTime,body,bodyPreview`,
        `https://outlook.office.com/api/v2.0/me/messages/${messageId}?$select=id,subject,from,receivedDateTime,body,bodyPreview`,
      ];
  for (const url of urls) {
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) throw new Error('API 401');
    if (res.ok) return res.json() as Promise<GraphMessage>;
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
    receivedDateTime: msg.receivedDateTime || msg.ReceivedDateTime || '',
    body: msg.body || msg.Body ? {
      content: (msg.body || msg.Body)?.content || (msg.body || msg.Body)?.Content || '',
      contentType: ((msg.body || msg.Body)?.contentType || (msg.body || msg.Body)?.ContentType || '').toLowerCase(),
    } : undefined,
    bodyPreview: msg.bodyPreview || msg.BodyPreview || '',
  };
}

function graphMsgToMessage(msg: GraphMessage): Message {
  const normalized = normalizeMessage(msg);
  const sender = formatSender(normalized.from?.emailAddress || {});
  return {
    id: normalized.id,
    from: sender,
    subject: normalized.subject || '',
    excerpt: normalized.bodyPreview || '',
    receivedAt: normalized.receivedDateTime || '',
  };
}

function graphMsgToDetail(msg: GraphMessage): MessageDetail {
  const normalized = normalizeMessage(msg);
  const base = graphMsgToMessage(normalized);
  const bodyObj = normalized.body || {};
  const content = bodyObj.content || '';
  const isHtml = bodyObj.contentType === 'html';
  return {
    ...base,
    text: isHtml ? '' : content,
    html: isHtml ? content : '',
  };
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
      customUsername: false,
      pollInbox: true,
      realtime: false,
      attachments: true,
    },
  };

  private getFreshRefreshToken(email: string): string | null {
    const row = getRow<{ refresh_token: string }>(getDb(), `SELECT refresh_token FROM outlook_accounts WHERE email = ?`, email);
    return row?.refresh_token || null;
  }

  async getDomains(opts?: { for?: string }): Promise<string[]> {
    const db = getDb();
    let whereClauses = `assigned_inbox_id IS NULL AND token_status != 'invalid'`;
    const params: unknown[] = [];
    if (opts?.for) {
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

  async createInbox(opts?: { domain?: string; for?: string; inboxId?: string }): Promise<InboxData> {
    const db = getDb();
    const inboxId = opts?.inboxId ?? `pending-${randomUUID()}`;

    let whereClauses = `assigned_inbox_id IS NULL AND token_status != 'invalid'`;
    const selectParams: unknown[] = [];
    if (opts?.domain) {
      whereClauses += ` AND email LIKE ?`;
      selectParams.push(`%@${opts.domain}`);
    }
    if (opts?.for) {
      whereClauses += ` AND (used_services IS NULL OR used_services NOT LIKE ?)`;
      selectParams.push(`%"${opts.for.replace(/"/g, '\\"')}"%`);
    }
    const params: unknown[] = [inboxId, ...selectParams];

    const sql = `UPDATE outlook_accounts SET assigned_inbox_id = ?
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
        const assigned = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts WHERE assigned_inbox_id IS NOT NULL AND token_status != 'invalid'`)?.c ?? 0;
        const available = getRow<CountRow>(db, `SELECT COUNT(*) AS c FROM outlook_accounts WHERE ${whereClauses}`, ...selectParams)?.c ?? 0;
        const valid = available;
        const parts: string[] = [`共${total}个账号`];
        if (invalid > 0) parts.push(`${invalid}个无效`);
        if (assigned > 0) parts.push(`${assigned}个已分配`);
        if (valid > 0 && opts?.for) parts.push(`剩余${valid}个均已用于 ${opts.for}`);
        if (valid === 0 && !opts?.for) parts.push(`无空闲账号`);
        throw new Error(`Outlook 账号池中无可用账号 (${parts.join(', ')})`);
      }

      const { email, password, client_id: clientId, refresh_token: refreshToken } = row;
      if (!clientId || !refreshToken) {
        throw new Error(`Outlook 账号 ${email} 缺少令牌凭据`);
      }

      return {
        address: email,
        authData: { email, password, clientId, refreshToken },
        provider: this.meta.name,
        apiBase: '',
      };
    });

    return allocate();
  }

  markAssigned(email: string, inboxId: string): void {
    const db = getDb();
    db.prepare(`UPDATE outlook_accounts SET assigned_inbox_id = ? WHERE email = ?`).run(inboxId, email);
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    const { clientId } = inbox.authData;
    const email = inbox.authData.email || inbox.address;
    const freshToken = this.getFreshRefreshToken(email) || inbox.authData.refreshToken;
    const db = getDb();
    const apiType = getRow<{ api_type: string }>(db, `SELECT api_type FROM outlook_accounts WHERE email = ?`, email)?.api_type || '';
    let accessToken = await obtainAccessToken(clientId, freshToken);
    if (!accessToken) throw new Error('OAuth2 认证失败');

    try {
      const result = await fetchMailsBothApis(accessToken, apiType);
      if (result.apiType && result.apiType !== apiType) {
        db.prepare(`UPDATE outlook_accounts SET api_type = ? WHERE email = ?`).run(result.apiType, email);
      }
      return result.messages.map(graphMsgToMessage);
    } catch (e) {
      if (errorMessage(e).includes('401')) {
        evictCachedToken(clientId, freshToken);
        accessToken = await obtainAccessToken(clientId, freshToken);
        if (!accessToken) throw new Error('OAuth2 认证失败，令牌已过期');
        const result = await fetchMailsBothApis(accessToken, apiType);
        if (result.apiType && result.apiType !== apiType) {
          db.prepare(`UPDATE outlook_accounts SET api_type = ? WHERE email = ?`).run(result.apiType, email);
        }
        return result.messages.map(graphMsgToMessage);
      }
      throw e;
    }
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const { clientId } = inbox.authData;
    const email = inbox.authData.email || inbox.address;
    const freshToken = this.getFreshRefreshToken(email) || inbox.authData.refreshToken;
    const apiType = getRow<{ api_type: string }>(getDb(), `SELECT api_type FROM outlook_accounts WHERE email = ?`, email)?.api_type || '';

    let accessToken = await obtainAccessToken(clientId, freshToken);
    if (!accessToken) throw new Error('OAuth2 认证失败');

    try {
      const msg = await fetchSingleMessage(accessToken, messageId, apiType);
      return graphMsgToDetail(msg);
    } catch (e) {
      if (errorMessage(e).includes('401')) {
        evictCachedToken(clientId, freshToken);
        accessToken = await obtainAccessToken(clientId, freshToken);
        if (!accessToken) throw new Error('OAuth2 认证失败，令牌已过期');
        const msg = await fetchSingleMessage(accessToken, messageId, apiType);
        return graphMsgToDetail(msg);
      }
      throw e;
    }
  }

  async deleteInbox(inbox: InboxData): Promise<void> {
    const db = getDb();
    db.prepare(`UPDATE outlook_accounts SET assigned_inbox_id = NULL WHERE email = ?`).run(inbox.authData.email);
  }

  async releaseInbox(inbox: InboxData, inboxId: string): Promise<void> {
    const email = inbox.authData.email || inbox.address;
    getDb().prepare(
      `UPDATE outlook_accounts SET assigned_inbox_id = NULL WHERE assigned_inbox_id = ? OR email = ?`
    ).run(inboxId, email);
  }
}

export async function checkToken(email: string, clientId: string, refreshToken: string): Promise<{ valid: boolean; apiType: string }> {
  const token = await obtainAccessToken(clientId, refreshToken);
  if (!token) return { valid: false, apiType: '' };

  try {
    const res = await fetchWithTimeout(`${GRAPH_INBOX_URL}?$top=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { valid: true, apiType: 'graph' };
  } catch {}

  try {
    const res = await fetchWithTimeout(`${OUTLOOK_INBOX_URL}?$top=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { valid: true, apiType: 'outlook' };
  } catch {}

  return { valid: false, apiType: '' };
}

export async function renewToken(clientId: string, refreshToken: string): Promise<{ newRefreshToken: string; accessToken: string } | null> {
  const result = await fetchOAuthToken(clientId, refreshToken);
  if (!result || !result.newRefreshToken) return null;
  return { newRefreshToken: result.newRefreshToken, accessToken: result.accessToken };
}
