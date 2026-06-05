import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import { dispatch, getDomainAtLevel } from '../dispatcher.js';
import { registry } from '../providers/registry.js';
import { rateLimiter } from '../rate-limiter.js';
import { extractCodes } from '../code-extractor.js';
import { allRows, getDb, getRow, getSetting, logActivity } from '../db.js';
import { parseStoredInbox, releaseInboxResources, rowToInboxData } from '../inbox-lifecycle.js';
import type { BaseProvider, InboxData, Message, MessageDetail } from '../providers/base.js';
import { PROVIDER } from '../providers/base.js';
import type { AdminEnv } from './admin.js';
import { createLogger } from '../logger.js';
import { errorMessage, httpStatus } from '../errors.js';

const log = createLogger('inbox-route');

type AppContext = Context<AdminEnv>;
type QueryParam = string | number | null;

interface InboxDataRow {
  provider: string;
  address: string;
  auth_data: string;
  api_base: string | null;
  status?: string;
  created_at?: string;
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
        log.warn('failed to insert auto-block record', { service: svcToBlock, domain: normDomain, provider, error: errorMessage(error) });
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

async function pollProvider(providerName: string, provider: BaseProvider, inbox: InboxData): Promise<Message[]> {
  if (!rateLimiter.isPollAvailable(providerName)) {
    throw new PollRateLimitError(providerName, rateLimiter.getPollStatus(providerName).nextAvailableAt);
  }
  rateLimiter.recordPoll(providerName);
  return provider.getMessages(inbox);
}

function pollRateLimitResponse(c: AppContext, e: PollRateLimitError) {
  return c.json({
    error: e.message,
    provider: e.providerName,
    retryAfter: e.retryAfter,
  }, 429);
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
      username: body.username,
      duration: body.duration,
      needPolling: body.needPolling,
      ownerKey: c.get('apiKey'),
    });
    logActivity('green', `Created inbox ${result.address} (${result.provider}${body.for ? ', ' + body.for : ''})`);
    return c.json(result, 201);
  } catch (e) {
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

  return c.json({ inboxes: rows, page, pageSize, total });
});

inboxRoutes.get('/inbox/:id', (c) => {
  const id = c.req.param('id');
  const row = getInboxRow(c, id, 'id, provider, address, target_service, owner_key, created_at, expires_at, status');
  if (!row) return c.json({ error: 'Inbox not found' }, 404);
  return c.json(row);
});

inboxRoutes.get('/inbox/:id/messages', async (c) => {
  const id = c.req.param('id');
  const row = getInboxRow<InboxDataRow>(c, id, 'provider, address, auth_data, api_base, status');
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName, address, status } = row;

  const provider = registry.get(providerName);
  if (!provider) return c.json({ error: `Provider '${providerName}' not available` }, 500);

  if (!provider.meta.features.pollInbox) {
    return c.json({
      error: 'This provider does not support inbox polling',
      address,
      provider: providerName,
    }, 400);
  }

  try {
    const messages = await pollProvider(providerName, provider, rowToInboxData(row));
    return c.json({ messages, status, address, provider: providerName });
  } catch (e) {
    if (e instanceof PollRateLimitError) return pollRateLimitResponse(c, e);
    return c.json({ error: errorMessage(e) }, 502);
  }
});

