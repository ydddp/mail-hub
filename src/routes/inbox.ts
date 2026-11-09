import { parseTimestamp, toUtcIso, utcFields, utcMessage } from '../time.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import { dispatch, getDomainAtLevel } from '../dispatcher.js';
import { registry } from '../providers/registry.js';
import { rateLimiter } from '../rate-limiter.js';
import { extractCodes } from '../code-extractor.js';
import { allRows, bumpServiceReported, getDb, getRow, getSetting, logActivity } from '../db.js';
import { isMessageWithinInboxLifetime, parseInboxTimestamp, parseStoredInbox, releaseInboxResources, rowToInboxData } from '../inbox-lifecycle.js';
import type { MailboxScanControl, MailboxScanMeta, Message, MessageDetail } from '../providers/base.js';
import { MESSAGE_RECIPIENTS, PROVIDER } from '../providers/base.js';
import { stripPlusTag } from '../providers/outlook.js';
import { foldAsciiCase } from '../mail-address.js';
import type { AdminEnv } from './admin.js';
import { createLogger } from '../logger.js';
import { errorMessage, httpStatus, ImapAddressConflictError, InvalidImapUsernameError, MessageNotFoundError, retryAfterHeader } from '../errors.js';

const log = createLogger('inbox-route');

type AppContext = Context<AdminEnv>;
type QueryParam = string | number | null;

interface InboxDataRow {
  id: string;
  provider: string;
  address: string;
  auth_data: string;
  api_base: string | null;
  status?: string;
  created_at?: string;
  closed_at?: string | null;
  expires_at?: string | null;
  owner_key?: string | null;
}

const INBOX_READ_COLUMNS = 'id, provider, address, auth_data, api_base, status, created_at, closed_at, expires_at, owner_key';

function isInboxPollingOpen(row: InboxDataRow): boolean {
  if (row.status === 'closed') return false;
  return [row.closed_at, row.expires_at].every((value) => {
    const end = parseInboxTimestamp(value);
    return !end || end > Date.now();
  });
}

function checkAutoBlock(db: Database.Database, service: string | undefined, provider: string, domain: string): { service: string; domain: string; rule: number }[] {
  if (!service || !domain) return [];

  db.prepare(`INSERT INTO fail_log (service, provider, domain) VALUES (?, ?, ?)`).run(service, provider, domain);

  const rules = allRows<{ id: number; service: string; provider: string; threshold: number; window_hours: number; scope: string; domain_level: number }>(
    db,
    `SELECT id, service, provider, threshold, window_hours, scope, domain_level FROM block_rules WHERE enabled = 1`,
  );

  const blocked: { service: string; domain: string; rule: number }[] = [];
  for (const rule of rules) {
    const { id: ruleId, service: ruleSvc, provider: ruleProv, threshold, window_hours: windowHours, scope, domain_level: domainLevel } = rule;
    if (ruleSvc !== '*' && ruleSvc !== service) continue;
    if (ruleProv !== '*' && ruleProv !== provider) continue;

    const normDomain = getDomainAtLevel(domain, domainLevel);

    let countSql = `SELECT COUNT(*) AS count FROM fail_log WHERE datetime(reported_at) > datetime('now', ?)`;
    const countParams: QueryParam[] = [`-${windowHours} hours`];
    countSql += ` AND (domain = ? OR domain LIKE ? ESCAPE '\\')`;
    countParams.push(normDomain, `%.${normDomain.replace(/[%_\\]/g, '\\$&')}`);
    if (ruleSvc !== '*') {
      countSql += ` AND service = ?`;
      countParams.push(ruleSvc);
    }
    if (ruleProv !== '*') {
      countSql += ` AND provider = ?`;
      countParams.push(ruleProv);
    }

    const countRow = getRow<{ count: number }>(db, countSql, ...countParams) ?? { count: 0 };
    const count = countRow.count;

    if (count >= threshold) {
      const svcToBlock = ruleSvc !== '*' ? ruleSvc : (scope === 'global' ? '*' : service);
      const reason = `Auto-block: rule#${ruleId}, ${count} failures/${windowHours}h` + (scope === 'global' ? ' (global)' : '');
      try {
        const info = db.prepare(`INSERT OR IGNORE INTO blocks (service, domain, provider, reason) VALUES (?, ?, ?, ?)`)
          .run(svcToBlock, normDomain, provider, reason);
        if (info.changes > 0) {
          blocked.push({ service: svcToBlock, domain: normDomain, rule: ruleId as number });
        }
      } catch (error) {
        log.warn('failed to insert auto-block record', { service: svcToBlock, domain: normDomain, provider, error: error });
      }
    }
  }
  return blocked;
}

