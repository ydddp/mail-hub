# Mail Hub API Reference

Multi-provider temporary email aggregation service. All endpoints return JSON.

Base URL: `http://localhost:3100`

---

## Authentication

All `/api/*` endpoints require a Bearer token:

```
Authorization: Bearer <your-api-key-or-api-secret>
```

- **Admin**: Token matches `API_SECRET` env var (or no `API_SECRET` set = all requests are admin)
- **User**: Token matches an API key row in the database (created by admin via `POST /api/keys`)
- **No auth**: Returns `401 Unauthorized`

---

## Non-API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check |
| `GET` | `/v1/llms.txt` | None | AI-readable API summary (text/plain) |
| `GET` | `/` | None | SPA frontend |

### GET /health

Response 200:
```json
{
  "status": "ok",
  "version": "0.9.0",
  "startedAt": "2025-01-01T00:00:00Z",
  "uptime": 3600,
  "db": "connected"
}
```
Status 503 when DB degraded.

---

# Public API

Endpoints available to all authenticated users (admin + regular API keys). Non-admin users are scoped to their own resources (only see/modify inboxes they created).

## Inbox Lifecycle

### POST /api/inbox — Create Inbox

Create a new temporary inbox.

**Request** (JSON):
```json
{
  "for": "twitter.com",       // ⚠️ REQUIRED — target service domain
  "provider": "mailtm",       // optional: force specific provider
  "domain": "example.com",    // optional: request a specific email domain
  "subdomain": "team-a",      // optional: wildcard child domain prefix (YYDS only)
  "username": "customuser",   // optional: custom username
  "duration": 600,            // optional: lifespan in seconds
  "needPolling": true         // optional: require polling support (default: true)
}
```

**Response 201**:
```json
{
  "id": "aBcDeFgHiJkL",
  "address": "random@tmpmail.org",
  "provider": "mailtm",
  "expiresAt": "2025-01-01T12:00:00Z",
  "features": {
    "pollInbox": true,
    "attachments": false
  }
}
```

**Errors**: 400 (missing `for`), 429 (rate limited), 503 (all providers exhausted)

---

### GET /api/inboxes — List Inboxes

**Query parameters**:
| Param | Values | Description |
|-------|--------|-------------|
| `status` | `active` / `closed` | Filter by status |
| `provider` | e.g. `mailtm` | Filter by provider |
| `for` | e.g. `twitter` | Filter by target service |
| `page` | integer (default 1) | Page number |
| `pageSize` | integer (default 50, max 100) | Items per page |

**Response 200**:
```json
{
  "inboxes": [
    {
      "id": "abc123",
      "provider": "mailtm",
      "address": "user@domain.com",
      "target_service": "twitter.com",
      "created_at": "2025-01-01T00:00:00Z",
      "expires_at": null,
      "status": "active"
    }
  ],
  "page": 1,
  "pageSize": 50,
  "total": 42
}
```

---

### GET /api/inbox/:id — Get Inbox Detail

**Response 200**:
```json
{
  "id": "abc123",
  "provider": "mailtm",
  "address": "user@domain.com",
  "target_service": "twitter.com",
  "owner_key": "hash...",
  "created_at": "2025-01-01T00:00:00Z",
  "expires_at": null,
  "status": "active"
}
```

**Errors**: 404

---

### GET /api/inbox/:id/messages — Poll Messages

Retrieve messages in the inbox.

**Response 200**:
```json
{
  "messages": [
    {
      "id": "msg-id",
      "from": "noreply@twitter.com",
      "subject": "Your verification code",
      "excerpt": "Your code is 123456...",
      "receivedAt": "2025-01-01T00:01:00Z"
    }
  ],
  "status": "active",
  "address": "user@domain.com",
  "provider": "mailtm"
}
```

**Errors**: 400 (no polling support), 404, 429 (rate limit), 502 (upstream error)

---

### GET /api/inbox/:id/messages/:mid — Message Detail

Get full message content including body.

