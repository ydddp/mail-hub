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
  "version": "0.10.3",
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
  "account": "me@icloud.com", // optional: which pooled account to draw from (iCloud only)
  "alias": true,              // optional: ask for a sub-address (see below)
  "duration": 600,            // optional: lifespan in seconds
  "needPolling": true         // optional: require polling support (default: true)
}
```

**`alias`** — request a sub-address instead of the provider's plain address. The
tag is generated server-side; callers do not supply it. Honored only by
providers advertising `features.alias` (currently Outlook, which returns
`account+tag@outlook.com`); silently ignored by the rest, so with auto-dispatch
you may receive a plain address. Read `address` in the response for what you
actually got.

**`account`** — name the pooled credential the address should come from, by id
or by Apple ID. Honored by the iCloud provider only; other providers ignore it.

Several Apple IDs are not interchangeable: each forwards its aliases to its own
mailbox, so which account an address came from decides which mailbox has to be
readable for the code to arrive. Omit it and the least-used free address across
every usable account is chosen.

The inbox still occupies exactly one pooled account — an alias is a different
address at the target service, not extra pool capacity. Use it for services that
accept `+` in signup forms; many reject it, which is why this is opt-in per
request rather than always on.

**Effect on the anti-reuse blacklist.** Normally an Outlook account is handed to
a given `for` service only once: reporting success records the service in the
account's `used_services`, and later requests skip that account. An aliased
request **bypasses that filter**, because each one mints a fresh address — so
the same account can register at the same service repeatedly. The service is
still recorded, so a later request *without* `alias` still finds the account
excluded. Turning the flag off restores the original one-account-one-service
guarantee.

Two caveats worth knowing before relying on this: a site that strips `+tag`
before comparing will still see one mailbox and may treat the second signup as a
duplicate, and the account remains 1:1, so repeat registrations are sequential —
close the current inbox before creating the next one on that account.

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
  "provider": "mailtm",
  "accountEmail": "user@outlook.com"
}
```

Pool providers hand out mailboxes that already hold a previous tenant's mail, so
this list is clipped to the inbox's own lifetime (`created_at`, minus 60s of
clock slack). Mail that predates the inbox is not returned even though it is
still sitting in the upstream mailbox.

`accountEmail` is present only for Outlook, where one mailbox serves one inbox at
a time; it names the pool account so an admin client can reach
[the mailbox view](#get-apioutlookaccountsemailmailbox--account-mailbox).

**Errors**: 400 (no polling support), 404, 429 (rate limit), 502 (upstream error)

---

### GET /api/inbox/:id/messages/:mid — Message Detail

Get full message content including body. The same lifetime boundary applies:
message ids stay valid across mailbox reuse, so a message from outside this
inbox's lifetime returns 404 rather than a previous tenant's content.

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
| `since` | ISO datetime / epoch milliseconds | Only consider messages received after this timestamp |

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
  },
  "messageId": "message-123",
  "receivedAt": "2025-01-01T00:01:00Z"
}
```

No messages yet:
```json
{ "codes": [], "email": null, "messageId": null, "receivedAt": null }
```

**Behavior**: When `wait=true`, polls every 3s for the first 20s, then every 5s until timeout. Returns immediately if matching messages already exist. For repeated retrieval, store the previous response `receivedAt` and call `GET /api/inbox/:id/code?wait=true&since=<receivedAt>` to wait for a later message without reusing the same email.

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
  "pendingOAuth": 2,
  "noToken": 0,
  "longCount": 10,
  "shortCount": 40
}
```

### POST /api/outlook/import — Import Accounts

**Request** (JSON):
```json
{
  "accounts": "email1----password1\nemail2----password2----clientId2----refreshToken2",
  "type": "long",
  "group": "batch-1"
}
```
Supported formats per line:
- `email----password`: imports as `pending_oauth`; it cannot be assigned until authorization is completed.
- `email----password----clientId----refreshToken`: imports as a token-backed account and can be checked/assigned normally.

**Response 200**:
```json
{ "imported": 10, "duplicated": 2, "skipped": 0, "errors": [] }
```

### GET /api/outlook/accounts — List Accounts

