# Mail Hub API Reference

Multi-provider temporary email aggregation service. All endpoints return JSON.

Base URL: `http://localhost:3100`

## Time contract

- Time-point fields (including snake_case DB metadata) are UTC ISO datetimes
  with milliseconds and `Z`, e.g. `2026-10-04T12:00:00.000Z`. Field names stay
  unchanged. Missing/invalid metadata times are `null`; unknown message
  `receivedAt` remains `""` (the code endpoint uses `null`).
- The SPA converts instants to the browser's local timezone, shown above the
  page. API responses and application logs remain UTC.
- Daily API-key and YYDS counters use UTC calendar days and reset at 00:00 UTC,
  irrespective of the viewer's timezone. Counter date markers are dates, not
  timestamps. YYDS list/stat views display zero for a previous day's counters
  without writing a reset on read.
- `since` accepts epoch **milliseconds** or a full datetime. Explicit offsets
  are honored; legacy full datetimes without a zone are interpreted as UTC.
  Date-only values, impossible dates and unparseable values return 400.
- Existing SQLite UTC values are not rewritten. Inbox lease isolation and
  expiry remain comparisons of absolute instants. Backup/cleanup intervals
  remain elapsed durations.

Template providers may set `messages.timestampFormat` and
`messageDetail.timestampFormat` in their JSON config:

| Value | Upstream timestamp contract |
|-------|-----------------------------|
| `iso` (default) | Full datetime with `Z`/offset, or an RFC email date with an explicit zone |
| `utc` | Same, additionally accepting full zone-less datetimes **known to be UTC** |
| `unix_seconds` | Numeric epoch seconds |
| `unix_milliseconds` | Numeric epoch milliseconds |

The `fromList` detail path uses `messages.timestampFormat`. Units/timezones
are never inferred from numeric length or the server/browser timezone. A
zone-less upstream time requires a verified source contract before choosing
`utc`; otherwise it stays unknown. Guerrilla Mail uses `mail_timestamp`
(epoch seconds), including legacy builtin configs mapping `mail_date`.
TempMail.lol uses epoch milliseconds in `date`, including legacy builtin rows.

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
  "version": "0.12.0",
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

**Recipient isolation.** Alias inbox lists, details, and codes require exact
To/Cc recipient evidence. Address comparisons fold ASCII A-Z only and preserve
all Unicode characters without case or compatibility normalization. An Outlook
inbox whose address differs from its account stays recipient-scoped, including
legacy rows; an empty stored inbox address returns `404 Message not found`.
The account's plain address and admin account-mailbox endpoints retain access to
the whole mailbox.

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
this list is clipped to the inbox's own lifetime. The lower bound is the start
of the second after `created_at`, accounting for SQLite's second precision.
The upper bound is the earlier valid `closed_at` or `expires_at`, exclusive.
Closed history with an unknown end or message timestamp is withheld. Mail
outside these bounds is not returned even when it remains upstream. Each
completed read rechecks the current inbox ownership and lifetime.

Closed inbox records are kept for the configured `retention_inbox_days` after
that same effective end. A delayed cleanup does not extend this period. Legacy
closed records with no usable end are retained and counted in cleanup warnings;
their creation time is not used to guess when the lease ended.

