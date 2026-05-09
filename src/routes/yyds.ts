import { Hono } from 'hono';
import { allRows, getDb, getRow, logActivity } from '../db.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { importDelimited } from '../import-utils.js';
import { fetchWithTimeout } from '../utils.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../errors.js';

export const yydsRoutes = new Hono<AdminEnv>();
const log = createLogger('yyds-route');

yydsRoutes.use('/yyds/*', requireAdmin);

yydsRoutes.post('/yyds/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw: string = body.accounts || '';
  if (!raw.trim()) return c.json({ error: 'Missing required field: accounts' }, 400);

  const result = importDelimited(raw, 'yyds_accounts', ['api_key', 'name'], (parts) => {
    const apiKey = parts[0].trim();
    const name = (parts[1] || '').trim();
    if (!apiKey) return { skip: true, reason: `Empty line: ${parts[0]?.slice(0, 40)}` };
    return { values: [apiKey, name] };
  });
  if (result.imported > 0) logActivity('blue', `Imported ${result.imported} YYDS Mail keys`);
  return c.json({ ...result, errors: result.errors.slice(0, 20) });
});

yydsRoutes.get('/yyds/accounts', (c) => {
  const db = getDb();
  const accounts = db.prepare(
    `SELECT api_key, name, status, supports_wildcard, inbox_count, daily_calls, last_used_at, created_at
     FROM yyds_accounts ORDER BY created_at DESC`
  ).all();

  return c.json({ accounts });
});

yydsRoutes.delete('/yyds/accounts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = body.keys || [];
  if (!keys.length) return c.json({ error: 'Missing required field: keys' }, 400);

  const db = getDb();
  let deleted = 0;
  for (const key of keys) {
    db.prepare(`DELETE FROM yyds_accounts WHERE api_key = ?`).run(key);
    deleted++;
  }
  if (deleted > 0) logActivity('amber', `Deleted ${deleted} YYDS Mail keys`);
  return c.json({ deleted, requested: keys.length });
});

yydsRoutes.post('/yyds/check', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();

  let sql = `SELECT api_key FROM yyds_accounts`;
  if (body.keys?.length) {
    const placeholders = body.keys.map(() => '?').join(',');
    sql += ` WHERE api_key IN (${placeholders})`;
  }

  const rows = allRows<{ api_key: string }>(db, sql, ...(body.keys ?? []));

  const results: { key: string; valid: boolean }[] = [];
  for (const row of rows) {
    try {
      const res = await fetchWithTimeout('https://maliapi.215.im/v1/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': row.api_key },
        body: JSON.stringify({ localPart: '_probe', domain: '_check.invalid' }),
      });
      const valid = res.status !== 403 && res.status !== 401;
      db.prepare(`UPDATE yyds_accounts SET status = ? WHERE api_key = ?`).run(valid ? 'active' : 'invalid', row.api_key);
      results.push({ key: row.api_key, valid });
    } catch (error) {
      log.warn('YYDS key check request failed', { key: row.api_key, error: errorMessage(error) });
      db.prepare(`UPDATE yyds_accounts SET status = 'invalid' WHERE api_key = ?`).run(row.api_key);
      results.push({ key: row.api_key, valid: false });
    }
  }
  const validCount = results.filter((r) => r.valid).length;
  const invalidCount = results.filter((r) => !r.valid).length;
  logActivity('blue', `Batch checked YYDS keys: ${validCount} valid / ${invalidCount} invalid`);

  return c.json({
    checked: results.length,
    valid: validCount,
    invalid: invalidCount,
    results,
  });
});

yydsRoutes.get('/yyds/stats', (c) => {
  const db = getDb();
  const row = getRow<{
    total: number; active: number | null; invalid: number | null; disabled: number | null; total_inboxes: number | null;
  }>(db, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid,
      SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled,
      SUM(inbox_count) as total_inboxes
    FROM yyds_accounts
  `) ?? { total: 0, active: 0, invalid: 0, disabled: 0, total_inboxes: 0 };
  const daily = getRow<{ daily_used: number | null }>(
    db,
    `SELECT SUM(daily_calls) AS daily_used FROM yyds_accounts WHERE status = 'active'`,
  ) ?? { daily_used: 0 };
  const total = row.total || 0;
  const active = row.active || 0;
  const invalid = row.invalid || 0;
  const disabled = row.disabled || 0;
  const totalInboxes = row.total_inboxes || 0;
  const dailyUsed = daily.daily_used || 0;
  const dailyQuota = (active || 0) * 20000;

  return c.json({
    total: total || 0,
    active: active || 0,
    invalid: invalid || 0,
    disabled: disabled || 0,
    totalInboxes: totalInboxes || 0,
    dailyUsed,
    dailyQuota,
  });
});

yydsRoutes.patch('/yyds/accounts/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = body.keys || [];
  const enabled: boolean = body.enabled ?? true;
  if (!keys.length) return c.json({ error: 'Missing required field: keys' }, 400);

  const db = getDb();
  for (const key of keys) {
    db.prepare(`UPDATE yyds_accounts SET status = ? WHERE api_key = ?`).run(enabled ? 'active' : 'disabled', key);
  }
  logActivity('blue', `${enabled ? 'Enabled' : 'Disabled'} ${keys.length} YYDS keys`);
  return c.json({ updated: keys.length, enabled });
});

yydsRoutes.patch('/yyds/accounts/wildcard', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = body.keys || [];
  const wildcard: boolean = body.wildcard ?? false;
  if (!keys.length) return c.json({ error: 'Missing required field: keys' }, 400);

  const db = getDb();
  for (const key of keys) {
    db.prepare(`UPDATE yyds_accounts SET supports_wildcard = ? WHERE api_key = ?`).run(wildcard ? 1 : 0, key);
  }
  return c.json({ updated: keys.length, wildcard });
});
