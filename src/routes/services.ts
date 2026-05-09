import { Hono } from 'hono';
import { allRows, getDb } from '../db.js';
import { requireAdmin, type AdminEnv } from './admin.js';

export const serviceRoutes = new Hono<AdminEnv>();

serviceRoutes.use('/services', requireAdmin);
serviceRoutes.use('/services/*', requireAdmin);

serviceRoutes.get('/services', (c) => {
  const db = getDb();

  const inboxRows = allRows<{ name: string; total_inboxes: number; active_inboxes: number | null; last_used: string }>(db, `
    SELECT target_service AS name,
      COUNT(*) AS total_inboxes,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_inboxes,
      MAX(created_at) AS last_used
    FROM inboxes WHERE target_service IS NOT NULL AND target_service != ''
    GROUP BY target_service ORDER BY last_used DESC
  `);

  const failRows = allRows<{ service: string; fail_count: number }>(db, `SELECT service, COUNT(*) AS fail_count FROM fail_log GROUP BY service`);

  const blockRows = allRows<{ service: string; block_count: number }>(db, `SELECT service, COUNT(*) AS block_count FROM blocks WHERE service != '*' GROUP BY service`);

  const failMap = new Map(failRows.map(r => [r.service, r.fail_count]));
  const blockMap = new Map(blockRows.map(r => [r.service, r.block_count]));

  const services = inboxRows.map(r => ({
    name: r.name,
    totalInboxes: r.total_inboxes,
    activeInboxes: r.active_inboxes || 0,
    failCount: failMap.get(r.name) || 0,
    blockCount: blockMap.get(r.name) || 0,
    lastUsed: r.last_used,
  }));

  const totalInboxes = services.reduce((s, r) => s + r.totalInboxes, 0);
  const totalFailures = failRows.reduce((s, r) => s + r.fail_count, 0);
  const totalBlocks = blockRows.reduce((s, r) => s + r.block_count, 0);

  return c.json({
    summary: { totalServices: services.length, totalInboxes, totalFailures, totalBlocks },
    services,
  });
});

serviceRoutes.get('/services/:name', (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const db = getDb();

  const inboxes = db.prepare(
    `SELECT id, provider, address, status, created_at FROM inboxes WHERE target_service = ? ORDER BY created_at DESC LIMIT 50`
  ).all(name);

  const failures = db.prepare(
    `SELECT provider, domain, reported_at FROM fail_log WHERE service = ? ORDER BY reported_at DESC LIMIT 50`
  ).all(name);

  const blocks = db.prepare(
    `SELECT id, domain, provider, blocked_at, reason FROM blocks WHERE service = ? ORDER BY blocked_at DESC`
  ).all(name);

  return c.json({ name, inboxes, failures, blocks });
});