export const inboxRoutes = new Hono<AdminEnv>();

function addOwnerScope(c: AppContext, sql: string, params: QueryParam[] = []): { sql: string; params: QueryParam[] } {
  if (c.get('isAdmin')) return { sql, params };
  return { sql: `${sql} AND owner_key = ?`, params: [...params, c.get('apiKey')] };
}

function getInboxRow<T extends object>(c: AppContext, id: string, columns: string): T | undefined {
  const db = getDb();
  const scoped = addOwnerScope(c, `SELECT ${columns} FROM inboxes WHERE id = ?`, [id]);
  return getRow<T>(db, scoped.sql, ...scoped.params);
}

/**
 * The Outlook account behind an inbox. With plus addressing the inbox address
 * is `local+tag@domain` while the account row is keyed on `local@domain`, so
 * `auth_data.email` — written by the provider and holding the account identity
 * verbatim — is the authoritative source. Falls back to the stripped address
 * for rows written before that field existed.
 */
function accountEmailForInbox(db: Database.Database, c: AppContext, id: string, address: string): string {
  const scoped = addOwnerScope(c, `SELECT json_extract(auth_data, '$.email') AS email FROM inboxes WHERE id = ?`, [id]);
  const row = getRow<{ email: string | null }>(db, scoped.sql, ...scoped.params);
  return row?.email || stripPlusTag(address);
}

class PollRateLimitError extends Error {
  retryAfter: string | null;

  constructor(
    readonly providerName: string,
    retryAfter: string | null
  ) {
    super(`Poll rate limit exceeded for provider '${providerName}'`);
    this.retryAfter = retryAfter;
  }
}

/** Charge each tenant-initiated provider read, including cached/failed details. */
async function readProvider<T>(providerName: string, read: () => Promise<T>): Promise<T> {
  if (!rateLimiter.isPollAvailable(providerName)) {
    throw new PollRateLimitError(providerName, rateLimiter.getPollStatus(providerName).nextAvailableAt);
  }
  rateLimiter.recordPoll(providerName);
  return read();
}

function pollRateLimitResponse(c: AppContext, e: PollRateLimitError, scan?: Record<string, unknown>) {
  return c.json({
    error: e.message,
    provider: e.providerName,
    retryAfter: e.retryAfter,
    ...(scan ? { scan } : {}),
  }, 429);
}

function readFailureResponse(c: AppContext, error: unknown, scan?: Record<string, unknown>) {
  const extra = scan ? { scan } : {};
  if (error instanceof PollRateLimitError) return pollRateLimitResponse(c, error, scan);
  if (error instanceof MessageNotFoundError) return c.json({ error: 'Message not found', ...extra }, 404);
  // Upstream authentication failure describes our provider credential, not the
  // tenant's own authentication. Only upstream throttling keeps its status.
  if (httpStatus(error, 0) === 429) {
    const retryAfter = retryAfterHeader(error);
    if (retryAfter !== undefined) c.header('Retry-After', retryAfter);
    return c.json({ error: errorMessage(error), ...extra }, 429);
  }
  return c.json({ error: errorMessage(error), ...extra }, 502);
}

function emptyCodeResponse(c: AppContext) {
  return c.json({ codes: [], email: null, messageId: null, receivedAt: null });
}