**Query parameters**: `status=valid|invalid|pending_oauth|no_token`, `available=true|false`, `group=...`, `type=long|short`, `q=...` (fuzzy match on email or group name)

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
      "oauth_last_error": null,
      "last_inbox_id": null
    }
  ]
}
```

Only accounts with `client_id`, `refresh_token`, no assignment, and a non-pending/non-invalid token status are considered available for inbox allocation.

### GET /api/outlook/accounts/:email/mailbox — Account Mailbox

Read the whole mailbox behind a pool account, rather than one inbox's clipped
view of it. `GET /api/inbox/:id/messages` returns only what arrived during that
inbox's lifetime — deliberately, since a recycled account arrives holding the
previous tenant's mail. This endpoint answers the other question: what else is in
this mailbox. Admin only.

**Query parameters**: `limit=1..100` (default 50)

**Response 200**:
```json
{
  "email": "user@outlook.com",
  "limit": 50,
  "truncated": false,
  "messages": [
    {
      "id": "msg-id",
      "from": "Steam <noreply@steampowered.com>",
      "subject": "Your Steam code",
      "excerpt": "",
      "receivedAt": "2026-07-27T14:03:11Z",
      "leaseId": "i-abc123",
      "leaseState": "lease"
    }
  ],
  "leases": [
    {
      "id": "i-abc123",
      "address": "user+ab12cd34@outlook.com",
      "targetService": "steam",
      "createdAt": "2026-07-27 14:02:00",
      "endedAt": null,
      "status": "active"
    }
  ]
}
```

Every message is attributed to the inbox that held the mailbox when it arrived:

| `leaseState` | Meaning |
|---|---|
| `lease` | Arrived during `leaseId`'s window |
| `gap` | Arrived while the account sat idle between leases |
| `before` | Older than the account's first lease |
| `undated` | No parseable timestamp; kept rather than dropped |

A lease's window ends at whichever came first: `closed_at`, `expires_at` (only a
fallback, for rows closed before `closed_at` was recorded), or the moment the
next lease took the account.

`limit` is a hard ceiling, not paging: the newest `limit` of Inbox and Junk are
fetched and merged down to `limit`. Older mail exists upstream and is not
reachable from here; `truncated` is `true` when the cap was hit.

**Errors**: 403 (not admin), 404 (no such account), 502 (upstream error)

---

### GET /api/outlook/accounts/:email/mailbox/:messageId — Mailbox Message Detail

Full content of one message from the account mailbox, not clipped to any lease.
Admin only.

**Response 200**: same shape as `GET /api/inbox/:id/messages/:mid`.

**Errors**: 403 (not admin), 404 (no such account), 502 (upstream error)

---

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
  "valid": 7,
  "invalid": 1,
  "unknown": 2,
  "results": [
    { "email": "imap-user@outlook.com", "valid": true, "status": "valid", "apiType": "imap" },
    { "email": "graph-user@outlook.com", "valid": true, "status": "valid", "apiType": "graph" },
    { "email": "bad@outlook.com", "valid": false, "status": "invalid", "apiType": "" },
    { "email": "temporarily-unreachable@outlook.com", "valid": false, "status": "unknown" }
  ]
}
```

`apiType` is the detected mailbox transport: `graph`, `outlook`, or `imap`.
Unknown accounts are capability-probed without inferring the transport from the
refresh-token or access-token format. A known `imap` account is checked through
IMAP first. Deterministic OAuth/authentication rejection is `invalid`; network,
proxy, throttling, 5xx, and temporary IMAP failures are `unknown` and do not
invalidate the stored account.

### POST /api/outlook/renew — Renew Tokens

**Request** (JSON, optional — same as check).

**Response 200**:
```json
{
  "total": 3,
  "renewed": 1,
  "failed": 2,
  "results": [
    { "email": "imap-user@outlook.com", "renewed": true, "status": "renewed", "apiType": "imap" },
    { "email": "graph-user@outlook.com", "renewed": false, "status": "not_rotated", "apiType": "graph" },
    { "email": "temporarily-unreachable@outlook.com", "renewed": false, "status": "unknown" }
  ]
}
```

