# Mail Hub

[![Docker Pulls](https://img.shields.io/docker/pulls/ydddp/mail-hub)](https://github.com/ydddp/mail-hub/pkgs/container/mail-hub)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Multi-provider temporary email aggregation — unified API across 10+ email providers with auto-polling and verification code extraction.

[中文](README.md) | [API Docs](docs/API.md)

## Features

- **10+ Providers** — unified REST API, no need to integrate each provider individually
- **Smart Dispatch** — auto-selects best provider by trust level, rate limits, and blocked domains
- **Custom Providers** — add REST or GraphQL providers via Web UI, zero coding
- **Code Extraction** — auto-detect numeric, alphanumeric, and link-type verification codes
- **Pool Management** — Outlook / YYDS Mail / IMAP domain email at scale
- **Access Control** — API keys with admin/user tiers and daily quotas
- **Gmail Alias Generator** — dot-trick / +suffix / googlemail.com variants
- **Web Admin Panel** — dashboard, provider config, block table, system settings (Chinese/English)

## Quick Start

Requires Node.js 18+:

```bash
git clone https://github.com/ydddp/mail-hub.git
cd mail-hub
npm install
cp .env.example .env
# Edit .env, set API_SECRET
npm run dev
```

Open `http://localhost:3100` and log in with the `API_SECRET` from your `.env`.

## Deployment

### Docker

```bash
# Quick test
docker run -p 3100:3100 -e API_SECRET=your-secret ghcr.io/ydddp/mail-hub:latest

# Production (persistent data)
docker run -d \
  --name mail-hub \
  -p 3100:3100 \
  -v ./data:/app/data \
  -e API_SECRET=your-secret \
  --restart unless-stopped \
  ghcr.io/ydddp/mail-hub:latest
```

### Docker Compose

```bash
echo "API_SECRET=your-secret" > .env
docker compose up -d
```

### PM2

```bash
npm run build
pm2 start dist/index.js --name mail-hub
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_SECRET` | Recommended | — | Admin secret. Leave empty to grant admin to all requests (dev only) |
| `PORT` | No | `3100` | Server port |
| `HOST` | No | `0.0.0.0` | Listen address |
| `DB_PATH` | No | `./data/mail.db` | SQLite database path |
| `PROXY_URL` | No | — | Outbound proxy, supports http/https/socks5 |

See [.env.example](.env.example).

## Built-in Providers

### Template Providers

Shipped as built-in templates. Enable, disable, edit, or delete from the **Custom Providers** page in the admin panel:

| Provider | Default | Type | Retention |
|----------|---------|------|-----------|
| Mail.tm | ✅ | REST | Several days |
| Mail.gw | ✅ | REST | 8 days |
| TempMail.lol | ✅ | REST | 1 hour |
| TempMail.ing | ✅ | REST | 10 min |
| Temp-Mail.io | ✅ | REST | ~24 hours |
| Maildrop.cc | ✅ | GraphQL | ~24 hours (publicly readable) |
| Catchmail.io | ✅ | REST | 7 days |
| NiMail.cn | ✅ | REST | 10 min |
| Guerrilla Mail | ✅ | REST | 1 hour |
| Dropmail.me | ❌ | GraphQL | 10 min. Get a free token at [dropmail.me/api](https://dropmail.me/api/) and replace `PASTE_YOUR_TOKEN_HERE` in `apiBase`, then enable |

> Deleting a built-in template only removes the DB row. It reappears on restart.

### Hardcoded Providers

These are built into the code (not templates). Configurable via the **Provider Management** page, with dedicated management UIs (sidebar entries):

| Provider | Type | Description |
|----------|------|-------------|
| Outlook | Account Pool | Import Outlook accounts, 1:1 inbox assignment, returned to pool on close |
| YYDS Mail | API Key Pool | Import keys, round-robin rotation, 20,000 calls/day per key |
| IMAP Domain Email | Account Pool | Connect your own domain via IMAP with catch-all; highest trust level |

## Custom Providers

Add any REST or GraphQL email provider via the **Custom Providers** page — no code changes needed:

1. Click **New Provider**
2. Choose a preset from the dropdown:
   - **Two-step + Bearer** — Mail.tm style (create account first, then exchange for token)
   - **API Key Header** — global auth header (e.g. `X-Api-Key`)
   - **No Auth** — details reused from list response
   - **GraphQL POST + body** — Dropmail style (single URL for all operations via `{query: "..."}`)
3. Fill in the form or edit the JSON directly
4. **Test Connection** runs the full pipeline: getDomains → createInbox → getMessages → deleteInbox
5. Save — takes effect immediately, no restart needed

## Built-in Tools

**Gmail Alias Generator** (sidebar **Gmail Alias**): generates aliases via dot-trick, `+` suffix, and googlemail.com variants. All aliases deliver to the same inbox. Runs entirely in the browser. No configuration needed.

## API Overview

All `/api/*` endpoints require a Bearer token:

```
Authorization: Bearer <your-api-secret-or-api-key>
```

```bash
# Create inbox
curl -X POST http://localhost:3100/api/inboxes \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"for": "twitter.com"}'

# Get messages
curl http://localhost:3100/api/inboxes/{id}/messages \
  -H "Authorization: Bearer YOUR_KEY"

# Extract verification code (with long-polling)
curl "http://localhost:3100/api/inboxes/{id}/code?wait=true" \
  -H "Authorization: Bearer YOUR_KEY"

# Report result
curl -X POST http://localhost:3100/api/inboxes/{id}/report \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"success": true, "service": "twitter.com"}'

# Close inbox
curl -X DELETE http://localhost:3100/api/inboxes/{id} \
  -H "Authorization: Bearer YOUR_KEY"
```

Typical workflow: `Create → Extract code → Report → Close`

Full API reference: [docs/API.md](docs/API.md)
AI/LLM integration: `GET /v1/llms.txt` (no auth required)

## License

[AGPL-3.0-or-later](LICENSE)