inboxRoutes.post('/inbox', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.for || typeof body.for !== 'string' || !body.for.trim()) {
    return c.json({ error: 'Missing required field: for' }, 400);
  }
  try {
    const result = await dispatch({
      for: body.for,
      provider: body.provider,
      domain: body.domain,
      subdomain: body.subdomain,
      ...(Object.hasOwn(body, 'username') ? { username: body.username } : {}),
      account: body.account,
      alias: body.alias === true,
      duration: body.duration,
      needPolling: body.needPolling,
      ownerKey: c.get('apiKey'),
    });
    logActivity('green', `Created inbox ${result.address} (${result.provider}${body.for ? ', ' + body.for : ''})`);
    return c.json(result, 201);
  } catch (e) {
    if (e instanceof ImapAddressConflictError) return c.json({ error: e.message }, 409);
    if (e instanceof InvalidImapUsernameError) return c.json({ error: e.message }, 400);
    const msg = errorMessage(e);
    const upstreamStatus = httpStatus(e, 0);
    const status = upstreamStatus === 429 || msg.includes('rate-limit') || msg.includes('rate limited') ? 429
      : msg.includes('not found') || msg.includes('not available') || msg.includes('example domain') ? 400
      : 503;
    return c.json({ error: msg }, status);
  }
});

inboxRoutes.get('/inboxes', (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const provider = c.req.query('provider');
  const forService = c.req.query('for');

  let sql = 'SELECT id, provider, address, target_service, created_at, expires_at, status FROM inboxes WHERE 1=1';
  const params: QueryParam[] = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (provider) {
    sql += ' AND provider = ?';
    params.push(provider);
  }
  if (forService) {
    sql += ' AND target_service = ?';
    params.push(forService);
  }
  if (!c.get('isAdmin')) {
    sql += ' AND owner_key = ?';
    params.push(c.get('apiKey'));
  }

  const countRow = getRow<{ total: number }>(
    db,
    sql.replace('SELECT id, provider, address, target_service, created_at, expires_at, status', 'SELECT COUNT(*) AS total'),
    ...params,
  ) ?? { total: 0 };
  const total = countRow.total;

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '50', 10)));
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(pageSize, (page - 1) * pageSize);

  const rows = db.prepare(sql).all(...params);

  return c.json({ inboxes: rows.map((row) => utcFields(row, 'created_at', 'expires_at')), page, pageSize, total });
});

inboxRoutes.get('/inbox/:id', (c) => {
  const id = c.req.param('id');
  const row = getInboxRow(c, id, 'id, provider, address, target_service, owner_key, created_at, expires_at, status');
  if (!row) return c.json({ error: 'Inbox not found' }, 404);
  return c.json(utcFields(row, 'created_at', 'expires_at'));
});

inboxRoutes.get('/inbox/:id/messages', async (c) => {
  const id = c.req.param('id');
  const row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName, address } = row;

  const provider = registry.get(providerName);
  if (!provider) return c.json({ error: `Provider '${providerName}' not available` }, 500);

  if (!provider.meta.features.pollInbox) {
    return c.json({
      error: 'This provider does not support inbox polling',
      address,
      provider: providerName,
    }, 400);
  }

  const inbox = rowToInboxData(row);
  try {
    const messages = await readProvider(providerName, () => provider.getMessages(inbox));
    const current = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
    if (!current) return c.json({ error: 'Inbox not found' }, 404);
    const own = messages.map(utcMessage).filter((m) => isMessageWithinInboxLifetime(m.receivedAt, current));
    // Only Outlook has one lease per mailbox, so its UI may link to the
    // account's history. Use the current row for that metadata too.
    const accountEmail = current.provider === PROVIDER.OUTLOOK
      ? (rowToInboxData(current).authData.email || stripPlusTag(current.address))
      : undefined;
    return c.json({ messages: own, status: current.status, address: current.address, provider: current.provider, accountEmail });
  } catch (e) {
    if (!getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS)) return c.json({ error: 'Inbox not found' }, 404);
    return readFailureResponse(c, e);
  }
});

