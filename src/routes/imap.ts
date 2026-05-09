import { Hono } from 'hono';
import { buildSetClause, getDb, getRow, logActivity } from '../db.js';
import type { AdminEnv } from './admin.js';
import { testImapConnection } from '../providers/imap.js';
import { randomUUID } from 'crypto';

interface ImapAccountRow {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  domain: string;
  tls: number;
}

export const imapRoutes = new Hono<AdminEnv>();

imapRoutes.use('/imap/*', async (c, next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
});

imapRoutes.get('/imap/accounts', (c) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, host, port, domain, user, status, tls, last_checked_at, created_at FROM imap_accounts ORDER BY created_at DESC`
  ).all();
  return c.json({ accounts: rows });
});

imapRoutes.get('/imap/accounts/:id', (c) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, host, port, domain, user, status, tls, last_checked_at, created_at FROM imap_accounts WHERE id = ?`
  ).get(c.req.param('id'));
  if (!row) return c.json({ error: 'Account not found' }, 404);
  return c.json({ account: row });
});

imapRoutes.post('/imap/accounts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { host, port = 993, user, password, domain, tls = 1 } = body;

  if (!host || !user || !password || !domain) {
    return c.json({ error: 'Missing required fields: host, user, password, domain' }, 400);
  }

  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO imap_accounts (id, host, port, user, password, domain, tls) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, host, port, user, password, domain, tls ? 1 : 0);

  logActivity('green', `Added IMAP account ${user}@${host} for domain ${domain}`);
  return c.json({ account: { id, host, port, user, domain, tls, status: 'active' } }, 201);
});

imapRoutes.put('/imap/accounts/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM imap_accounts WHERE id = ?`).get(c.req.param('id'));
  if (!existing) return c.json({ error: 'Account not found' }, 404);

  const clause = buildSetClause(body, {
    host: (v) => v,
    user: (v) => v,
    password: (v) => v,
    domain: (v) => v,
    port: (v) => v,
    tls: (v) => (v ? 1 : 0),
    status: (v) => v,
  });
  if (!clause) return c.json({ error: 'No fields to update' }, 400);
  const params = [...clause.params, c.req.param('id')];
  db.prepare(`UPDATE imap_accounts SET ${clause.setClause} WHERE id = ?`).run(...params);
  logActivity('blue', `Updated IMAP account ${c.req.param('id')}`);

  return c.json({ ok: true });
});

imapRoutes.delete('/imap/accounts/:id', (c) => {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM imap_accounts WHERE id = ?`).get(c.req.param('id'));
  if (!existing) return c.json({ error: 'Account not found' }, 404);

  db.prepare(`DELETE FROM imap_accounts WHERE id = ?`).run(c.req.param('id'));
  logActivity('rose', `Removed IMAP account ${c.req.param('id')}`);
  return c.json({ ok: true });
});

imapRoutes.post('/imap/accounts/:id/test', async (c) => {
  const db = getDb();
  const row = getRow<ImapAccountRow>(
    db,
    `SELECT id, host, port, user, password, domain, tls FROM imap_accounts WHERE id = ?`,
    c.req.param('id'),
  );
  if (!row) return c.json({ error: 'Account not found' }, 404);

  const result = await testImapConnection({
    id: row.id,
    host: row.host,
    port: row.port,
    user: row.user,
    password: row.password,
    domain: row.domain,
    tls: row.tls,
    status: 'active',
  });

  db.prepare(`UPDATE imap_accounts SET last_checked_at = datetime('now') WHERE id = ?`).run(row.id);

  if (result.ok) {
    logActivity('green', `IMAP connection test OK for ${row.user}@${row.host}`);
  } else {
    logActivity('rose', `IMAP connection test FAILED for ${row.user}@${row.host}: ${result.error}`);
  }

  return c.json(result);
});

imapRoutes.get('/imap/stats', (c) => {
  const db = getDb();
  const total = getRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM imap_accounts`)?.c ?? 0;
  const active = getRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM imap_accounts WHERE status = 'active'`)?.c ?? 0;
  return c.json({ total, active });
});