`accountEmail` is present only for Outlook, where one mailbox serves one inbox at
a time; it names the pool account so an admin client can reach
[the mailbox view](#get-apioutlookaccountsemailmailbox--account-mailbox).

**Errors**: 400 (no polling support), 404, 429 (rate limit), 502 (upstream error)

For tenant message reads (`/messages`, `/messages/:mid`, and `/code`), upstream
401/403 responses indicate a provider credential failure and return 502. An
upstream 429 returns 429 and preserves its `Retry-After` HTTP header when present;
other upstream failures return 502. Mail-Hub's own authentication still returns
401. Invalid JSON, explicit provider failure, and malformed message responses
are errors; only a valid successful empty list means no mail.

All three tenant read routes share the provider's `pollPerMinute` budget across
all inboxes in a rolling 60-second window. Each route-initiated `getMessages`
or `getMessage` operation spends one read before it runs, including cache hits
and failed reads. The budget counts provider operations, not network packets,
folders, token refreshes or internal reads such as a template `fromList` detail
loading its list cache. Once exhausted, a route returns 429 with `provider` and
`retryAfter` (the next available UTC timestamp) without calling the provider.
Administrative whole-mailbox endpoints retain their existing behavior.

A normal successful `/code` request that reads one list and one detail spends
two reads. At the existing 10 reads/minute limit, this allows roughly five such
code retrievals per minute per provider; empty waiting polls each spend another
read. Limits are unchanged. Clients must wait for budget capacity after 429;
summary extraction cannot bypass an exhausted detail budget.

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

**Errors**: 404, 429 (shared provider read budget or upstream rate limit), 502

---

### GET /api/inbox/:id/code — Extract Verification Code

Extract verification codes from the latest email, or opt into bounded matching for Outlook. Supports long-polling.

**Query parameters**:
| Param | Values | Description |
|-------|--------|-------------|
| `wait` | `true` | Long-poll until a message arrives (recommended) |
| `selection` | `latest` (default) / `matching` | `matching` is Outlook-only and skips candidates without the requested code type; unsupported values and non-Outlook matching return 400 |
| `timeout` | positive integer (default 60, capped at 120) | Request deadline in seconds, including provider reads; invalid or nonpositive values return 400 |
| `type` | `numeric` / `alphanumeric` / `link` | Filter code type |
| `since` | ISO datetime / epoch milliseconds | Only consider messages received after this timestamp |
| `excludeMessageId` | repeated string | Subtract these IDs from candidates in either selection mode; at most 20 supplied values, each at most 2048 UTF-16 code units, combined UTF-8 value bytes at most 8192. Over limits returns 400 without truncation; duplicates count toward limits |

In `selection=matching`, an unknown or empty `type` returns 400. Omitting it
accepts any existing extractor type; the extraction rules are unchanged.

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

**Latest behavior** (omitted `selection`, or `selection=latest`): When `wait=true`, polls every 3s for the first 20s, then every 5s until timeout. Returns immediately when any candidate message exists, and extracts only from the newest message. `since` remains a strict lower bound (`receivedAt > since`), so it excludes all equal timestamps. Use it only when a strictly later message is wanted.

**Repeated retrieval**: remember returned `messageId` values and append one
`excludeMessageId` parameter per ID, for example:
`GET /api/inbox/:id/code?selection=matching&wait=true&excludeMessageId=A&excludeMessageId=B`.
This can return a different code with the same received timestamp. Exclusions
only subtract from already eligible candidates; they never request a detail by
ID, enlarge the current provider window, or bypass owner, recipient or inbox
lifetime checks. They combine with `since` as an intersection, so an excluded
ID never changes its strict time bound. No server consumption state is stored.

The Outlook UI remembers only returned IDs in page memory, separately per inbox.
Continue retrieval waits with those exclusions while keeping the displayed result
available for review and copying. Copying does not consume it. At 20 remembered
IDs, continuing requires an explicit reset; no older IDs are silently evicted.
Resetting may return an earlier result. Refresh, logout or identity change clears
the page session; closing an inbox clears its IDs, including batch close. Other
tabs/windows have independent sessions. Bodies and credentials are never stored
in this ID map or persisted to local storage.

**Outlook matching**: `GET /api/inbox/:id/code?selection=matching&wait=true&timeout=30`
checks a bounded Inbox/Junk window in received-time descending order, with
code-unit ascending message ID ties. One request reads at most five upstream
list pages, 100 candidate metadata entries **before local recipient filtering**,
and five candidate details. These limits are shared across both folders, token
refresh retries and all waiting rounds. HTTP pages request 20 entries, alternate
between Inbox/Junk, and use bounded local To/Cc filtering. Duplicate IDs still
consume metadata budget before the merge. IMAP searches To/Cc first, then reads
bounded UID metadata pages and requires an exact envelope recipient match for
aliases. IMAP scans and their detail IDs are bound to UIDVALIDITY; a changed
mailbox generation returns an error instructing the caller to reload.
For IMAP exclusions, retain IDs returned by matching itself: generation-qualified
matching IDs differ from the legacy mailbox/UID IDs returned by latest/admin
listings, and are not interchangeable. IDs from the previous UIDVALIDITY must
never suppress mail in a new generation.

Each actual list page and each detail consumes one read from the existing shared
poll budget. HTTP scan pages have no automatic network retry and reject redirects;
continuations must use HTTPS, the exact API host, and the same mailbox folder path.
Successfully checked unmatched IDs are remembered only within that request, so
waiting rounds do not reread the same notifications. Waiting continues until a
code matches, any request cap is reached, the lease ends, or the deadline passes.
For a small empty window, another waiting round can observe newly arrived mail;
its list pages still consume the same request caps. Exhausting the page/metadata
budget ends waiting with explicit truncation rather than resetting the caps.
Every awaited read rechecks ownership, lease and recipient isolation. A provider
operation already in flight may finish after the deadline; its late code is
discarded and no further read begins. This does not cancel the upstream operation.

Matching retains `codes`, `email`, `messageId`, and `receivedAt`, and adds:
```json
{ "scan": { "checked": 2, "scope": "inbox_and_junk", "pages": 2,
  "metadata": 3, "complete": true, "truncated": false, "partial": false,
  "folders": [{ "folder": "Inbox", "complete": true },
              { "folder": "Junk", "complete": true }], "reason": "matched" } }
```
`reason` is `matched`, `window_exhausted`, `scan_limit`, or `timeout` on success;
scan read errors add `reason=error` to their 429/502 response.
`complete` describes only the current candidate window, never the entire mailbox;
a match with unvisited candidates or an incomplete folder has `complete=false`.
`truncated` reports an incomplete list window. `folders` reports each folder's
list exhaustion (IMAP uses actual folder paths); one exhausted folder cannot make
the whole window complete. Partial folder failures return an error with
`partial=true` and `complete=false`, without returning an unchecked code.
Reaching any cap with further candidates/pages returns empty codes,
`scan_limit`, and `complete=false`.
An exhausted window with `wait=false` returns empty codes and `window_exhausted`;
`wait=true` waits for matching content instead of stopping at a notification.
Successful matching results add `email.recipientAddress`: the exact inbox address
only when To/Cc evidence confirms it, otherwise `null`. The UI labels unknown
recipient attribution explicitly. Matching errors stop immediately: there is no
summary fallback and an older code cannot hide a detail failure. Upstream 429
preserves `Retry-After`; other upstream failures return the controlled read error.

For latest selection, an initial list failure returns an error immediately. Waiting retries may
continue after a temporary failure, but the last completed poll determines the
timeout result: a final failure returns an error; a successful empty list clears
an earlier failure. A 429 ends the wait immediately, and no poll starts after
the deadline. Inbox ownership/existence, lease and cancellation checks take
precedence over a simultaneous failure.

For latest selection, if the selected message's detail read has an ordinary failure (including an
upstream 503), code extraction may still use its summary. A detail 429 returns
the rate limit error; a missing or out-of-scope message returns the empty code
response. Summary fallback cannot bypass ownership or message lifetime checks.