inboxRoutes.get('/inbox/:id/messages/:mid', async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  const row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName } = row;
  const provider = registry.get(providerName);
  if (!provider) return c.json({ error: `Provider '${providerName}' not available` }, 500);

  try {
    const message = utcMessage(await readProvider(providerName, () => provider.getMessage(rowToInboxData(row), mid)));
    const current = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
    if (!current) return c.json({ error: 'Inbox not found' }, 404);
    // The id came from a listing we already filtered, but ids are guessable on
    // some providers and a shared mailbox would happily serve the previous
    // tenant's message. Re-check the boundary on the detail path too.
    if (!isMessageWithinInboxLifetime(message.receivedAt, current)) {
      return c.json({ error: 'Message not found' }, 404);
    }
    return c.json(message);
  } catch (e) {
    if (!getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS)) return c.json({ error: 'Inbox not found' }, 404);
    return readFailureResponse(c, e);
  }
});

inboxRoutes.get('/inbox/:id/code', async (c) => {
  const id = c.req.param('id');
  const wait = c.req.query('wait') === 'true';
  const selection = c.req.query('selection') ?? 'latest';
  if (selection !== 'latest' && selection !== 'matching') {
    return c.json({ error: 'Invalid selection parameter' }, 400);
  }
  const timeoutParam = c.req.query('timeout') ?? '60';
  const requestedTimeout = Number(timeoutParam);
  if (!/^\d+$/.test(timeoutParam) || !Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    return c.json({ error: 'Invalid timeout parameter' }, 400);
  }
  const timeout = Math.min(requestedTimeout, 120);
  const typeFilter = c.req.query('type');
  const excludedIds = c.req.queries('excludeMessageId') ?? [];
  if (excludedIds.length > 20 || excludedIds.some(value => value.length > 2048)
    || excludedIds.reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8'), 0) > 8192) {
    return c.json({ error: 'Invalid excludeMessageId parameter' }, 400);
  }
  const excluded = new Set(excludedIds);
  if (selection === 'matching' && typeFilter !== undefined && !['numeric', 'alphanumeric', 'link'].includes(typeFilter)) {
    return c.json({ error: 'Invalid type parameter' }, 400);
  }
  const sinceParam = c.req.query('since');
  let sinceTimestamp: number | undefined;
  if (sinceParam) {
    sinceTimestamp = /^\d+$/.test(sinceParam) ? Number(sinceParam) : parseTimestamp(sinceParam);
    if (!Number.isFinite(sinceTimestamp)) {
      return c.json({ error: 'Invalid since parameter' }, 400);
    }
  }

  let row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName } = row;
  if (selection === 'matching' && providerName !== PROVIDER.OUTLOOK) {
    return c.json({ error: 'Matching selection is only supported for Outlook' }, 400);
  }
  const provider = registry.get(providerName);
  if (!provider || !provider.meta.features.pollInbox) {
    return c.json({ error: 'Inbox polling not supported for this provider' }, 400);
  }

  function filterNew(msgs: Message[], current: InboxDataRow): Message[] {
    return msgs.filter(m => {
      if (excluded.has(m.id)) return false;
      if (!isMessageWithinInboxLifetime(m.receivedAt, current)) return false;
      if (sinceTimestamp === undefined) return true;
      // `since` is an explicit "strictly newer than" cursor from the caller, so
      // an undated message cannot satisfy it.
      if (!m.receivedAt) return false;
      const receivedAt = parseTimestamp(m.receivedAt);
      if (!Number.isFinite(receivedAt)) return false;
      return receivedAt > sinceTimestamp;
    });
  }

  function sortNewest(msgs: Message[]): Message[] {
    return msgs.slice().sort((a, b) => {
      const ta = a.receivedAt ? (parseTimestamp(a.receivedAt) || 0) : 0;
      const tb = b.receivedAt ? (parseTimestamp(b.receivedAt) || 0) : 0;
      return tb - ta;
    });
  }

  const deadline = Date.now() + timeout * 1000;
  if (selection === 'matching') {
    const initial = row;
    const accountEmail = rowToInboxData(initial).authData.email || stripPlusTag(initial.address);
    const alias = foldAsciiCase(initial.address) !== foldAsciiCase(accountEmail);
    const checkedIds = new Set<string>();
    let checked = 0;
    let complete = false;
    let scan: MailboxScanMeta | undefined = provider.scanMessages ? {
      scope: 'inbox_and_junk', pages: 0, metadata: 0, complete: false,
      truncated: true, partial: false, folders: [],
    } : undefined;
    const budget = { pages: 0, metadata: 0 };
    type ScanReason = 'matched' | 'window_exhausted' | 'scan_limit' | 'timeout';
    const metadata = (reason: ScanReason | 'error', windowComplete: boolean, interrupted = false) => ({
      ...scan, ...(scan ? { pages: budget.pages, metadata: budget.metadata, partial: interrupted || scan.partial } : {}),
      checked, complete: windowComplete, reason,
    });
    const empty = (reason: ScanReason, windowComplete = complete, interrupted = false) => c.json({
      codes: [], email: null, messageId: null, receivedAt: null,
      scan: metadata(reason, windowComplete, interrupted),
    });
    // A request is bound to its original owner/address/lease, even for an admin.
    // Provider credential freshness and To/Cc checks remain in the provider too.
    const checkpoint = () => {
      const current = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
      if (!current || current.owner_key !== initial.owner_key || current.provider !== initial.provider
        || current.address !== initial.address || current.auth_data !== initial.auth_data || current.created_at !== initial.created_at) {
        return { response: c.json({ error: 'Inbox not found' }, 404) };
      }
      const account = getRow<{ assigned_inbox_id: string | null }>(getDb(),
        'SELECT assigned_inbox_id FROM outlook_accounts WHERE email = ?', accountEmail);
      if (!isInboxPollingOpen(current) || account?.assigned_inbox_id !== id) {
        return { response: empty('window_exhausted', false, true) };
      }
      if (c.req.raw.signal.aborted || Date.now() >= deadline) return { response: empty('timeout', scan ? false : complete, true) };
      return { row: current };
    };
    const ownsRecipient = (message: Message, current: InboxDataRow) => !alias
      || !!message[MESSAGE_RECIPIENTS]?.some(address => foldAsciiCase(address) === foldAsciiCase(current.address));
    class ScanStopped extends Error {}
    const control: MailboxScanControl = {
      budget,
      progress(value) { scan = value; },
      checkpoint() { if (checkpoint().response) throw new ScanStopped(); },
      async run(operation) {
        control.checkpoint();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const result = await Promise.race([
            operation(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new ScanStopped()), Math.max(0, deadline - Date.now()));
              onAbort = () => reject(new ScanStopped());
              c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]);
          control.checkpoint();
          return result;
        } finally {
          if (timer) clearTimeout(timer);
          if (onAbort) c.req.raw.signal.removeEventListener('abort', onAbort);
        }
      },
      read(operation) { return control.run(() => readProvider(providerName, operation)); },
    };
    const startTime = Date.now();
    while (true) {
      let state = checkpoint();
      if (state.response) return state.response;
      // A new list can introduce candidates, so completeness is unknown until
      // this awaited read and all of its unvisited details have been checked.
      complete = false;
      let listed: Message[];
      try {
        if (provider.scanMessages) {
          const result = await provider.scanMessages(rowToInboxData(state.row!), control);
          listed = result.messages;
          scan = result.scan;
        } else listed = await control.read(() => provider.getMessages(rowToInboxData(state.row!)));
      } catch (error) {
        if (error && typeof error === 'object' && 'scan' in error) scan = error.scan as MailboxScanMeta;
        state = checkpoint();
        if (state.response) return state.response;
        if (error instanceof ScanStopped) return empty('timeout', false, true);
        return readFailureResponse(c, error, scan ? metadata('error', false, true) : undefined);
      }
      state = checkpoint();
      if (state.response) return state.response;
      const candidates = [...new Map(filterNew(listed, state.row!).filter(message => ownsRecipient(message, state.row!))
        .map(message => [message.id, message])).values()].sort((a, b) => {
        const timeOrder = (parseTimestamp(b.receivedAt) || 0) - (parseTimestamp(a.receivedAt) || 0);
        return timeOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      for (const candidate of candidates) {
        if (checkedIds.has(candidate.id)) continue;
        state = checkpoint();
        if (state.response) return state.response;
        if (checked >= 5) return empty('scan_limit', false);
        let detail: MessageDetail;
        checked++;
        try {
          detail = await control.read(() => provider.getMessage(rowToInboxData(state.row!), candidate.id, control));
        } catch (error) {
          state = checkpoint();
          if (state.response) return state.response;
          // A failed detail has not been checked successfully. Stop here rather
          // than extracting from its summary or hiding it with an older code.
          return readFailureResponse(c, error, scan ? metadata('error', false, true) : undefined);
        }
        state = checkpoint();
        if (state.response) return state.response;
        checkedIds.add(candidate.id);
        if (!filterNew([candidate, detail], state.row!).every(message => ownsRecipient(message, state.row!))
          || filterNew([candidate, detail], state.row!).length !== 2) continue;
        let codes = extractCodes({ subject: detail.subject, text: detail.text, html: detail.html });
        if (typeFilter) codes = codes.filter(code => code.type === typeFilter);
        if (codes.length) {
          state = checkpoint();
          if (state.response) return state.response;
          const recipientAddress = detail[MESSAGE_RECIPIENTS]?.some(address => foldAsciiCase(address) === foldAsciiCase(state.row!.address))
            ? state.row!.address : null;
          return c.json({
            codes,
            email: { from: detail.from, subject: detail.subject, recipientAddress },
            messageId: detail.id || candidate.id,
            receivedAt: toUtcIso(detail.receivedAt) || toUtcIso(candidate.receivedAt),
            scan: metadata('matched', candidates.every(message => checkedIds.has(message.id)) && (scan?.complete ?? true)),
          });
        }
      }
      complete = scan?.complete ?? true;
      state = checkpoint();
      if (state.response) return state.response;
      if (scan?.truncated || (scan && (budget.pages >= 5 || budget.metadata >= 100) && wait)) return empty('scan_limit', false);
      if (!wait) return empty('window_exhausted');
      const interval = Date.now() - startTime < 20000 ? 3000 : 5000;
      try { await control.run(() => new Promise(resolve => setTimeout(resolve, Math.min(interval, deadline - Date.now())))); }
      catch { const stopped = checkpoint(); return stopped.response ?? empty('timeout', false); }
      state = checkpoint();
      if (state.response) return state.response;
    }
  }
  let messages: Message[];
  try {
    const inbox = rowToInboxData(row);
    messages = await readProvider(providerName, () => provider.getMessages(inbox));
  } catch (e) {
    row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
    if (!row) return c.json({ error: 'Inbox not found' }, 404);
    if (c.req.raw.signal.aborted || !isInboxPollingOpen(row)) return emptyCodeResponse(c);
    return readFailureResponse(c, e);
  }

  row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
  if (!row) return c.json({ error: 'Inbox not found' }, 404);
  messages = sortNewest(filterNew(messages, row));

  let lastPollFailure: { error: unknown } | undefined;
  if (wait && messages.length === 0) {
    const startTime = Date.now();
    while (Date.now() < deadline) {
      row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
      if (!row) return c.json({ error: 'Inbox not found' }, 404);
      if (c.req.raw.signal.aborted || !isInboxPollingOpen(row)) return emptyCodeResponse(c);
      const elapsed = Date.now() - startTime;
      const interval = elapsed < 20000 ? 3000 : 5000;
      await new Promise((r) => setTimeout(r, interval));
      row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
      if (!row) return c.json({ error: 'Inbox not found' }, 404);
      if (c.req.raw.signal.aborted || !isInboxPollingOpen(row)) return emptyCodeResponse(c);
      if (Date.now() >= deadline) break;
      let polled: Message[] | undefined;
      try {
        const inbox = rowToInboxData(row);
        polled = await readProvider(providerName, () => provider.getMessages(inbox));
        lastPollFailure = undefined;
      } catch (error) {
        lastPollFailure = { error };
      }
      row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
      if (!row) return c.json({ error: 'Inbox not found' }, 404);
      // A waiting retry must stop as soon as its lease ends, even when it
      // returns historical mail. Bounded historical reads use the initial poll.
      if (c.req.raw.signal.aborted || !isInboxPollingOpen(row)) return emptyCodeResponse(c);
      if (lastPollFailure && (lastPollFailure.error instanceof PollRateLimitError || httpStatus(lastPollFailure.error, 0) === 429)) {
        return readFailureResponse(c, lastPollFailure.error);
      }
      if (polled) messages = sortNewest(filterNew(polled, row));
      if (messages.length > 0) break;
    }
  }

  if (c.req.raw.signal.aborted) return emptyCodeResponse(c);
  if (lastPollFailure) return readFailureResponse(c, lastPollFailure.error);
  if (messages.length === 0) return emptyCodeResponse(c);

  const latest = messages[0];
  let detail: MessageDetail;
  try {
    const inbox = rowToInboxData(row);
    detail = await readProvider(providerName, () => provider.getMessage(inbox, latest.id));
  } catch (error) {
    row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
    if (!row) return c.json({ error: 'Inbox not found' }, 404);
    if (c.req.raw.signal.aborted || !isMessageWithinInboxLifetime(latest.receivedAt, row)) return emptyCodeResponse(c);
    if (error instanceof MessageNotFoundError) return emptyCodeResponse(c);
    if (error instanceof PollRateLimitError || httpStatus(error, 0) === 429) return readFailureResponse(c, error);
    log.warn('failed to fetch message detail, using summary message', { inboxId: id, messageId: latest.id, error: error });
    detail = latest;
  }

  row = getInboxRow<InboxDataRow>(c, id, INBOX_READ_COLUMNS);
  if (!row) return c.json({ error: 'Inbox not found' }, 404);
  if (c.req.raw.signal.aborted) return emptyCodeResponse(c);
  if (!isMessageWithinInboxLifetime(latest.receivedAt, row) || !isMessageWithinInboxLifetime(detail.receivedAt, row)) {
    return emptyCodeResponse(c);
  }

  let codes = extractCodes({
    subject: detail.subject,
    text: detail.text,
    html: detail.html,
  });

  if (typeFilter) {
    codes = codes.filter((code) => code.type === typeFilter);
  }

  return c.json({
    codes,
    email: { from: detail.from, subject: detail.subject },
    messageId: detail.id || latest.id,
    receivedAt: toUtcIso(detail.receivedAt) || toUtcIso(latest.receivedAt),
  });
});