A token-endpoint `200` is not enough to report the mailbox usable. The renewed
access token is capability-checked against the actual mailbox transports and
the detected `apiType` is persisted. `not_rotated` means the refresh token was
accepted and the mailbox capability was validated, but Microsoft did not issue
a replacement refresh token. Infrastructure failures remain `unknown`.

### POST /api/outlook/oauth/start — Start Authorization Completion

Creates an authorization session for a pending account and returns an authorize URL. The default preset is the built-in Thunderbird public-client flow; `custom` keeps compatibility with user-provided OAuth app settings. After code exchange, Mail Hub validates real mailbox-read capability before finalizing the account. Thunderbird's IMAP-scoped token therefore completes as `token_status=valid` with `api_type=imap` even when Graph and Outlook REST reject it.

**Request** (JSON):
```json
{ "email": "user@outlook.com", "preset": "thunderbird" }
```

**Response 200**:
```json
{
  "sessionId": "...",
  "authorizeUrl": "https://...",
  "email": "user@outlook.com",
  "preset": "thunderbird",
  "clientId": "...",
  "redirectUri": "https://localhost",
  "serverProxyConfigured": true,
  "status": "pending"
}
```

### POST /api/outlook/oauth/code — Submit Authorization Code

Used when the authorization redirect is captured outside Mail Hub. Submit either `finalUrl` or `code` plus `state`. Tokens are stored server-side and are not returned.

**Request** (JSON):
```json
{ "sessionId": "...", "finalUrl": "https://localhost/?code=...&state=..." }
```

**Response 200**:
```json
{ "ok": true, "sessionId": "...", "email": "user@outlook.com", "preset": "thunderbird", "status": "completed" }
```

### GET /api/outlook/oauth/status/:sessionId — Authorization Status

**Response 200**:
```json
{ "sessionId": "...", "email": "user@outlook.com", "preset": "thunderbird", "status": "completed", "error": "" }
```

### POST /api/outlook/oauth/password — Get Pending Account Password

Admin-only helper for the UI/manual authorization flow. It returns the password for an unassigned pending/no-token Outlook account by `sessionId` or `email`, and does not return any token.

**Request** (JSON):
```json
{ "sessionId": "..." }
```

or:
```json
{ "email": "user@outlook.com" }
```

**Response 200**:
```json
{ "email": "user@outlook.com", "password": "..." }
```

### GET /api/outlook/oauth/callback — Custom OAuth Callback

Compatibility callback for custom OAuth app settings. The default UI flow uses `/api/outlook/oauth/code` instead.

### POST /api/outlook/oauth/automation/claim — Claim Completion Task

External browser automation can claim one pending account. It receives the authorize URL and session metadata, but not the account password.

**Request** (JSON, optional):
```json
{ "preset": "thunderbird", "includeProxy": true, "includeFailed": false }
```
`includeProxy` returns the configured proxy URL for the external automation helper. It is admin-only and should not be logged. By default, accounts with `oauth_last_error` are skipped; set `includeFailed: true` only for an explicit retry workflow.

**Response 200**:
```json
{
  "sessionId": "...",
  "authorizeUrl": "https://...",
  "email": "user@outlook.com",
  "preset": "thunderbird",
  "redirectUri": "https://localhost",
  "serverProxyConfigured": true,
  "proxyUrl": "http://user:pass@host:port",
  "status": "pending"
}
```

### POST /api/outlook/oauth/automation/password — Get Claimed Password

Admin-only helper for external automation after a session has been claimed.

**Request** (JSON):
```json
{ "sessionId": "..." }
```

**Response 200**:
```json
{ "email": "user@outlook.com", "password": "..." }
```

### POST /api/outlook/oauth/automation/report — Report Automation State

**Request** (JSON):
```json
{ "sessionId": "...", "status": "waiting_user", "error": "" }
```

Allowed statuses: `started`, `waiting_user`, `failed`, `completed`.

**Response 200**:
```json
{ "ok": true }
```

### GET /api/outlook/settings — Get Settings

**Response 200**:
```json
{
  "recordFailService": false,
  "batchConcurrency": 5,
  "oauthClientId": "",
  "oauthRedirectUri": "http://localhost:3100/api/outlook/oauth/callback",
  "oauthScopes": "",
  "oauthTenant": "consumers"
}
```

