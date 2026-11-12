# Outlook canonical folder continuations

Production read-only probes on 2026-11-12 observed these nextLink shapes:

- Graph: `/v1.0/me/mailFolders('<opaque-folder-id>')/messages?...&$top=20&$skip=20`.
- REST: `/api/v2.0/me/mailfolders/inbox/messages?...&$top=20&$skip=20`.

The exact-path validator rejected the real Graph response in both matching scans
and administrator history. Both consumers now accept the observed OData folder
key syntax for the same API and host, preserve Microsoft's paging query, and
rebuild the request on the configured Inbox/Junk URL. External hosts, account
paths, credentials, fragments, ports, cross-API paths and redirects remain
rejected. Status code contracts are unchanged.

Regression: the expanded existing scan/history tables and budget test failed
5 cases before the fix, then passed 77/77. Full suite: 67 files / 1912 tests
passed. TypeScript compilation and `git diff --check` passed.

Live comparison ran isolated DBs and application instances on hanabi, using the
same two existing production mailboxes and saved access tokens. No test emails,
upstream mailbox writes, account creations or production lease changes occurred.
The matching route used an isolated alias lease with no matching recipient, so
this verifies real metadata pagination, not receipt of a new verification code.

| Transport / operation | Old code | Fixed code |
| --- | --- | --- |
| Graph matching | 502, untrusted continuation on first list | 200, 5 pages / 95 metadata, scan_limit |
| Graph history | 502, untrusted continuation | 200, first and next pages each 20 messages |
| REST matching | 200 | 200, 4 pages / 61 metadata, complete |
| REST history | 200 | 200, first and next pages each 20 messages |

The production outbound proxy intermittently failed its Graph CONNECT with 502
during probing. Live comparisons therefore used direct Microsoft GETs; this is
a separate transport observation, not evidence that pagination fixes the proxy.

Private evidence and both OAuth responses (including rotated refresh tokens)
are retained on hanabi under
`/home/ydddp/mail-hub/data/verification/outlook-continuation-20261112/`
(directory 0700, credential files 0600). `baseline3-acceptance.json` and
`fixed4-acceptance.json` record the conclusive comparison. Failed/earlier
verification runs are retained. Local test/build logs are in
`tmp/outlook-continuation-20261112/`.
