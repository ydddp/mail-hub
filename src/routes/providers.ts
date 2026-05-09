import { Hono } from 'hono';
import { registry } from '../providers/registry.js';
import { rateLimiter } from '../rate-limiter.js';
import { buildSetClause, getDb, getRow } from '../db.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../errors.js';

export const providerRoutes = new Hono<AdminEnv>();
const log = createLogger('providers-route');

providerRoutes.get('/providers', (c) => {
  const metas = registry.listMeta();
  const providers = metas.map((m) => ({
    ...m,
    rateStatus: rateLimiter.getCreateStatus(m.name),
  }));
  return c.json({ providers });
});

providerRoutes.get('/providers/:name', async (c) => {
  const name = c.req.param('name');
  const provider = registry.get(name);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  const cfg = registry.getConfig(name);
  const rateStatus = rateLimiter.getCreateStatus(name);

  let domains: string[] = [];
  try {
    domains = await provider.getDomains();
  } catch (error) {
    log.warn('failed to fetch provider domains', { provider: name, error: errorMessage(error) });
  }

  const db = getDb();
  let stats = { success_count: 0, fail_count: 0, last_success_at: null, last_error_at: null, last_error: null };
  const row = getRow<{
    success_count: number | null;
    fail_count: number | null;
    last_success_at: null;
    last_error_at: null;
    last_error: null;
  }>(db,
    `SELECT success_count, fail_count, last_success_at, last_error_at, last_error
     FROM provider_stats WHERE provider = ?`,
    name,
  );
  if (row) {
    stats = {
      success_count: row.success_count || 0,
      fail_count: row.fail_count || 0,
      last_success_at: row.last_success_at,
      last_error_at: row.last_error_at,
      last_error: row.last_error,
    };
  }

  return c.json({
    ...provider.meta,
    ...cfg,
    domains,
    rateStatus,
    stats,
  });
});

providerRoutes.patch('/providers/:name', requireAdmin, async (c) => {
  const name = c.req.param('name');
  const provider = registry.get(name);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const db = getDb();

  const clause = buildSetClause(body, {
    enabled: (v) => (v ? 1 : 0),
    priority: (v) => v,
    autoDispatch: (v) => (v ? 1 : 0),
  });
  if (!clause) return c.json({ error: 'No valid fields to update' }, 400);
  const setClause = clause.setClause + ", updated_at = datetime('now')";
  const params = [...clause.params, name];
  db.prepare(`UPDATE provider_config SET ${setClause} WHERE provider = ?`).run(...params);

  return c.json({ ok: true, ...registry.getConfig(name) });
});

providerRoutes.get('/providers/:name/domains', async (c) => {
  const name = c.req.param('name');
  const provider = registry.get(name);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  try {
    const domains = await provider.getDomains();
    return c.json({ provider: name, domains });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});
