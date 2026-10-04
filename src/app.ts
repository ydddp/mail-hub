import { toUtcIso } from './time.js';
import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { inboxRoutes } from './routes/inbox.js';
import { blockRoutes } from './routes/blocks.js';
import { providerRoutes } from './routes/providers.js';
import { outlookRoutes } from './routes/outlook.js';
import { keyRoutes } from './routes/keys.js';
import { yydsRoutes } from './routes/yyds.js';
import { imapRoutes } from './routes/imap.js';
import { icloudRoutes } from './routes/icloud.js';
import { serviceRoutes } from './routes/services.js';
import { templateProviderRoutes } from './routes/template-providers.js';
import { allRows, DEFAULT_SETTINGS, getDb, getRow, getSetting, logActivity } from './db.js';
import { hashApiKey, secureCompare } from './crypto.js';
import { requireAdmin, type AdminEnv } from './routes/admin.js';
import { parseStoredInbox, releaseInboxResources } from './inbox-lifecycle.js';
import { checkToken } from './providers/outlook.js';
import { reapOrphanedAddresses } from './providers/icloud.js';
import { createLogger } from './logger.js';
import { settingsRoutes } from './routes/settings.js';
import { runConcurrent, todayDateString } from './utils.js';
import { APP_VERSION } from './version.js';
import { errorMessage, httpStatus, jsonStatus } from './errors.js';
import { requestLogger } from './request-logger.js';

const log = createLogger('cleanup');

// Real non-import bodies top out at a few KB (an iCloud cookie blob is ~3 KB, a
// template provider config ~1.4 KB); 1 MiB still fits bulk delete/check lists
// of tens of thousands of selected accounts.
export const REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
// Account imports are pasted as a single request. A real Outlook line with its
// refresh token is ~520 bytes, so this is roughly 30k accounts per paste.
export const IMPORT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const IMPORT_PATHS = new Set(['/api/outlook/import', '/api/yyds/import']);