**Errors**: 400 (invalid query or no polling support), 404, 429, 502

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
  "domainMode": "endpoint",
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
  "domainMode": "endpoint",
  "domains": ["dpptd.com", "exelica.com"]
}
```

**Errors**: 404, 502

Both provider detail and domain responses include the runtime `domainMode`:
`endpoint`, `static`, or `from_create`. These GET endpoints never create an
inbox or call an upstream create endpoint, including when a provider is
disabled or cooling down. Endpoint-based discovery may still fetch its
domain list and use its existing cache.

For `from_create` templates (including TempMail.lol and TempMail.ing),
`domains` contains the configured `domains.list`, or `[]` when none is known.
An empty list means the address and domain are decided at creation time;
it does not mean the provider is unavailable. Repeated reads do not probe
upstream or populate a domain cache. Use `POST /api/inbox` for a controlled
create whose returned inbox is saved normally.

---

### GET /api/dispatch/preview — Dry-run Auto-dispatch

The order a `POST /api/inbox` without `provider` would try providers in, and
why each one is or is not eligible right now. Pure local computation: nothing
upstream is called and nothing changes.

**Query**: `for` (target service, optional — omit for the global order),
`needPolling` (default `true`; `false` keeps providers that cannot poll).

**Response 200**:
```json
{
  "service": "twitter.com",
  "rule": { "source": "service", "others": "append" },
  "candidates": [
    { "provider": "outlook", "eligible": true },
    { "provider": "mailtm", "eligible": false, "reason": "cooldown",
      "cooldownReason": "rate-limit", "nextAvailableAt": "2026-10-12T09:15:00.000Z" },
    { "provider": "icloud", "eligible": false, "reason": "manual_only" }
  ],
  "note": "Blocked-domain filtering happens at create time and is not previewed."
}
```

`rule.source` is `service` (a rule for this service exists), `global` (only
the `*` rule) or `default` (nothing saved; trust order). `reason` is one of
`unknown_provider` (the rule names a provider that is not registered right
now, e.g. a disabled template), `disabled`, `manual_only` (auto-dispatch off
and not named by this service's rule), `no_polling`, `rate_limited`,
`cooldown`.

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

### Dispatch order

Auto-dispatch walks an explicit, operator-owned order and uses the first
provider that passes every gate (enabled, allowed to auto-dispatch, not
rate-limited or cooling down, create succeeds). There is no score.

- `*` is the global order. Without one, the **default order** applies:
  `trustLevel` descending, registration order for ties.
- Registered providers a rule does not list are appended in registration
  order, so a provider added later is never silently unreachable.
- A service rule's providers come first. `others: "append"` lets the rest
  follow in global order; `others: "exclude"` uses only the listed ones.
- A provider named by a service rule takes part even when its auto-dispatch is
  off (`*` does not count as naming it).
- A rule may keep names that are not registered right now (a disabled template
  keeps its position and comes back when re-enabled); the preview reports them
  as `unknown_provider`.

#### GET /api/dispatch/rules — List Rules

**Response 200**:
```json
{
  "defaultOrder": ["imap", "icloud", "outlook", "yyds", "mailtm", "..."],
  "rules": [
    { "service": "*", "order": ["outlook", "imap", "..."], "others": "append", "updatedAt": "2026-10-12T09:00:00Z" },
    { "service": "twitter.com", "order": ["outlook", "icloud"], "others": "exclude", "updatedAt": "2026-10-12T09:05:00Z" }
  ]
}
```

#### PUT /api/dispatch/rules/:service — Save a Rule

**Request**:
```json
{ "order": ["outlook", "icloud"], "others": "exclude" }
```

`order`: non-empty, no duplicates, every name known (registered, ever
registered, or already in this rule). `others`: `append` (default) or
`exclude`; forced to `append` for `*`. The service must not be an example
domain.

**Response 200**: the stored rule. **Errors**: 400 (validation), 403.

#### DELETE /api/dispatch/rules/:service — Delete a Rule

Idempotent. Deleting `*` restores the default order.

**Response 200**: `{ "ok": true }`

---

### PATCH /api/providers/:name — Update Provider

**Request** (JSON — all fields optional):
```json
{
  "enabled": true,
  "autoDispatch": false
}
```

**Response 200**:
```json
{ "ok": true, "enabled": true, "autoDispatch": false }
```

Sending the removed `priority` field returns **400**; dispatch order lives in
`/api/dispatch/rules`.

**Errors**: 400 (no valid fields, or `priority` present), 404

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

**Request** (JSON): Wrap the full provider config (see template schema) in `config`.
Optional `enabled` defaults to `true`; pass `false` to save a disabled template
without registering it for dispatch, including after a restart.

```json
{ "config": { "name": "custom-provider", "...": "full template config" }, "enabled": false }
```

The editor's connection test saves its `_test_...` configuration with
`enabled: false` and retains it afterward. Disabled templates can still run
the test pipeline and recover authentication. An administrator must enable
the compatible configuration before claiming a retained inbox.

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

Admin only. Runs getDomains (except `from_create`) → createInbox → getMessages.
The created account is retained. This endpoint never deletes the upstream
account, even when message reading or authentication fails. Generated
credentials and raw responses are stored privately before continuing; the
response includes safe `recovery` metadata whenever creation has a checkpoint.

**Response 200**:
```json
{
  "success": true,
  "steps": [
    { "step": "getDomains", "ok": true, "detail": "3 domains: a.com, b.com, c.com" },
    { "step": "createInbox", "ok": true, "detail": "Created: test@a.com" },
    { "step": "getMessages", "ok": true, "detail": "0 messages" }
  ],
  "recovery": {
    "id": "recovery-uuid",
    "provider": "mailtm",
    "phase": "ready",
    "address": "test@a.com",
    "createdAt": "2026-11-07T00:00:00.000Z",
    "updatedAt": "2026-11-07T00:00:01.000Z",
    "expiresAt": "2026-11-08T00:00:00.000Z",
    "claimedInboxId": null,
    "lastStatus": 200,
    "operationActive": false,
    "canRetry": false,
    "canClaim": true
  }
}
```

### GET /api/template-providers/:name/recoveries — List Retained Assets

Admin only. Returns `{ "recoveries": [...] }`, using the controlled metadata
shape above. Config snapshots, passwords, variables, authentication data, raw
responses, credential checkpoints, and operation IDs are never returned.
Listing remains available after the live template configuration is deleted.
`canRetry` and `canClaim` describe the asset state; claim also checks the current
template configuration. Ordinary API keys receive 403 on all recovery routes.

Phases: `attempting` (create started), `upstream_created` (account checkpoint),
`auth_pending` (authentication incomplete), `ready`, `claimed`, and
`outcome_unknown` (create may have committed; manual inspection required).
Recovery records survive inbox retention and keep their original expiry.

### POST /api/template-providers/:name/recoveries/:id/retry — Retry Authentication

Admin only. Takes no credential or configuration overrides. Uses the immutable
creation snapshot, original address, and saved password to repeat **only**
`postCreate`. It never calls create, domain discovery, or delete. It remains
available if the live template is changed, disabled, or deleted; claiming still
requires a compatible enabled live template.

The original authentication and retries share a persistent operation lease
(45 seconds) and a fixed 15-second network budget without automatic retries.
An active operation returns 409 without another network request, including
after a server restart. Expired or superseded responses may append private
credential checkpoints, but cannot overwrite current credentials or status.

Returns 200 `{ "recovery": { ... } }` after success. `ready` and `claimed` are
idempotent and perform no network calls. `outcome_unknown` returns 409 without
replaying creation. Local inbox expiry does not block authentication recovery
of the paid upstream account; expiry remains unchanged and claim still returns
410 for expired assets. Upstream HTTP errors keep their status (including 401, 429, and 503); invalid
JSON or missing/invalid credentials return 500. Errors use
`{ "error": "safe message", "recovery": { ... } }` when the asset is known.

### POST /api/template-providers/:name/recoveries/:id/claim — Claim a Ready Asset

Admin only. Takes no owner or credential overrides. Requires `ready`, original
expiry in the future, and an enabled current template with the same semantic
configuration fingerprint. Disabled, deleted, or changed templates return 409;
expiry returns 410. Both preserve the retained asset. Display labels and rate
limits do not affect the fingerprint.

One SQLite transaction inserts the inbox and permanently records its claimed
ID. The inbox is visible only to administrators (`owner_key` is null). Its
creation time and expiry come from the original account allocation, so recovery
does not grant a new lifetime. Returns 200:

```json
{
  "id": "inbox-id",
  "address": "test@a.com",
  "provider": "mailtm",
  "expiresAt": "2026-11-08T00:00:00.000Z",
  "recovery": { "id": "recovery-uuid", "phase": "claimed", "claimedInboxId": "inbox-id" }
}
```

Repeating claim returns the original inbox ID, including after the inbox row
has been purged. It never creates a second inbox or makes another upstream call.

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

**Query parameters**: `limit=1..100` (default 50) on the first page;
`pageToken=<nextPageToken>` for a continuation. The token fixes the original
page size, account and administrator identity.

**Response 200**:
```json
{
  "email": "user@outlook.com",
  "limit": 50,
  "truncated": false,
  "nextPageToken": null,
  "messages": [
    {
      "id": "msg-id",
      "from": "Steam <noreply@steampowered.com>",
      "subject": "Your Steam code",
      "excerpt": "",
      "receivedAt": "2026-07-27T14:03:11Z",
      "leaseId": "i-abc123",
      "leaseState": "lease",
      "recipientAddress": "user+ab12cd34@outlook.com",
      "recipientMatch": "exact"
    }
  ],
  "leases": [
    {
      "id": "i-abc123",
      "address": "user+ab12cd34@outlook.com",
      "targetService": "steam",
      "createdAt": "2026-07-27T14:02:00.000Z",
      "endedAt": null,
      "status": "active"
    }
  ]
}
```

`leaseId` and `leaseState` describe the **arrival time window**, independently
of the address the message was sent to. They are not proof of recipient ownership:

| `leaseState` | Meaning |
|---|---|
| `lease` | Arrived during `leaseId`'s window |
| `gap` | Arrived while the account sat idle between leases |
| `before` | Older than the account's first lease |
| `undated` | No parseable timestamp; kept rather than dropped |

A lease's window ends at the earliest valid `closed_at`, `expires_at` (including
an active row awaiting cleanup), or the moment the next lease took the account.

Admin mailbox lists and details also expose recipient evidence from the upstream
To/Cc fields (Graph/Outlook REST) or envelope (IMAP):

| Field | Meaning |
|---|---|
| `recipientMatch: "exact"` | One distinct recipient address is known |
| `recipientMatch: "multiple"` | More than one distinct recipient address is known; no single lease is claimed |
| `recipientMatch: "unknown"` | No usable recipient evidence; the account address is not substituted |
| `recipientAddress` | The single confirmed address for `exact`; omitted otherwise |

Addresses are deduplicated using ASCII case folding. These fields do not grant
access and are only added by the admin account-mailbox routes. A delayed message
to an old alias can have that alias as `recipientAddress` while `leaseId` names
the newer usage period. If old lease records were cleaned up, recipient evidence
remains available, but no deleted lease is reconstructed. Ordinary inbox routes
retain their recipient and lifetime isolation and do not expose internal raw
recipient metadata.

The UI displays mail receive times in the browser's local timezone to the second;
hovering or focusing a time reveals the UTC ISO instant and local timezone.
Missing/invalid timestamps remain unknown. Equal receive times use a stable ID
tie-break for display, which does not establish actual delivery order.

`limit` is the page size. `nextPageToken` is a random server-side continuation
ID, or `null` when the loaded history ends. Pass it back to this same account
route to load earlier mail; never supply a Microsoft URL. Each state retains
per-folder positions and unshown merged messages. Repeating a continuation
returns the same page and next token; a failed read leaves it available to retry.
State lives only in server memory, expires after 10 minutes and is limited to
100 active states with LRU eviction. Expired, evicted or mismatched tokens
require reloading the mailbox. No access token is stored in pagination state.

Graph/REST continuations validate the HTTPS host and folder path. IMAP retains
the folder UIDVALIDITY and backward UID boundary; changed UIDVALIDITY requires
a reload. Each upstream list page consumes the existing shared read budget.
IMAP history follows UID boundaries and sorts each returned page by receive
time. Imported/copied mail can have nonmonotonic INTERNALDATE values, so receive
times need not descend across pages; those existing messages are not discarded.
Normal token rotation performed by the history read preserves retry/cached-page
tokens; an external credential replacement still requires reloading.
New mail is obtained by refreshing without a token; continuing history does
not restart at the top. Upstream mail moves may change IDs or page ordering:
this is not a database snapshot and cannot promise zero omissions/duplicates.
The UI labels the loaded count, appends history, retains an expanded message
and keeps loaded results on retryable errors. Its local pager only paginates
already loaded results.

**Errors**: 403 (not admin), 404 (no such account), 429 (read budget/upstream
throttle), 502 (upstream error); invalid/expired continuation responses instruct
the administrator to reload.

---

### GET /api/outlook/accounts/:email/mailbox/:messageId — Mailbox Message Detail

Full content of one message from the account mailbox, not clipped to any lease.
Admin only.

**Response 200**: same shape as `GET /api/inbox/:id/messages/:mid`, plus the admin
`recipientAddress` and `recipientMatch` fields described above, and the same
temporal `leaseId` / `leaseState` classification as the mailbox list.

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

For large batches, use the [background task mode](#background-pool-tasks-admin)
to avoid reverse-proxy/Cloudflare request timeouts. The admin UI uses this mode.

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

Checks and renewals capture the account's client ID, refresh token and current
OAuth session when selected. A queued or in-flight result whose generation has
changed returns `unknown` without changing status, transport or check time.
Accounts with pending OAuth or a current exchange are also left untouched.
Scheduled invalid-account cleanup rechecks the same generation and requires an
unassigned short-term account that is still invalid before deleting it.

### POST /api/outlook/renew — Renew Tokens

Supports the same [background task mode](#background-pool-tasks-admin).

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

Received token responses are saved to private append-only credential history
before HTTP/shape validation or a generation check, including late responses,
error bodies and responses received after account deletion. A rotation becomes
current only after a conditional account update succeeds; a losing operation
returns `unknown` and cannot report a committed renewal. Storage failure also
returns `unknown` without changing the account. Check/renew results, background
summaries, OAuth status and logs do not expose this private history or tokens.

The SQLite connection uses WAL with `synchronous=FULL` so each commit requests
a WAL sync for issued tokens and created-account recovery assets. This depends
on the filesystem/device honoring synchronization calls; it is not an absolute
guarantee against physical storage failure. Syncing every commit can increase
write latency; production throughput has not been load-tested for this change.

### POST /api/outlook/oauth/start — Start Authorization Completion

Creates an authorization session for a pending account and returns an authorize URL. The default preset is the built-in Thunderbird public-client flow; `custom` keeps compatibility with user-provided OAuth app settings. After code exchange, Mail Hub validates real mailbox-read capability before finalizing the account. Thunderbird's IMAP-scoped token therefore completes as `token_status=valid` with `api_type=imap` even when Graph and Outlook REST reject it.

A manual start may replace a pending session. An unexpired exchange already in progress returns 409. Code exchange and callback errors only update the account's current, unexpired session while the account is unassigned.

Token-endpoint errors use fixed public messages; raw response/error text and
issued credentials remain in private history. Just-issued access tokens are
validated directly without an additional refresh-token exchange.

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

Only one request can exchange a pending session. Completed replay returns success without another exchange; failed or superseded sessions cannot reuse the code. When the token response contains only a refresh token, validation is deferred without making another refresh request. Issued credentials are retained privately even if the session becomes stale before the response arrives; status responses do not expose this checkpoint.

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

The `sessionId` form additionally requires the account's current, unexpired pending session. The email form retains its account eligibility checks.

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

Claims exclude accounts with a current, unexpired pending or exchanging session, so concurrent workers receive different accounts.

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

The claimed session must still be current, pending and unexpired, and its account must remain unassigned.

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

Reports require the current, unexpired pending session and an unassigned account. An exchanging, final or superseded session returns 409 without changing account state. Reporting automation `completed` does not complete the OAuth exchange.

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

## Background Pool Tasks (Admin)

The three endpoints `POST /api/outlook/check`, `POST /api/outlook/renew` and
`POST /api/yyds/check` accept `"background": true`. Selection works as before:
use `emails` for Outlook or `keys` for YYDS, or omit the selection for the whole
pool. Example:

```json
{ "background": true, "emails": ["user@outlook.com"] }
```

They immediately return **202** with a job snapshot, without waiting for any
upstream network request. Example:

```json
{
  "job": {
    "id": "task-uuid",
    "pool": "outlook",
    "kind": "outlook-check",
    "status": "running",
    "total": 1769,
    "completed": 0,
    "summary": { "valid": 0, "invalid": 0, "unknown": 0, "renewed": 0, "failed": 0 },
    "error": "",
    "createdAt": "2026-10-10T15:00:00.000Z",
    "updatedAt": "2026-10-10T15:00:00.000Z"
  }
}
```

Poll **GET /api/batch-jobs/:id** every two seconds for `{ "job": ... }`.
**GET /api/batch-jobs?pool=outlook** (or `yyds`) returns `{ "jobs": [...] }`
containing the most recent task for that pool, allowing a refreshed page to
reconnect. Both endpoints are admin-only and use `Cache-Control: no-store`.
Missing IDs return 404; an invalid pool returns 400.

`kind` is `outlook-check`, `outlook-renew` or `yyds-check`. Terminal states are
`completed`, `failed`, and `interrupted`. Progress and aggregate counts persist
in SQLite; credentials and per-account results are never saved in task records.
For renewal, `renewed` means a refresh token rotated and `failed` means it did
not rotate, matching the existing synchronous contract; capability counts
(`valid`/`invalid`/`unknown`) describe the mailbox check separately.

One task owns each pool at a time. An identical background start reuses the
running task; a different selection or action returns 409. Outlook checks and
renewals share that lock with the scheduled daily check. Infrastructure
failures remain unknown, preserving stored Outlook token status. Unexpected
processing errors yield `failed` after the workers settle, retaining completed
counts; arbitrary upstream error text is not included in task state.

Closing or refreshing the browser leaves the task running. Transient polling
errors are retried. If the server restarts, unfinished tasks become
`interrupted` with their last persisted counts; they are not automatically
replayed because token renewals may already have taken effect upstream. Start
a new task explicitly to retry. API calls that omit `background` retain their
original 200 response and per-account results, and still wait for completion;
they return 409 if another task already owns that pool.

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

Supports the same [background task mode](#background-pool-tasks-admin).
Network failures, 429 and 5xx responses are unknown and leave stored key status
unchanged.

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

Active address claims and exact To/Cc recipient checks use the same ASCII-only
case folding. Unicode characters remain distinct; missing recipient evidence
does not establish inbox ownership. Legacy address padding keeps its existing
trim behavior. Empty or whitespace-only stored addresses return the fixed
`404 Message not found` for lists, details and codes before any mailbox access.
Shared IMAP reads, including iCloud and Outlook aliases, reject an explicitly
empty recipient scope; administrator reads that omit the scope remain available.

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

Upstream delivery is tracked separately from local ownership. A complete,
successful Apple list records `upstream_active` (`1` active, `0` inactive,
`null` unverified) and `upstream_checked_at`. An inactive free address becomes
retired; an inactive assigned address keeps its inbox until release, then becomes
retired. Confirmed inactive addresses are excluded from allocation and the refill
target. Unverified addresses retain their existing behavior, including newly
reserved addresses until a list verifies them. Missing entries, failed lists and
partial lists do not establish activity. A later active result never automatically
returns a retired or retiring address to the free pool.

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

Each address includes nullable `upstream_active` and `upstream_checked_at` alongside
its local state and assignment. `upstream_checked_at` is a UTC timestamp of the last
complete list that explicitly included this address.

### GET /api/icloud/addresses/:hme/messages — Read an Address's Mail

Everything that has ever arrived at the address, unlike `GET /api/inbox/:id/messages`
which hides anything older than the inbox asking.

### GET /api/icloud/addresses/:hme/messages/:uid — Message Detail

### POST /api/icloud/addresses/:hme/retire — Retire a Burned Address

Deactivates it at Apple and never hands it out again. Refuses with `409` while
an inbox holds it. **The slot it occupies stays spent** — 750 is the lifetime
total for one Apple ID.

Each attempt claims a persistent operation with a fixed 120-second lease. A
currently running attempt returns `409` without contacting Apple. After a restart,
expired attempt, or legacy `retiring` row, retrying this endpoint first reads a
complete, positively successful Hide My Email list. A confirmed inactive alias
finishes locally without a deactivate request; a confirmed active alias permits
one deactivate request. Matching uses the account and anonymous ID, preserving
the local address if Apple has renamed it.

Missing aliases, malformed or partial lists, authentication failures, and network
errors leave recovery `retiring` and return `502` with an error beginning
`Retirement unresolved:`. A completed ambiguous attempt releases its own lease so
the administrator can retry verification immediately. An attempt that expires or
loses ownership returns `409`; its late responses cannot change a newer attempt
or report successful retirement. No retry automatically returns a recovering
address to the free pool. The bounded network sequence is at most 77.4 seconds
under the configured timeouts, and the lease is never extended across awaits.

For an initial free/retired address, an explicit rejection retains its previous
state, except that an address concurrently confirmed inactive remains retired.
An uncertain write result stays `retiring`. Deactivate requests are never retried
automatically; a local lease cannot establish exactly-once delivery at Apple.

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
  "version": "0.12.0",
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
  "currentVersion": "0.12.0",
  "latestVersion": "0.12.0",
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