**Response 200**:
```json
{
  "id": "msg-id",
  "from": "noreply@twitter.com",
  "subject": "Your verification code",
  "excerpt": "Your code is 123456...",
  "text": "Your verification code is 123456",
  "html": "<html>...</html>",
  "receivedAt": "2025-01-01T00:01:00Z"
}
```

**Errors**: 404, 502

---

### GET /api/inbox/:id/code — Extract Verification Code

Extract verification codes from the latest email. Supports long-polling — the recommended endpoint for most use cases.

**Query parameters**:
| Param | Values | Description |
|-------|--------|-------------|
| `wait` | `true` | Long-poll until a message arrives (recommended) |
| `timeout` | integer (default 60, max 120) | Max wait time in seconds |
| `type` | `numeric` / `alphanumeric` / `link` | Filter code type |

**Response 200**:
```json
{
  "codes": [
    {
      "type": "numeric",
      "value": "483921",
      "confidence": 0.95,
      "context": "Your code is 483921"
    }
  ],
  "email": {
    "from": "noreply@service.com",
    "subject": "Your verification code"
  }
}
```

No messages yet:
```json
{ "codes": [], "email": null }
```

**Behavior**: When `wait=true`, polls every 3s for the first 20s, then every 5s until timeout. Returns immediately if messages already exist.

---

### POST /api/inbox/:id/report — Report Result ⚠️ MANDATORY

Report the outcome of using an inbox. This is the backbone of service quality — always call it.

**Request** (JSON):
```json
{
  "success": true,
  "service": "twitter.com"
}
```
- `success` (boolean, required): Whether the email arrived and was usable
- `service` (string, optional): Target service domain (falls back to `for` from creation)

**Response 200**:

Success:
```json
{ "ok": true, "action": "stats_updated" }
```

Failure (no auto-block):
```json
{ "ok": true, "action": "fail_recorded" }
```

Failure (auto-block triggered):
```json
{
  "ok": true,
  "action": "auto_blocked",
  "blocked": [
    { "service": "twitter.com", "domain": "tmpmail.org", "rule": 1 }
  ]
}
```

**Side effects**:
- `success=true`: Increments provider success count; records service for Outlook accounts
- `success=false`: Increments provider fail count; logs to fail log; checks auto-block rules

---

### DELETE /api/inbox/:id — Close Inbox

Close and release the inbox. Pool resources (Outlook accounts) are returned to the pool.

**Response 200**:
```json
{ "ok": true }
```

---

## Providers

### GET /api/providers — List Providers

Returns all registered email providers with their capabilities and configuration.

**Response 200**:
```json
{
  "providers": [
    {
      "name": "mailtm",
      "displayName": "Mail.tm",
      "type": "api",
      "tier": "free",
      "trustLevel": 3,
      "enabled": true,
      "priority": 10,
      "autoDispatch": true,
      "features": {
        "customUsername": true,
        "pollInbox": true,
        "realtime": false,
        "attachments": true
      },
      "rateLimit": { "maxPerMinute": 30 },
      "rateStatus": { "remaining": 28, "resetIn": 45 },
      "retention": "days"
    }
  ]
}
```

---

### GET /api/providers/:name — Provider Detail

**Response 200**:
```json
{
  "name": "mailtm",
  "displayName": "Mail.tm",
  ...,
  "domains": ["dpptd.com", "exelica.com"],
  "stats": {
    "success_count": 150,
    "fail_count": 3,
    "last_success_at": "2025-01-01T00:00:00Z"
  }
}
```

**Errors**: 404

---

### GET /api/providers/:name/domains — Available Domains

**Response 200**:
```json
{
  "provider": "mailtm",
  "domains": ["dpptd.com", "exelica.com"]
}
```

**Errors**: 404, 502

---

## Block Management

### GET /api/blocks — List Blocked Domains

**Query parameters**: `service` (optional), `domain` (optional)

**Response 200**:
```json
{
  "blocks": [
    {
      "id": 1,
      "service": "twitter.com",
      "domain": "sharklasers.com",
      "provider": "guerrillamail",
      "blocked_at": "2025-01-01T00:00:00Z",
      "reason": "Auto-blocked after 3 failures"
    }
  ]
}
```