// Counts the bytes actually received and stops pulling the moment the body
// passes `limit`, resolving null; nothing past the limit is ever buffered.
async function readBodyWithinLimit(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let cleanupRunning = false;
let extRoutes: Hono<AdminEnv> | undefined;
let cachedIndexHtml = '';
let cachedExtensionsJs = '';

function preloadFiles(): void {
  cachedIndexHtml = readFileSync(resolve(__dirname, 'public/index.html'), 'utf-8');
  try {
    cachedExtensionsJs = readFileSync(resolve(__dirname, 'public/extensions.js'), 'utf-8');
  } catch {
    // extensions.js not present — optional
  }
}

try {
  const extModule = await import('./routes/extensions.js');
  extRoutes = extModule.extRoutes;
} catch {
  // extensions module not present — optional
}

const LLMS_TXT = `# Mail Hub — Temporary Email Aggregation API
> Version: 0.9 | Base URL: https://mail.paramess.com

Mail Hub is a multi-provider temporary/disposable email aggregation service.
It creates inboxes from multiple email providers, polls for incoming messages,
and extracts verification codes — all through a unified REST API.

All API time-point fields use UTC ISO datetimes with milliseconds and Z.
Daily quotas use UTC days (reset at 00:00 UTC); the SPA displays browser-local time.

## Authentication

All /api/* endpoints require a Bearer token in the Authorization header:
  Authorization: Bearer <your-api-key>

## ⚠️ CRITICAL: Two Mandatory Requirements ⚠️

### 1. Always provide the target service domain ("for")
When creating an inbox, you MUST include the "for" field with the target
service's domain name (e.g. "twitter.com", "discord.com"). This is essential
for statistics, management, smart routing, and avoiding blocked domains.
Do NOT omit this field.

### 2. Always report results after use
After you finish using an inbox (whether the email arrived successfully or not),
you MUST call POST /api/inbox/:id/report to report the outcome. This is NOT
optional. The reporting mechanism is the backbone of service quality:

  - It tracks provider reliability (success/failure statistics)
  - It helps the operator identify unreliable providers and domains
  - It prevents Outlook pool accounts from being reused for the same service

Failing to report results degrades the service for everyone. ALWAYS report.

## Typical Workflow

1. POST   /api/inbox              → Create a temporary inbox
2. GET    /api/inbox/:id/code     → Wait for & extract verification code (recommended)
   — OR —
   GET    /api/inbox/:id/messages → Poll for raw messages
3. POST   /api/inbox/:id/report   → ⚠️ REPORT the result (MANDATORY!)
4. DELETE /api/inbox/:id          → Close the inbox when done

## Endpoints

### POST /api/inbox
Create a new temporary inbox.

Request body (JSON):
  {
    "for": "twitter.com",      // ⚠️ REQUIRED — target service domain for routing & statistics
    "provider": "mailtm",      // (optional) force a specific provider
    "domain": "example.com",   // (optional) request a specific email domain
    "subdomain": "team-a",    // (optional) wildcard child domain prefix (YYDS provider only)
    "account": "me@icloud.com", // (optional) which pooled account to draw from (iCloud provider only)
    "alias": true,             // (optional) ask for a sub-address — see "Aliases" below
    "duration": 600,           // (optional) desired lifetime in seconds
    "needPolling": true        // (optional, default true) whether inbox must support polling
  }

Response 201:
  {
    "id": "abc123",
    "address": "random@tmpmail.org",
    "provider": "mailtm",
    "expiresAt": "2025-01-01T01:00:00Z",  // always set; defaults to 24h when neither provider nor "duration" specify one
    "features": { "pollInbox": true, "attachments": false, ... }
  }

⚠️ The "for" field MUST be the target service's domain name (e.g. "twitter.com",
"discord.com", "steam.com"). It is used for:
  - Avoiding domains already blocked by that service
  - Preventing Outlook accounts from being reused for the same service
    (unless "alias" is set — see below)
  - Statistics and management tracking by the service operator
Do NOT omit this field. The service operator requires it for management purposes.

#### Aliases ("alias": true)

Asks for a sub-address instead of the plain one. The tag is generated
server-side — do NOT try to supply it. Only providers advertising
"features.alias" honour it (currently Outlook, which returns
account+tag@outlook.com); others ignore it silently, so with auto-dispatch you
may still receive a plain address. Always read "address" from the response.

Normally one Outlook account is handed to a given "for" service only once.
An aliased request bypasses that limit, so the same account can register at the
same service repeatedly, each time with a fresh address. Two things to know:

  - Many signup forms reject addresses containing "+". This is why the flag is
    opt-in per request rather than always on — use it only for services you
    know accept sub-addressing.
  - An alias is a different address, NOT extra capacity: the inbox still holds
    one pooled account, so repeat registrations are sequential. Close the
    current inbox before creating the next one.

### GET /api/inboxes
List your inboxes.

Query parameters:
  ?status=active|closed   — filter by status
  ?provider=mailtm        — filter by provider
  ?for=twitter            — filter by target service

Response 200:
  { "inboxes": [ { "id", "provider", "address", "target_service", "created_at", "expires_at", "status" }, ... ] }

### GET /api/inbox/:id/messages
Poll the inbox for messages.

Response 200:
  { "messages": [ { "id", "from", "subject", "excerpt", "receivedAt" }, ... ] }

### GET /api/inbox/:id/messages/:mid
Get full message content.

Response 200:
  { "id", "from", "subject", "excerpt", "receivedAt", "text": "...", "html": "..." }

### GET /api/inbox/:id/code
Extract verification codes from the latest email. Supports long-polling.

Query parameters:
  ?wait=true       — long-poll until a message arrives (recommended)
  ?timeout=60      — max wait time in seconds (default 60, max 120)
  ?type=numeric    — filter code type (numeric, alphanumeric, link)
  ?since=ISO_TIME  — only consider messages received after this timestamp

Response 200:
  {
    "codes": [
      { "code": "123456", "type": "numeric", "source": "body", "context": "verification code" }
    ],
    "email": { "from": "noreply@service.com", "subject": "Your code" },
    "messageId": "message-123",
    "receivedAt": "2025-01-01T00:01:00Z"
  }

This is the recommended endpoint for most use cases — it handles polling,
message retrieval, and code extraction in a single call. For repeated retrieval,
pass the previous response "receivedAt" as "since" to avoid returning the same message again.

### POST /api/inbox/:id/report
⚠️ MANDATORY — Report the outcome of using this inbox.

Request body (JSON):
  {
    "success": true,           // whether the email was received and usable
    "service": "twitter.com"   // target service domain — include if not set via "for" at creation
  }

Response 200:
  { "ok": true, "action": "stats_updated" }     // on success=true
  { "ok": true, "action": "fail_recorded" }      // on success=false, no auto-block triggered
  { "ok": true, "action": "auto_blocked", "blocked": [ { "service": "twitter.com", "domain": "tmpmail.org", "rule": 1 } ] }
    // on success=false, auto-block rule triggered (domain banned for that service)

YOU MUST CALL THIS ENDPOINT. Every inbox usage MUST end with a report.
  - success=true  → provider gets a success point, Outlook account records this service
  - success=false → failure logged; if configurable auto-block rules are met, the domain
    is automatically banned for the service (e.g. 3 failures in 24 hours)
  - "service" should be the same domain you passed as "for" when creating the inbox

### DELETE /api/inbox/:id
Close and release the inbox.

Response 200:
  { "ok": true }

### GET /api/providers
List available email providers and their capabilities.

Response 200:
  {
    "providers": [
      {
        "name": "mailtm",
        "displayName": "Mail.tm",
        "type": "api",
        "tier": "free",
        "trustLevel": 3,
        "features": { "customUsername": true, "pollInbox": true, "realtime": false, "attachments": true },
        "rateStatus": { ... }
      },
      ...
    ]
  }

## Error Responses

All errors follow this format:
  { "error": "Human-readable error message" }

Common HTTP status codes:
  401 — Missing or invalid Bearer token
  404 — Inbox not found
  410 — Inbox already closed
  413 — Request body too large (1 MiB; 16 MiB for admin account imports)
  429 — Rate limit exceeded (includes retryAfter)
  502 — Upstream provider error
  503 — All providers exhausted

## Provider Notes

Mail Hub aggregates multiple upstream email providers. The dispatcher selects
the best available provider automatically. Two providers use pool-based resources:

Paid providers (tier "paid") have auto-dispatch disabled by default — they are
only used when explicitly requested via the "provider" field in POST /api/inbox.
The operator can enable auto-dispatch for any provider through the admin panel.

### Outlook
Uses a pool of pre-imported Microsoft accounts (1:1 assignment per inbox).
Accounts are returned to the pool when the inbox is closed.
Auto-dispatch: off by default (paid). Use provider: "outlook" to request explicitly.

### iCloud / Hide My Email

Mints @icloud.com addresses through iCloud+ Hide My Email, so the Apple ID must
have an iCloud+ subscription. An admin configures the Apple ID and authenticates
Hide My Email with either a pasted iCloud cookie blob or the SRP sign-in flow.
The account also needs IMAP credentials, including the app-specific password,
for the mailbox Hide My Email forwards to.

Mail Hub reads mail over IMAP from the operator's own forwarding mailbox and
sorts the shared mailbox by exact recipient. Each inbox therefore sees only
messages addressed to its assigned alias.

Inbox creation claims an address from a pre-minted pool, and a background task
tops the pool up. Addresses return to the pool when an inbox is closed: each
Apple ID has a lifetime cap of 750 Hide My Email addresses, so aliases are
recycled rather than burned. Retiring an address deactivates it at Apple and is
irreversible; use it only for an address that must never be issued again.

When multiple Apple IDs are configured, use the optional "account" field
documented under POST /api/inbox to choose which account's pool to draw from.
Omit it to draw from any usable account.

Auto-dispatch: off by default (paid). Use provider: "icloud" to request explicitly.

#### iCloud Pool Management (admin only)

GET    /api/icloud/accounts                         — List accounts (secrets excluded)
POST   /api/icloud/accounts                         — Add an account with pasted cookies and forwarding-mailbox IMAP credentials
DELETE /api/icloud/accounts/:id                     — Remove an account
POST   /api/icloud/accounts/:id/test                — Test Hide My Email and IMAP access
POST   /api/icloud/accounts/:id/cookies             — Replace an expired pasted cookie blob
POST   /api/icloud/accounts/:id/srp/begin           — Begin or renew an SRP sign-in (body: { "password": "..." })
GET    /api/icloud/srp/:sessionId/phones            — List trusted phones for SMS verification
POST   /api/icloud/srp/:sessionId/sms               — Send an SMS code (body: { "phoneId": 1 })
POST   /api/icloud/accounts/:id/srp/complete        — Complete SRP sign-in (body: { "sessionId": "...", "code": "123456" })
GET    /api/icloud/addresses                        — List the pre-minted address pool
POST   /api/icloud/accounts/:id/generate            — Mint addresses now (body: { "count": 1 }, maximum 5)
POST   /api/icloud/addresses/:hme/retire            — Irreversibly deactivate and retire an address
GET    /api/icloud/addresses/:hme/messages          — Read mail for one address
GET    /api/icloud/addresses/:hme/messages/:uid     — Read one message for that address

### YYDS Mail
Uses a pool of API keys to call the YYDS Mail upstream API.
Supports both fixed domains and wildcard subdomains (pass "subdomain" field).
Each key has a daily quota of 20,000 API calls, managed automatically.
Upstream API documentation: https://maliapi.215.im/v1/llms.txt

#### YYDS-specific inbox creation

To create an inbox via YYDS with a wildcard subdomain:
  POST /api/inbox
  {
    "provider": "yyds",
    "for": "twitter.com",
    "domain": "example.com",
    "subdomain": "team-a"
  }
  → address: "randomuser@team-a.example.com"

If "subdomain" is omitted, a fixed domain address is created.
If "provider" is omitted, the dispatcher may still select YYDS automatically
(it is a free-tier provider and participates in auto-dispatch by default).

#### YYDS Pool Management (admin only)

GET    /api/yyds/stats                  — Pool statistics (total, active, invalid keys)
POST   /api/yyds/import                 — Import API keys (body: { "accounts": "KEY1----name1\\nKEY2----name2" })
GET    /api/yyds/accounts               — List all keys with status, wildcard support, daily usage
DELETE /api/yyds/accounts               — Delete keys (body: { "keys": ["KEY1", "KEY2"] })
POST   /api/yyds/check                  — Validate keys against upstream (body: { "keys": [...] } or empty for all)
PATCH  /api/yyds/accounts/wildcard      — Set wildcard support (body: { "keys": [...], "wildcard": true })

### IMAP / Custom Domain Email

Connect your own domain email via IMAP. One IMAP account with catch-all
enabled serves as a pool resource — the dispatcher invents an address
under your domain for each inbox and sorts the shared mailbox by
recipient, so one mailbox backs many concurrent inboxes.

Generated local parts are name-shaped rather than a random string
(nathanlambert, lisa.chen, d_watson91, vera.oconnell8); pass "username"
to choose your own. Addresses in use by a live inbox are never reissued.

Prerequisites (done outside Mail Hub):
  - A domain with catch-all email enabled
  - IMAP credentials for that mailbox

Usage:
  POST /api/inbox { "provider": "imap", "for": "twitter.com", "domain": "mydomain.com" }
  → address: "juliahoffman@mydomain.com"

The "domain" field is optional — if omitted, a random configured domain is picked.
Auto-dispatch: on by default (free). IMAP is scored with high trust (trustLevel=10)
since it's the user's own infrastructure.

#### IMAP Pool Management (admin only)

GET    /api/imap/stats                  — Pool statistics (total, active)
GET    /api/imap/accounts               — List all accounts (password excluded)
POST   /api/imap/accounts               — Add an IMAP account
       Body: { "host", "port", "user", "password", "domain", "tls" }
GET    /api/imap/accounts/:id           — Get account details
PUT    /api/imap/accounts/:id           — Update account fields
DELETE /api/imap/accounts/:id           — Remove an account
POST   /api/imap/accounts/:id/test      — Test IMAP connection

## Best Practices

1. ALWAYS provide "for" with the target service domain — this is REQUIRED for statistics
2. Prefer GET /api/inbox/:id/code?wait=true over manual polling
3. ALWAYS call POST /api/inbox/:id/report — this is the single most important step
4. DELETE the inbox when you're done to free pool resources
5. Handle 429 by waiting and retrying — the system manages per-provider rate limits automatically
6. Use full domain names for "for" and "service" fields (e.g. "twitter.com", not "twitter")
7. For IMAP: ensure catch-all is enabled and the IMAP account is active
   before relying on it for inbox creation
`;

export function createApp(): Hono<AdminEnv> {
  preloadFiles();
  const app = new Hono<AdminEnv>();
  app.use('*', requestLogger());

  app.onError((err, c) => {
    const status = httpStatus(err);
    if (status !== 500) return c.json({ error: err.message }, jsonStatus(status));
    log.error('unhandled error', { path: c.req.path, error: err.message });
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  const startedAt = new Date().toISOString();

  app.get('/health', (c) => {
    let dbOk = false;
    try {
      dbOk = getDb().open;
    } catch (e) {
      log.error('health check DB error', { error: (e as Error)?.message });
    }
    const status = dbOk ? 'ok' : 'degraded';
    return c.json({
      status,
      version: APP_VERSION,
      startedAt,
      uptime: Math.floor(process.uptime()),
      db: dbOk ? 'connected' : 'error',
    }, dbOk ? 200 : 503);
  });

  app.get('/v1/llms.txt', (c) => {
    const proto = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('x-forwarded-host') || c.req.header('host') || 'localhost';
    const baseUrl = `${proto}://${host}`;
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.text(LLMS_TXT.replace('https://mail.paramess.com', baseUrl).replace('Version: 0.9', `Version: ${APP_VERSION}`));
  });

  // Authentication must stay the first /api/* middleware to touch the request
  // body: anything reading it earlier lets anonymous callers make us buffer it.
  app.use('/api/*', async (c, next) => {
    // Microsoft redirects here with a GET (response_mode=query); no other
    // method on this path needs to bypass auth.
    if (c.req.method === 'GET' && c.req.path === '/api/outlook/oauth/callback') {
      c.set('isAdmin', false);
      c.set('apiKey', '');
      return next();
    }
    if (!config.apiSecret) {
      c.set('isAdmin', true);
      c.set('apiKey', '');
      return next();
    }
    const auth = c.req.header('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return c.json({ error: 'Unauthorized' }, 401);

    if (secureCompare(token, config.apiSecret)) {
      c.set('isAdmin', true);
      c.set('apiKey', token);
      return next();
    }

    try {
      const db = getDb();
      const keyHash = hashApiKey(token);
      const today = todayDateString();
      const consumed = getRow<{ key: string }>(db, `
        UPDATE api_keys
        SET
          call_count = call_count + 1,
          daily_calls = CASE
            WHEN daily_reset_at LIKE ? THEN daily_calls + 1
            ELSE 1
          END,
          daily_reset_at = ?,
          last_used_at = datetime('now')
        WHERE key = ?
          AND active = 1
          AND (
            daily_limit IS NULL
            OR (CASE WHEN daily_reset_at LIKE ? THEN daily_calls ELSE 0 END) < daily_limit
          )
        RETURNING key
      `, `${today}%`, today, keyHash, `${today}%`);
      if (consumed) {
        c.set('isAdmin', false);
        c.set('apiKey', keyHash);
        return next();
      }

      const existing = getRow<{ daily_limit: number | null }>(
        db,
        `SELECT daily_limit FROM api_keys WHERE key = ? AND active = 1`,
        keyHash,
      );
      if (existing) {
        if (existing.daily_limit !== null) {
          return c.json({ error: 'Daily quota exceeded' }, 429);
        }
        createLogger('auth').error('failed to consume unlimited API key quota', { key: keyHash });
      }
    } catch (e) {
      createLogger('auth').error('auth middleware error', { error: errorMessage(e) });
    }

    return c.json({ error: 'Unauthorized' }, 401);
  });

  // Buffers every /api/* body up front, so route handlers only ever parse bytes
  // that fit the limit, whatever the method or Content-Type.
  app.use('/api/*', async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();
    const limit = c.get('isAdmin') && IMPORT_PATHS.has(c.req.path) ? IMPORT_BODY_LIMIT_BYTES : REQUEST_BODY_LIMIT_BYTES;
    // Content-Length only lets an oversized upload fail fast. It can be absent
    // (chunked) or wrong, so the byte count is what enforces the limit.
    const declared = Number(c.req.header('content-length'));
    const bytes = declared > limit ? null : await readBodyWithinLimit(body, limit);
    if (!bytes) return c.json({ error: `Request body exceeds the ${limit}-byte limit` }, 413);
    c.req.raw = new Request(c.req.raw, { body: bytes });
    return next();
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
      const ct = c.req.header('content-type') || '';
      if (ct.includes('json')) {
        const raw = await c.req.text();
        if (raw.length > 0) {
          try {
            const body = JSON.parse(raw);
            if (typeof body !== 'object' || body === null) {
              return c.json({ error: 'Request body must be a JSON object' }, 400);
            }
          } catch (error) {
            createLogger('request').warn('invalid JSON request body', { path: c.req.path, error: errorMessage(error) });
            return c.json({ error: 'Invalid JSON in request body' }, 400);
          }
        }
      }
    }
    return next();
  });

  app.get('/', (c) => {
    return c.html(cachedIndexHtml);
  });

  app.get('/extensions.js', (c) => {
    if (!cachedExtensionsJs) return c.notFound();
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    return c.body(cachedExtensionsJs);
  });

  app.route('/api', inboxRoutes);
  app.route('/api', blockRoutes);
  app.route('/api', providerRoutes);
  app.route('/api', outlookRoutes);
  if (extRoutes) app.route('/api/outlook', extRoutes);
  app.route('/api', keyRoutes);
  app.route('/api', yydsRoutes);
  app.route('/api', imapRoutes);
  app.route('/api', icloudRoutes);
  app.route('/api', serviceRoutes);
  app.route('/api', templateProviderRoutes);
  app.route('/api', settingsRoutes);

  app.get('/api/activity', requireAdmin, (c) => {
    const db = getDb();
    const rows = allRows<{ type: string; text: string; created_at: string }>(
      db,
      `SELECT type, text, created_at FROM activity_log ORDER BY created_at DESC LIMIT 20`,
    );
    const activities = rows.map((r) => ({ type: r.type, text: r.text, time: toUtcIso(r.created_at) }));
    return c.json({ activities });
  });

  return app;
}

export async function cleanupExpired(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const db = getDb();
    const retentionInboxDays = Math.max(1, parseInt(getSetting('retention_inbox_days', DEFAULT_SETTINGS.retention_inbox_days), 10) || 7);
    const retentionFailLogDays = Math.max(1, parseInt(getSetting('retention_faillog_days', DEFAULT_SETTINGS.retention_faillog_days), 10) || 7);
    const retentionActivityDays = Math.max(1, parseInt(getSetting('retention_activity_days', DEFAULT_SETTINGS.retention_activity_days), 10) || 30);

    // 1. Close expired inboxes and release their pool resources immediately,
    //    so Outlook accounts / YYDS slots return to the pool at expiry time
    //    instead of waiting for the purge a day later.
    const expired = allRows<{ id: string; provider: string; address: string; auth_data: string; api_base: string | null }>(db, `
      SELECT id, provider, address, auth_data, api_base
      FROM inboxes
      WHERE status = 'active' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')
    `);
    if (expired.length > 0) {
      const close = db.prepare(`UPDATE inboxes SET status = 'closed', closed_at = datetime('now') WHERE id = ?`);
      for (const row of expired) close.run(row.id);
      for (const row of expired) {
        try {
          await releaseInboxResources(parseStoredInbox(row), { deleteExternal: false });
        } catch (e) {
          log.error('failed to release inbox resources', { inboxId: row.id, error: errorMessage(e) });
        }
      }
      log.info('closed expired inboxes', { count: expired.length });
    }

    // 2. Purge old closed inboxes. Releasing again is near-idempotent (YYDS
    //    inbox_count may double-decrement, it is display-only and floored at 0)
    //    and catches rows closed before release-at-expiry existed.
    const rows = allRows<{ id: string; provider: string; address: string; auth_data: string; api_base: string | null }>(db, `
      SELECT id, provider, address, auth_data, api_base
      FROM inboxes
      WHERE status = 'closed'
        AND (
          (expires_at IS NOT NULL AND datetime(expires_at) < datetime('now', '-1 day'))
          OR (expires_at IS NULL AND datetime(created_at) < datetime('now', ?))
        )
    `, `-${retentionInboxDays} days`);

    for (const row of rows) {
      try {
        await releaseInboxResources(parseStoredInbox(row), { deleteExternal: false });
      } catch (e) {
        log.error('failed to release inbox resources', { error: errorMessage(e) });
      }
    }

    if (rows.length > 0) {
      for (const row of rows) {
        db.prepare(`DELETE FROM inboxes WHERE id = ?`).run(row.id);
      }
      log.info('purged expired inboxes', { count: rows.length });
    }

    // 3. Retention purges run before any network-dependent work so an upstream
    //    outage can never starve them.
    db.prepare(`DELETE FROM fail_log WHERE datetime(reported_at) < datetime('now', ?)`).run(`-${retentionFailLogDays} days`);
    db.prepare(`DELETE FROM activity_log WHERE datetime(created_at) < datetime('now', ?)`).run(`-${retentionActivityDays} days`);
    // SRP sessions live five minutes; a day of grace keeps failures readable
    // for post-mortem, after which the rows are pure accumulation.
    db.prepare(`DELETE FROM icloud_auth_sessions WHERE datetime(expires_at) < datetime('now', '-1 day')`).run();

    // 4. Free Outlook accounts whose assigned inbox no longer exists (process
    //    crashed between pool claim and inbox insert, or row purged abnormally).
    //    The age floor spares an account claimed moments ago whose inbox row is
    //    about to be written — reaping inside that window hands one account to
    //    two inboxes. NULL assigned_at is a pre-migration claim of unknowable
    //    age, which reaps as before.
    const reaped = db.prepare(
      `UPDATE outlook_accounts SET assigned_inbox_id = NULL, assigned_at = NULL
       WHERE assigned_inbox_id IS NOT NULL
         AND assigned_inbox_id NOT IN (SELECT id FROM inboxes)
         AND (assigned_at IS NULL OR datetime(assigned_at) < datetime('now', '-10 minutes'))`,
    ).run();
    if (reaped.changes > 0) {
      log.info('released orphaned Outlook assignments', { count: reaped.changes });
    }

    const reapedIcloud = reapOrphanedAddresses();
    if (reapedIcloud > 0) {
      log.info('released orphaned iCloud addresses', { count: reapedIcloud });
    }

    // 5. Daily Outlook token check. 'unknown' (network/throttle/5xx) must never
    //    flip token_status — the purge below deletes invalid accounts, and an
    //    upstream outage must not wipe the pool.
    const toCheck = allRows<{ email: string; client_id: string; refresh_token: string }>(db, `
      SELECT email, client_id, refresh_token FROM outlook_accounts
      WHERE account_type = 'short'
        AND client_id != ''
        AND refresh_token != ''
        AND (last_checked_at IS NULL OR datetime(last_checked_at) < datetime('now', '-1 day'))
    `);

    if (toCheck.length > 0) {
      const concurrency = Math.max(1, parseInt(getSetting('batch_concurrency', DEFAULT_SETTINGS.batch_concurrency), 10) || 5);
      let invalidCount = 0;
      let unknownCount = 0;
      await runConcurrent(toCheck, concurrency, async ({ email, client_id: clientId, refresh_token: refreshToken }) => {
        try {
          const { status, apiType } = await checkToken(email, clientId, refreshToken);
          if (status === 'unknown') {
            unknownCount++;
            db.prepare(`UPDATE outlook_accounts SET last_checked_at = datetime('now') WHERE email = ?`).run(email);
          } else {
            if (status === 'invalid') invalidCount++;
            if (status === 'valid' && apiType) {
              db.prepare(
                `UPDATE outlook_accounts SET token_status = ?, api_type = ?, last_checked_at = datetime('now') WHERE email = ?`,
              ).run(status, apiType, email);
            } else {
              db.prepare(`UPDATE outlook_accounts SET token_status = ?, last_checked_at = datetime('now') WHERE email = ?`).run(status, email);
            }
          }
        } catch (e) {
          unknownCount++;
          log.warn('Outlook token check errored, leaving account status untouched', { email, error: errorMessage(e) });
        }
      });

      const deleted = getRow<{ count: number }>(
        db,
        `SELECT COUNT(*) AS count FROM outlook_accounts WHERE account_type = 'short' AND token_status = 'invalid' AND assigned_inbox_id IS NULL`,
      ) ?? { count: 0 };
      if (deleted.count > 0) {
        db.prepare(`DELETE FROM outlook_accounts WHERE account_type = 'short' AND token_status = 'invalid' AND assigned_inbox_id IS NULL`).run();
        log.info('purged invalid short-term Outlook accounts', { count: deleted.count });
      }
      log.info('Outlook token check complete', { checked: toCheck.length, invalid: invalidCount, unknown: unknownCount });
    }
  } catch (e) {
    log.error('cleanup failed', { error: errorMessage(e) });
  } finally {
    cleanupRunning = false;
  }
}