inboxRoutes.delete('/inbox/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const claimParams: QueryParam[] = [id];
  let claimSql = `
    UPDATE inboxes
    SET status = 'closed', closed_at = datetime('now')
    WHERE id = ? AND status != 'closed'
  `;
  if (!c.get('isAdmin')) {
    claimSql += ` AND owner_key = ?`;
    claimParams.push(c.get('apiKey'));
  }
  claimSql += ` RETURNING id, provider, address, auth_data, api_base`;

  const row = getRow<{ id: string; provider: string; address: string; auth_data: string; api_base: string | null }>(
    db,
    claimSql,
    ...claimParams,
  );
  if (!row) {
    const existing = getInboxRow<{ id: string }>(c, id, 'id');
    if (!existing) return c.json({ error: 'Inbox not found' }, 404);
    return c.json({ ok: true });
  }

  const inbox = parseStoredInbox(row);
  try {
    await releaseInboxResources(inbox, { deleteExternal: true });
  } catch (error) {
    log.warn('failed to release inbox resources on delete', { inboxId: id, provider: inbox.provider, error: error });
  }

  logActivity('amber', `Closed inbox ${inbox.address} (${inbox.provider})`);
  return c.json({ ok: true });
});

inboxRoutes.post('/inbox/:id/report', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const success: boolean = body.success ?? false;
  // Runtime guard: the type annotation is erased, and a non-string `service`
  // from an API client must not reach .trim() / SQL binding.
  const service: string | undefined = typeof body.service === 'string' ? body.service : undefined;

  const db = getDb();
  const row = getInboxRow<{ provider: string; address: string; target_service: string | null }>(c, id, 'provider, address, target_service');
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName, address, target_service: targetService } = row;
  // Trim to the same canonical form dispatch() stores, so fail_log, blocks,
  // used_services and service_stats all key off one name — an auto-block
  // inserted under a padded name would be invisible to the dispatcher lookup.
  const svc = service?.trim() || targetService || undefined;
  const domain = address.split('@')[1];

  // Opt-in: only a success records the service by default. used_services is a
  // permanent, irreversible blacklist for that account/service pair, so a
  // failure — which is often transient (rate limit, upstream hiccup) — must not
  // burn a paid account unless the operator explicitly turns this on.
  const shouldRecordService = success || getSetting('outlook_record_fail_service') === '1';

  if (svc && providerName === PROVIDER.OUTLOOK && shouldRecordService) {
    // used_services is keyed on the ACCOUNT email. An alias inbox's address is
    // `local+tag@domain`, which matches no account row — looking it up verbatim
    // would silently no-op and leave the anti-reuse blacklist unwritten. Read
    // the account identity from auth_data, falling back to the stripped address
    // for rows predating that field.
    const email = accountEmailForInbox(db, c, id, address);
    const account = getRow<{ used_services: string }>(db, `SELECT used_services FROM outlook_accounts WHERE email = ?`, email);
    if (account) {
      let used: string[] = [];
      try { used = JSON.parse(account.used_services) as string[]; } catch (error) {
        log.warn('failed to parse Outlook used_services', { email, error: error });
      }
      if (!used.includes(svc)) {
        used.push(svc);
        db.prepare(`UPDATE outlook_accounts SET used_services = ? WHERE email = ?`).run(JSON.stringify(used), email);
      }
    }
  }

  if (svc) bumpServiceReported(svc, success);

  if (success) {
    db.prepare(
      `INSERT INTO provider_stats (provider, success_count, last_success_at)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(provider) DO UPDATE SET
         success_count = success_count + 1,
         last_success_at = datetime('now')`
    ).run(providerName);

    logActivity('green', `Reported success ${address} (${providerName}${svc ? ', ' + svc : ''})`);
    return c.json({ ok: true, action: 'stats_updated' });
  }

  db.prepare(
    `INSERT INTO provider_stats (provider, fail_count, last_error_at, last_error)
     VALUES (?, 1, datetime('now'), ?)
     ON CONFLICT(provider) DO UPDATE SET
       fail_count = fail_count + 1,
       last_error_at = datetime('now'),
       last_error = ?`
  ).run(providerName, `failed for ${svc}`, `failed for ${svc}`);

  const blocked = checkAutoBlock(db, svc, providerName, domain);
  logActivity('rose', `Reported failure ${address} (${providerName}${svc ? ', ' + svc : ''})${blocked.length ? ' → triggered auto-block' : ''}`);
  return c.json({
    ok: true,
    action: blocked.length ? 'auto_blocked' : 'fail_recorded',
    ...(blocked.length ? { blocked } : {}),
  });
});