---

### GET /api/block-rules — Auto-Block Rules

List configured auto-blocking rules.

**Response 200**:
```json
{
  "rules": [
    {
      "id": 1,
      "service": "twitter.com",
      "provider": "mailtm",
      "threshold": 3,
      "window_hours": 24,
      "scope": "per_service",
      "domain_level": 2,
      "enabled": true,
      "created_at": "2025-01-01T00:00:00Z"
    }
  ]
}
```

---

## Activity

### GET /api/activity — Recent Activity

**Response 200**:
```json
{
  "activities": [
    {
      "type": "green",
      "text": "Created inbox for twitter.com via mailtm",
      "time": "2025-01-01T00:00:00Z"
    }
  ]
}
```
Returns last 20 entries. `type`: `green` (success), `red` (error), `blue` (info), `yellow` (warning).

---

## Template Providers

### GET /api/template-providers — List Templates

**Response 200**:
```json
{
  "providers": [
    {
      "name": "custom-provider",
      "displayName": "My Provider",
      "apiBase": "https://api.example.com",
      "enabled": true,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

### GET /api/template-providers/:name — Template Config

**Response 200**: Full template configuration object.

**Errors**: 404

---

# Admin API

All endpoints below require admin authentication (token matches `API_SECRET`). Non-admin users receive `401`.

## Provider Configuration (Admin)

### PATCH /api/providers/:name — Update Provider

**Request** (JSON — all fields optional):
```json
{
  "enabled": true,
  "priority": 10,
  "autoDispatch": false
}
```

**Response 200**:
```json
{ "ok": true, "enabled": true, "priority": 10, "autoDispatch": false }
```

**Errors**: 400 (no valid fields), 404

---

## Block Management (Admin)

### POST /api/blocks — Add Block

**Request** (JSON):
```json
{
  "service": "twitter.com",
  "domain": "sharklasers.com",
  "provider": "guerrillamail",
  "reason": "Emails never arrive"
}
```
`provider` and `reason` are optional.

**Response 201**:
```json
{ "ok": true }
```

**Errors**: 400 (missing service/domain), 409 (duplicate)

### DELETE /api/blocks/:id — Delete Block

**Response 200**:
```json
{ "ok": true }
```

### POST /api/block-rules — Create Auto-Block Rule

**Request** (JSON):
```json
{
  "service": "twitter.com",
  "provider": "mailtm",
  "threshold": 3,
  "window_hours": 24,
  "scope": "per_service",
  "domain_level": 2
}
```
- `service`: `"*"` for all services, or a specific domain
- `provider`: `"*"` for all providers, or a specific provider name
- `scope`: `"per_service"` or `"global"`
- `domain_level`: controls how much of the domain is blocked (e.g. 2 = block `example.com`, not `mail.example.com`)

**Response 201**:
```json
{ "ok": true }
```

### PATCH /api/block-rules/:id — Update Rule

**Request** (JSON — all fields optional):
```json
{
  "enabled": false,
  "threshold": 5,
  "window_hours": 48,
  "domain_level": 1
}
```

**Response 200**:
```json
{ "ok": true }
```

### DELETE /api/block-rules/:id — Delete Rule

**Response 200**:
```json
{ "ok": true }
```

---

## API Key Management (Admin)

### POST /api/keys — Create Key

**Request** (JSON):
```json
{ "name": "For John" }
```

**Response 201**:
```json
{
  "key": "mk_aBcDeFgHiJkLmNoPqRsTuVwXyZ...",
  "keyHash": "sha256-hash",
  "name": "For John",
  "callCount": 0,
  "lastUsedAt": null,
  "active": true
}
```
The plaintext `key` is only returned once at creation.

### GET /api/keys — List Keys

**Response 200**:
```json
{
  "keys": [
    {
      "key": "mk_abcdef...",
      "keyHash": "sha256-hash",
      "name": "For John",
      "callCount": 150,
      "dailyLimit": 1000,
      "dailyCalls": 42,
      "lastUsedAt": "2025-01-01T00:00:00Z",
      "createdAt": "2025-01-01T00:00:00Z",
      "active": true
    }
  ]
}
```

### PATCH /api/keys/:keyHash — Update Key

**Request** (JSON — all fields optional):
```json
{
  "name": "For Team A",
  "active": false,
  "dailyLimit": 5000
}
```

**Response 200**:
```json
{ "ok": true }
```

### DELETE /api/keys/:keyHash — Delete Key

**Response 200**:
```json
{ "ok": true }
```

---

## Template Providers (Admin Mutations)

### POST /api/template-providers — Create Template

**Request** (JSON): Full provider config object (see template schema).

**Response 200**:
```json
{ "success": true, "name": "custom-provider" }
```

**Errors**: 400 (incomplete config), 409 (name exists)

### PUT /api/template-providers/:name — Update Template

**Request** (JSON): Full provider config object.

**Response 200**:
```json
{ "success": true }
```

### DELETE /api/template-providers/:name — Delete Template

**Response 200**:
```json
{ "success": true }
```

### PATCH /api/template-providers/:name/toggle — Toggle Template

**Request** (JSON):
```json
{ "enabled": false }
```

**Response 200**:
```json
{ "success": true, "enabled": false }
```

### POST /api/template-providers/:name/test — Test Template Pipeline

Runs the full lifecycle: getDomains → createInbox → getMessages → deleteInbox.

**Response 200**:
```json
{
  "success": true,
  "steps": [
    { "step": "getDomains", "ok": true, "detail": "3 domains: a.com, b.com, c.com" },
    { "step": "createInbox", "ok": true, "detail": "Created: test@a.com" },
    { "step": "getMessages", "ok": true, "detail": "0 messages (expected for new inbox)" },
    { "step": "deleteInbox", "ok": true, "detail": "Deleted" }
  ]
}
```

---

## Outlook Account Pool (Admin)

All mounted under `/api/outlook`.

### GET /api/outlook/stats — Pool Statistics

**Response 200**:
```json
{
  "total": 50,
  "available": 35,
  "assigned": 15,
  "validToken": 42,
  "invalidToken": 3,
  "longCount": 10,
  "shortCount": 40
}
```

### POST /api/outlook/import — Import Accounts

**Request** (JSON):
```json
{
  "accounts": "email1----password1----clientId1----refreshToken1\nemail2----...",
  "type": "long",
  "group": "batch-1"
}
```
Format per line: `email----password----clientId----refreshToken`

**Response 200**:
```json
{ "imported": 10, "duplicated": 2, "skipped": 0, "errors": [] }
```

### GET /api/outlook/accounts — List Accounts

**Query parameters**: `status=valid|invalid|no_token`, `available=true|false`, `group=...`, `type=long|short`

**Response 200**:
```json
{
  "accounts": [
    {
      "email": "user@outlook.com",
      "token_status": "valid",
      "assigned_inbox_id": null,
      "group_name": "batch-1",
      "account_type": "long",
      "created_at": "...",
      "token_renewed_at": "...",
      "last_checked_at": "...",
      "last_inbox_id": null
    }
  ]
}
```

### DELETE /api/outlook/accounts — Delete Unassigned Accounts

**Request** (JSON):
```json
{ "emails": ["user@outlook.com", "user2@outlook.com"] }
```

**Response 200**:
```json
{ "deleted": 2, "requested": 2 }
```

### POST /api/outlook/check — Check Token Validity

**Request** (JSON, optional):
```json
{ "emails": ["user@outlook.com"] }
```
Omit to check all accounts.

**Response 200**:
```json
{
  "checked": 10,
  "valid": 8,
  "invalid": 2,
  "results": [
    { "email": "user@outlook.com", "valid": true },
    { "email": "bad@outlook.com", "valid": false }
  ]
}
```

### POST /api/outlook/renew — Renew Tokens

**Request** (JSON, optional — same as check).

**Response 200**:
```json
{
  "total": 10,
  "renewed": 9,
  "failed": 1,
  "results": [
    { "email": "user@outlook.com", "renewed": true },
    { "email": "bad@outlook.com", "renewed": false }
  ]
}
```

### GET /api/outlook/settings — Get Settings

**Response 200**:
```json
{ "recordFailService": true }
```

### PATCH /api/outlook/settings — Update Settings

**Request** (JSON):
```json
{ "recordFailService": false }
```

**Response 200**:
```json
{ "ok": true }
```

---

## YYDS Mail Pool (Admin)

All mounted under `/api/yyds`.

### GET /api/yyds/stats — Pool Statistics

**Response 200**:
```json
{
  "total": 10,
  "active": 8,
  "invalid": 2,
  "disabled": 0,
  "totalInboxes": 156,
  "dailyUsed": 1500,
  "dailyQuota": 160000
}
```

### POST /api/yyds/import — Import API Keys

**Request** (JSON):
```json
{
  "accounts": "API-KEY-1----name1\nAPI-KEY-2----name2"
}
```
Format per line: `API_KEY----display_name`

**Response 200**:
```json
{ "imported": 5, "duplicated": 2, "skipped": 0, "errors": [] }
```

### GET /api/yyds/accounts — List Keys

**Response 200**:
```json
{
  "accounts": [
    {
      "api_key": "KEY1",
      "name": "Primary Key",
      "status": "active",
      "supports_wildcard": true,
      "inbox_count": 12,
      "daily_calls": 500,
      "last_used_at": "2025-01-01T00:00:00Z",
      "created_at": "2025-01-01T00:00:00Z"
    }
  ]
}
```

### DELETE /api/yyds/accounts — Delete Keys

**Request** (JSON):
```json
{ "keys": ["KEY1", "KEY2"] }
```

**Response 200**:
```json
{ "deleted": 2, "requested": 2 }
```

### POST /api/yyds/check — Validate Keys

**Request** (JSON, optional):
```json
{ "keys": ["KEY1"] }
```
Omit to check all.

**Response 200**:
```json
{
  "checked": 10,
  "valid": 8,
  "invalid": 2,
  "results": [
    { "key": "KEY1", "valid": true }
  ]
}
```

### PATCH /api/yyds/accounts/status — Enable/Disable Keys

**Request** (JSON):
```json
{ "keys": ["KEY1", "KEY2"], "enabled": false }
```

**Response 200**:
```json
{ "updated": 2, "enabled": false }
```

### PATCH /api/yyds/accounts/wildcard — Set Wildcard Support

**Request** (JSON):
```json
{ "keys": ["KEY1"], "wildcard": true }
```

**Response 200**:
```json
{ "updated": 1, "wildcard": true }
```

---

## IMAP Domain Email (Admin)

All mounted under `/api/imap`.

### GET /api/imap/stats — Pool Statistics

**Response 200**:
```json
{ "total": 3, "active": 2 }
```

### GET /api/imap/accounts — List Accounts

**Response 200**:
```json
{
  "accounts": [
    {
      "id": "uuid",
      "host": "imap.gmail.com",
      "port": 993,
      "domain": "mydomain.com",
      "user": "me@mydomain.com",
      "status": "active",
      "tls": true,
      "last_checked_at": "...",
      "created_at": "..."
    }
  ]
}
```
Passwords are excluded from the response.

### GET /api/imap/accounts/:id — Account Detail

**Response 200**:
```json
{ "account": { ... } }
```

**Errors**: 404

### POST /api/imap/accounts — Add Account

**Request** (JSON):
```json
{
  "host": "imap.gmail.com",
  "port": 993,
  "user": "me@gmail.com",
  "password": "app-password",
  "domain": "mydomain.com",
  "tls": true
}
```

**Response 201**:
```json
{
  "account": {
    "id": "uuid",
    "host": "imap.gmail.com",
    "port": 993,
    "user": "me@gmail.com",
    "domain": "mydomain.com",
    "tls": true,
    "status": "active"
  }
}
```

### PUT /api/imap/accounts/:id — Update Account

**Request** (JSON — all fields optional):
```json
{
  "host": "new-imap.example.com",
  "user": "newuser",
  "password": "new-password",
  "domain": "newdomain.com",
  "port": 993,
  "tls": true,
  "status": "active"
}
```

**Response 200**:
```json
{ "ok": true }
```

### DELETE /api/imap/accounts/:id — Delete Account

**Response 200**:
```json
{ "ok": true }
```

### POST /api/imap/accounts/:id/test — Test Connection

**Response 200**:
```json
{ "ok": true }
```
On failure: `{ "ok": false, "error": "Connection refused" }`

---

## Target Services (Admin)

### GET /api/services — Service Summary

Aggregated view of all target services.

**Response 200**:
```json
{
  "summary": {
    "totalServices": 10,
    "totalInboxes": 150,
    "totalFailures": 12,
    "totalBlocks": 5
  },
  "services": [
    {
      "name": "twitter.com",
      "totalInboxes": 45,
      "activeInboxes": 3,
      "failCount": 2,
      "blockCount": 1,
      "lastUsed": "2025-01-01T00:00:00Z"
    }
  ]
}
```

### GET /api/services/:name — Service Detail

**Response 200**:
```json
{
  "name": "twitter.com",
  "inboxes": [...],
  "failures": [...],
  "blocks": [...]
}
```

---

## System Settings (Admin)

Mounted under `/api/admin`.

### GET /api/admin/settings — Get Settings

**Response 200**:
```json
{
  "settings": { "backup_enabled": "1", "backup_interval_hours": "24" },
  "defaults": { ... },
  "updatedAt": { ... }
}
```

### PATCH /api/admin/settings — Update Settings

**Request** (JSON):
```json
{
  "settings": {
    "backup_enabled": "1",
    "backup_interval_hours": "12"
  }
}
```

**Response 200**:
```json
{ "ok": true, "settings": { ... } }
```

### POST /api/admin/backup — Trigger Manual Backup

**Response 200**:
```json
{ "ok": true, "backup": { ... } }
```

### GET /api/admin/backups — List Backups

**Response 200**:
```json
{ "backups": [ ... ] }
```

### DELETE /api/admin/backups/:filename — Delete Backup

**Response 200**:
```json
{ "ok": true }
```

### GET /api/admin/system-info — System Info

**Response 200**:
```json
{
  "version": "0.9.0",
  "uptime": 3600,
  "dbPath": "/app/data/mail.db",
  "dbSize": "1.2 MB",
  "backupEnabled": true,
  "backupIntervalHours": 24
}
```

---

## Error Responses

All errors follow this format:
```json
{ "error": "Human-readable error message" }
```

**Common HTTP status codes**:

| Code | Meaning |
|------|---------|
| 400 | Bad request (missing required field, invalid format) |
| 401 | Missing or invalid Bearer token |
| 404 | Resource not found |
| 409 | Duplicate resource |
| 410 | Inbox already closed |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 502 | Upstream provider error |
| 503 | All providers exhausted |

---

## Typical Workflow

```
1. POST   /api/inbox              → Create a temporary inbox
2. GET    /api/inbox/:id/code     → Wait for & extract verification code (recommended)
3. POST   /api/inbox/:id/report   → ⚠️ MANDATORY: Report the result
4. DELETE /api/inbox/:id          → Close the inbox when done
```

## Best Practices

1. **Always provide `for`** — the target service domain is required for routing, statistics, and block avoidance
2. **Use `GET /api/inbox/:id/code?wait=true`** — long-polling is the recommended way to get codes
3. **Always call `POST /api/inbox/:id/report`** — this is the most important step; it tracks provider reliability and triggers auto-blocking of bad domains
4. **DELETE the inbox** — frees pool resources (Outlook accounts return to pool)
5. **Handle 429** — wait and retry; the system manages per-provider rate limits automatically
6. **Use full domain names** — `twitter.com` not `twitter`

---

## AI / LLM Integration

The `/v1/llms.txt` endpoint (no auth required) returns an AI-readable plain-text API summary. When using AI assistants to integrate with Mail Hub, point them to:

```
https://your-server.com/v1/llms.txt
```

Example prompt for AI assistants:
> Please read https://your-server.com/v1/llms.txt to learn the Mail Hub API, then help me write an integration script.