`recordFailService` defaults to `false`: only a **successful** report adds the
target service to an Outlook account's `used_services`. That list is a
permanent, irreversible per-account blacklist — an account is never offered to
a service it already appears against — so a transient failure must not burn a
paid account unless the operator opts in by setting this to `true`.

### PATCH /api/outlook/settings — Update Settings

**Request** (JSON):
```json
{
  "recordFailService": false,
  "batchConcurrency": 5,
  "oauthClientId": "",
  "oauthRedirectUri": "",
  "oauthScopes": "",
  "oauthTenant": "consumers"
}
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

One catch-all mailbox backs many concurrent inboxes: Mail Hub invents an
address per inbox and sorts the shared mailbox by recipient. Generated local
parts are name-shaped rather than a random string — `nathanlambert@`,
`lisa.chen@`, `d_watson91@`, `vera.oconnell8@` — and an address a live inbox
already holds is never reissued. Pass `username` on `POST /api/inbox` to pick
the local part yourself.

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

## iCloud Aliases (Admin)

Hide My Email is a **forwarding alias, not a mailbox**: Apple exposes no API for
reading mail sent to one. Every message is forwarded to an address the account
owner chose, so this provider has two halves that fail independently — a cookie
or SRP session that mints addresses, and an IMAP login that reads their mail.

The forwarding address is frequently **not** an Apple mailbox. When the Apple ID
is a Gmail or Outlook address, the read half must point at that provider's IMAP
server rather than Apple's.

Requires an active **iCloud+** subscription. An Apple ID is capped at **750
addresses for its lifetime**, so addresses are recycled rather than minted per
inbox — releasing an inbox returns its address to the pool.

### Account status

| Status | Meaning |
|--------|---------|
| `active` | Both halves work: addresses can be minted and their mail read |
| `degraded` | The session expired. Existing addresses still receive and read; minting is not possible until the cookie is replaced or SRP re-runs |
| `error` | The read half is broken. Addresses cannot be polled, so dispatch refuses this account |

### Address states

| State | Meaning |
|-------|---------|
| `free` | In the pool, available to claim |
| `assigned` | Held by a live inbox |
| `retired` | Deactivated at Apple after being burned; never handed out again, and its slot stays spent |

### GET /api/icloud/accounts — List Accounts

Cookies, the Apple ID password, the trust token and the IMAP password are never
returned.

### POST /api/icloud/accounts — Add Account

```json
{
  "appleId": "me@gmail.com",
  "region": "global",                  // or "china"
  "cookies": "<paste anything>",
  "imapUser": "me@gmail.com",          // where Hide My Email forwards
  "imapPassword": "<app password>",
  "imapHost": "imap.gmail.com",        // defaults to imap.mail.me.com
  "imapPort": 993
}
```

`cookies` accepts whatever the browser put on the clipboard: Copy as cURL in any
shell dialect, Copy as PowerShell, a cookie extension's JSON export, or a bare
`Cookie` header. A paste missing `X-APPLE-WEBAUTH-TOKEN` or
`X-APPLE-WEBAUTH-USER` is rejected with `400` naming the missing cookie, rather
than stored to fail later.

### POST /api/icloud/accounts/:id/test — Test Both Halves

Validates the session against Apple, reports where Hide My Email delivers, and
logs into the IMAP mailbox. Returns `{ ok, serviceUrl, forwardTo,
forwardMismatch, hmeError, imapError }` — the two errors are separate because
they are fixed in different places.

### POST /api/icloud/accounts/:id/cookies — Replace an Expired Cookie

Swaps the session in place, keeping the address pool. Deleting and recreating
the account would spend every alias it holds.

### POST /api/icloud/accounts/:id/srp/begin — Sign In over SRP

`{ "password": "<Apple ID password>" }` → `{ sessionId, needsMfa }`.

A cookie expires within hours; a trust token lasts far longer, so the six-digit
code is asked for once per Apple ID rather than once per session. When Apple
accepts a stored trust token, `needsMfa` is `false` and no code is sent.

### GET /api/icloud/srp/:sessionId/phones — Trusted Phone Numbers

For an operator with no Apple device to hand. Apple masks the digits itself.

### POST /api/icloud/srp/:sessionId/sms — Send the Code by SMS

`{ "phoneId": 1 }`

### POST /api/icloud/accounts/:id/srp/complete — Submit the Code

`{ "sessionId": "...", "code": "123456" }`

Sessions expire after five minutes. The in-flight handshake lives in memory, so
a restart between begin and complete loses the attempt — sign in again and Apple
pushes a fresh code.

### POST /api/icloud/accounts/:id/generate — Mint Addresses Now

`{ "count": 1 }` (max 5). Manual top-up; the scheduled task normally handles
this. Apple's own refusal text is returned verbatim in `error` rather than
classified, because its failure taxonomy is undocumented.

### DELETE /api/icloud/accounts/:id — Remove an Account

Refuses with `409` while any of its addresses is held by a live inbox. Repeat
with `?force=1` to delete anyway.

### GET /api/icloud/addresses — The Address Pool

### GET /api/icloud/addresses/:hme/messages — Read an Address's Mail

Everything that has ever arrived at the address, unlike `GET /api/inbox/:id/messages`
which hides anything older than the inbox asking.

### GET /api/icloud/addresses/:hme/messages/:uid — Message Detail

### POST /api/icloud/addresses/:hme/retire — Retire a Burned Address

Deactivates it at Apple and never hands it out again. Refuses with `409` while
an inbox holds it. **The slot it occupies stays spent** — 750 is the lifetime
total for one Apple ID.

### Automatic refill

A background task tops the pool up to `icloud_pool_target` (default 10) every
`icloud_pool_interval_minutes` (default 15), minting at most 5 per pass. Any
refusal from Apple sets a 45-minute cooldown, stored in the database so a
restart cannot clear it. Reconciliation runs first each pass and adopts only
addresses carrying Mail Hub's own label — an unmarked alias may be one the
account owner created by hand, and handing that to a tenant would expose their
private mail.

Controlled from the iCloud page, or through `PATCH /api/admin/settings` with
`icloud_pool_enabled` and `icloud_pool_target`. The target is clamped at 750.

## Target Services (Admin)

### GET /api/services — Service Summary

Aggregated view of all target services. Counters are durable (`service_stats`
table): they accumulate for the lifetime of the database and survive the
retention purge of old inboxes and fail-log entries, so a service never
disappears from this list just because its inboxes aged out.

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
      "successCount": 40,
      "failCount": 2,
      "blockCount": 1,
      "firstUsed": "2024-12-01T00:00:00Z",
      "lastUsed": "2025-01-01T00:00:00Z"
    }
  ]
}
```

