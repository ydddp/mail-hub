import { parseTimestamp, toUtcIso, utcFields } from '../time.js';
import { Hono } from 'hono';
import { allRows, getDb, getRow } from '../db.js';
import { requireAdmin, type AdminEnv } from './admin.js';

export const serviceRoutes = new Hono<AdminEnv>();

serviceRoutes.use('/services', requireAdmin);
serviceRoutes.use('/services/*', requireAdmin);

type ServiceEntry = {
  name: string;
  totalInboxes: number;
  activeInboxes: number;
  successCount: number;
  failCount: number;
  blockCount: number;
  firstUsed: string | null;
  lastUsed: string | null;
};

serviceRoutes.get('/services', (c) => {
  const db = getDb();

  // Durable cumulative counters — survive the retention purge of inboxes/fail_log.
  const statRows = allRows<{ name: string; inbox_count: number; success_count: number; fail_count: number; first_used_at: string | null; last_used_at: string | null }>(db, `
    SELECT name, inbox_count, success_count, fail_count, first_used_at, last_used_at FROM service_stats
  `);

  // Live view over still-retained inboxes (active counts only exist here).
  const inboxRows = allRows<{ name: string; total_inboxes: number; active_inboxes: number | null; last_used: string }>(db, `
    SELECT target_service AS name,
      COUNT(*) AS total_inboxes,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_inboxes,
      MAX(created_at) AS last_used
    FROM inboxes WHERE target_service IS NOT NULL AND target_service != ''
    GROUP BY target_service
  `);

  const blockRows = allRows<{ service: string; block_count: number }>(db, `SELECT service, COUNT(*) AS block_count FROM blocks WHERE service != '*' GROUP BY service`);
  const blockMap = new Map(blockRows.map(r => [r.service, r.block_count]));

  const merged = new Map<string, ServiceEntry>();
  for (const s of statRows) {
    merged.set(s.name, {
      name: s.name,
      totalInboxes: s.inbox_count,
      activeInboxes: 0,
      successCount: s.success_count,
      failCount: s.fail_count,
      blockCount: blockMap.get(s.name) || 0,
      firstUsed: s.first_used_at,
      lastUsed: s.last_used_at,
    });
  }
  for (const r of inboxRows) {
    const entry = merged.get(r.name);
    if (entry) {
      entry.activeInboxes = r.active_inboxes || 0;
      // Cumulative counter can lag live rows only for pre-stats DBs; never undercount.
      entry.totalInboxes = Math.max(entry.totalInboxes, r.total_inboxes);
      if (!entry.lastUsed || parseTimestamp(r.last_used) > parseTimestamp(entry.lastUsed)) entry.lastUsed = r.last_used;
    } else {
      merged.set(r.name, {
        name: r.name,
        totalInboxes: r.total_inboxes,
        activeInboxes: r.active_inboxes || 0,
        successCount: 0,
        failCount: 0,
        blockCount: blockMap.get(r.name) || 0,
        firstUsed: null,
        lastUsed: r.last_used,
      });
    }
  }

  const services = [...merged.values()].sort((a, b) => (parseTimestamp(b.lastUsed) || 0) - (parseTimestamp(a.lastUsed) || 0));

  const totalInboxes = services.reduce((s, r) => s + r.totalInboxes, 0);
  const totalFailures = services.reduce((s, r) => s + r.failCount, 0);
  const totalBlocks = blockRows.reduce((s, r) => s + r.block_count, 0);

  return c.json({
    summary: { totalServices: services.length, totalInboxes, totalFailures, totalBlocks },
    services: services.map((row) => utcFields(row, 'firstUsed', 'lastUsed')),
  });
});

serviceRoutes.get('/services/:name', (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const db = getDb();

  const stats = getRow<{ inbox_count: number; success_count: number; fail_count: number; first_used_at: string | null; last_used_at: string | null }>(
    db,
    `SELECT inbox_count, success_count, fail_count, first_used_at, last_used_at FROM service_stats WHERE name = ?`,
    name,
  );

  const inboxes = db.prepare(
    `SELECT id, provider, address, status, created_at FROM inboxes WHERE target_service = ? ORDER BY created_at DESC LIMIT 50`
  ).all(name);

  const failures = db.prepare(
    `SELECT provider, domain, reported_at FROM fail_log WHERE service = ? ORDER BY reported_at DESC LIMIT 50`
  ).all(name);

  const blocks = db.prepare(
    `SELECT id, domain, provider, blocked_at, reason FROM blocks WHERE service = ? ORDER BY blocked_at DESC`
  ).all(name);

  return c.json({
    name,
    stats: stats ? {
      totalInboxes: stats.inbox_count,
      successCount: stats.success_count,
      failCount: stats.fail_count,
      firstUsed: toUtcIso(stats.first_used_at),
      lastUsed: toUtcIso(stats.last_used_at),
    } : null,
    inboxes: inboxes.map((row) => utcFields(row, 'created_at')),
    failures: failures.map((row) => utcFields(row, 'reported_at')),
    blocks: blocks.map((row) => utcFields(row, 'blocked_at')),
  });
});