inboxRoutes.get('/inbox/:id/messages/:mid', async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  const row = getInboxRow<InboxDataRow>(c, id, 'provider, address, auth_data, api_base');
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName } = row;
  const provider = registry.get(providerName);
  if (!provider) return c.json({ error: `Provider '${providerName}' not available` }, 500);

  try {
    const message = await provider.getMessage(rowToInboxData(row), mid);
    return c.json(message);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

inboxRoutes.get('/inbox/:id/code', async (c) => {
  const id = c.req.param('id');
  const wait = c.req.query('wait') === 'true';
  const timeout = Math.min(parseInt(c.req.query('timeout') || '60', 10), 120);
  const typeFilter = c.req.query('type');
  const sinceParam = c.req.query('since');
  let sinceTimestamp: number | undefined;
  if (sinceParam) {
    sinceTimestamp = /^\d+$/.test(sinceParam) ? Number(sinceParam) : Date.parse(sinceParam);
    if (!Number.isFinite(sinceTimestamp)) {
      return c.json({ error: 'Invalid since parameter' }, 400);
    }
  }

  const row = getInboxRow<InboxDataRow>(c, id, 'provider, address, auth_data, api_base, created_at');
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName, created_at: createdAt } = row;
  const provider = registry.get(providerName);
  if (!provider || !provider.meta.features.pollInbox) {
    return c.json({ error: 'Inbox polling not supported for this provider' }, 400);
  }

  const inboxCreatedAt = createdAt ? new Date(createdAt).getTime() : 0;

  const inbox = rowToInboxData(row);

  function filterNew(msgs: Message[]): Message[] {
    return msgs.filter(m => {
      if (!m.receivedAt) return sinceTimestamp === undefined;
      const receivedAt = new Date(m.receivedAt).getTime();
      if (!Number.isFinite(receivedAt)) return false;
      if (inboxCreatedAt && receivedAt < inboxCreatedAt - 60000) return false;
      if (sinceTimestamp !== undefined && receivedAt <= sinceTimestamp) return false;
      return true;
    });
  }

  function sortNewest(msgs: Message[]): Message[] {
    return msgs.slice().sort((a, b) => {
      const ta = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const tb = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return tb - ta;
    });
  }

  const deadline = Date.now() + timeout * 1000;
  let messages: Message[];
  try {
    messages = sortNewest(filterNew(await pollProvider(providerName, provider, inbox)));

    if (wait && messages.length === 0) {
      const startTime = Date.now();
      while (Date.now() < deadline) {
        if (c.req.raw.signal.aborted) break;
        const elapsed = Date.now() - startTime;
        const interval = elapsed < 20000 ? 3000 : 5000;
        await new Promise((r) => setTimeout(r, interval));
        if (c.req.raw.signal.aborted) break;
        try { messages = sortNewest(filterNew(await pollProvider(providerName, provider, inbox))); } catch { /* retry next cycle */ }
        if (messages.length > 0) break;
      }
    }
  } catch (e) {
    if (e instanceof PollRateLimitError) return pollRateLimitResponse(c, e);
    return c.json({ error: errorMessage(e) }, 502);
  }

  if (messages.length === 0) {
    return c.json({ codes: [], email: null, messageId: null, receivedAt: null });
  }

  const latest = messages[0];
  let detail: MessageDetail;
  try {
    detail = await provider.getMessage(inbox, latest.id);
  } catch (error) {
    log.warn('failed to fetch message detail, using summary message', { inboxId: id, messageId: latest.id, error: errorMessage(error) });
    detail = latest;
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
    receivedAt: detail.receivedAt || latest.receivedAt || null,
  });
});

inboxRoutes.delete('/inbox/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const claimParams: QueryParam[] = [id];
  let claimSql = `
    UPDATE inboxes
    SET status = 'closed'
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
  const provider = registry.get(inbox.provider);

  if (provider?.deleteInbox) {
    try {
      await releaseInboxResources(inbox, { deleteExternal: true });
    } catch (error) {
      log.warn('failed to release inbox resources on delete', { inboxId: id, provider: inbox.provider, error: errorMessage(error) });
    }
  } else {
    await releaseInboxResources(inbox, { deleteExternal: false });
  }

  logActivity('amber', `Closed inbox ${inbox.address} (${inbox.provider})`);
  return c.json({ ok: true });
});

inboxRoutes.post('/inbox/:id/report', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const success: boolean = body.success ?? false;
  const service: string | undefined = body.service;

  const db = getDb();
  const row = getInboxRow<{ provider: string; address: string; target_service: string | null }>(c, id, 'provider, address, target_service');
  if (!row) {
    return c.json({ error: 'Inbox not found' }, 404);
  }

  const { provider: providerName, address, target_service: targetService } = row;
  const svc = service || targetService || undefined;
  const domain = address.split('@')[1];

  const shouldRecordService = success || getSetting('outlook_record_fail_service') === '1';

  if (svc && providerName === PROVIDER.OUTLOOK && shouldRecordService) {
    const email = address;
    const account = getRow<{ used_services: string }>(db, `SELECT used_services FROM outlook_accounts WHERE email = ?`, email);
    if (account) {
      let used: string[] = [];
      try { used = JSON.parse(account.used_services) as string[]; } catch (error) {
        log.warn('failed to parse Outlook used_services', { email, error: errorMessage(error) });
      }
      if (!used.includes(svc)) {
        used.push(svc);
        db.prepare(`UPDATE outlook_accounts SET used_services = ? WHERE email = ?`).run(JSON.stringify(used), email);
      }
    }
  }

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
