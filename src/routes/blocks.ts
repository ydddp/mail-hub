import { Hono } from 'hono';
import { buildSetClause, getDb, getRow, logActivity } from '../db.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { errorMessage } from '../errors.js';

export const blockRoutes = new Hono<AdminEnv>();

blockRoutes.get('/blocks', (c) => {
  const db = getDb();
  const service = c.req.query('service');
  const domain = c.req.query('domain');

  let sql = 'SELECT id, service, domain, provider, blocked_at, reason FROM blocks WHERE 1=1';
  const params: unknown[] = [];

  if (service) {
    sql += ' AND service = ?';
    params.push(service);
  }
  if (domain) {
    sql += ' AND domain = ?';
    params.push(domain);
  }
  sql += ' ORDER BY blocked_at DESC LIMIT 200';

  const rows = db.prepare(sql).all(...params);

  return c.json({ blocks: rows });
});

blockRoutes.post('/blocks', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { service, domain, reason, provider } = body;

  if (!service || !domain) {
    return c.json({ error: 'service and domain are required' }, 400);
  }

  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO blocks (service, domain, provider, reason) VALUES (?, ?, ?, ?)`,
    ).run(service, domain, provider ?? null, reason ?? null);
    logActivity('rose', `Blocked domain ${domain} (${service})`);
    return c.json({ ok: true }, 201);
  } catch (e) {
    const message = errorMessage(e);
    if (message.includes('UNIQUE')) {
      return c.json({ error: 'Block record already exists' }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

blockRoutes.delete('/blocks/:id', requireAdmin, (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid block id' }, 400);
  const db = getDb();
  const row = getRow<{ service: string; domain: string }>(db, `SELECT service, domain FROM blocks WHERE id = ?`, id);
  db.prepare(`DELETE FROM blocks WHERE id = ?`).run(id);
  if (row) {
    logActivity('blue', `Unblocked domain ${row.domain} (${row.service})`);
  }
  return c.json({ ok: true });
});


blockRoutes.get('/block-rules', (c) => {
  const db = getDb();
  const rules = db.prepare(`SELECT id, service, provider, threshold, window_hours, scope, domain_level, enabled, created_at FROM block_rules ORDER BY created_at DESC`)
    .all();
  return c.json({ rules });
});

blockRoutes.post('/block-rules', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const service = body.service || '*';
  const provider = body.provider || '*';
  const threshold = parseInt(body.threshold, 10) || 3;
  const windowHours = parseInt(body.window_hours, 10) || 24;
  const scope = body.scope === 'global' ? 'global' : 'per_service';
  const domainLevel = Math.max(2, Math.min(parseInt(body.domain_level, 10) || 2, 5));

  const db = getDb();
  db.prepare(
    `INSERT INTO block_rules (service, provider, threshold, window_hours, scope, domain_level) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(service, provider, threshold, windowHours, scope, domainLevel);
  return c.json({ ok: true }, 201);
});

blockRoutes.patch('/block-rules/:id', requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();

  const clause = buildSetClause(body, {
    enabled: (v) => (v ? 1 : 0),
    threshold: (v) => parseInt(v as string, 10),
    window_hours: (v) => parseInt(v as string, 10),
    domain_level: (v) => Math.max(2, Math.min(parseInt(v as string, 10) || 2, 5)),
  });
  if (!clause) return c.json({ error: 'No valid fields' }, 400);
  const params = [...clause.params, id];
  db.prepare(`UPDATE block_rules SET ${clause.setClause} WHERE id = ?`).run(...params);
  return c.json({ ok: true });
});

blockRoutes.delete('/block-rules/:id', requireAdmin, (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const db = getDb();
  db.prepare(`DELETE FROM block_rules WHERE id = ?`).run(id);
  return c.json({ ok: true });
});