`totalInboxes`, `successCount`, and `failCount` are cumulative; `activeInboxes`
counts currently active (still retained) inboxes.

### GET /api/services/:name — Service Detail

**Response 200**:
```json
{
  "name": "twitter.com",
  "stats": {
    "totalInboxes": 45,
    "successCount": 40,
    "failCount": 2,
    "firstUsed": "2024-12-01T00:00:00Z",
    "lastUsed": "2025-01-01T00:00:00Z"
  },
  "inboxes": [...],
  "failures": [...],
  "blocks": [...]
}
```

`stats` is cumulative and durable; `inboxes` / `failures` list only recent,
still-retained rows (up to 50 each).

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
  "version": "0.10.3",
  "uptime": 3600,
  "dbPath": "/app/data/mail.db",
  "dbSize": "1.2 MB",
  "backupEnabled": true,
  "backupIntervalHours": 24
}
```

### GET /api/admin/update-check — Check for Updates

Queries the Mail Hub GitHub repository for the highest stable `vX.Y.Z` tag and compares it with the running application version. This endpoint only checks version metadata; it does not pull Docker images, modify files, or restart the service.

**Response 200**:
```json
{
  "currentVersion": "0.10.3",
  "latestVersion": "0.10.4",
  "updateAvailable": true,
  "checkedAt": "2026-07-17T00:00:00.000Z",
  "source": "github-api"
}
```

The GitHub REST query follows tag pagination. If anonymous REST access is rate-limited, the endpoint falls back to GitHub's recent tag Atom feed and returns `"source": "github-feed"`; a no-update result from that fallback is best-effort because the feed exposes a finite recent window. GitHub request failures return `502`.

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
