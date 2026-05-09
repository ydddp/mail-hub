import { Hono } from 'hono';
import { allRows, getDb, getRow, getSetting, logActivity, setSetting } from '../db.js';
import { checkToken, renewToken } from '../providers/outlook.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { importDelimited } from '../import-utils.js';

export function parseCredentials(parts: string[]): { clientId: string; refreshToken: string } {
  const fields = parts.slice(2).map(s => s.trim()).filter(Boolean);
  let clientId = '';
  let refreshToken = '';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const f of fields) {
    if (!clientId && uuidPattern.test(f)) {
      clientId = f;
    } else if (!refreshToken && f.length > 50) {
      refreshToken = f;
    }
  }
  if (!clientId && !refreshToken && fields.length >= 2) {
    clientId = fields[fields.length - 1];
    refreshToken = fields[fields.length - 2];
  } else if (!clientId && fields.length >= 1) {
    clientId = fields[0];
  } else if (!refreshToken && fields.length >= 1) {
    for (const f of fields) {
      if (f !== clientId) { refreshToken = f; break; }
    }
  }
  return { clientId, refreshToken };
}

export const outlookRoutes = new Hono<AdminEnv>();

outlookRoutes.use('/outlook/*', requireAdmin);

outlookRoutes.post('/outlook/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw: string = body.accounts || '';
  if (!raw.trim()) return c.json({ error: 'Missing required field: accounts' }, 400);

  const accountType = body.type === 'short' ? 'short' : 'long';
  const groupName = body.group || (accountType === 'long' ? 'Manual import' : 'Ungrouped');

  const result = importDelimited(raw, 'outlook_accounts', ['email', 'password', 'client_id', 'refresh_token', 'account_type', 'group_name'], (parts, line) => {
    if (parts.length < 2) return { skip: true, reason: `Invalid format: ${line.slice(0, 40)}` };
    const email = parts[0].trim();
    const password = parts[1].trim();
    const { clientId, refreshToken } = parseCredentials(parts);
    if (!email || !password) return { skip: true, reason: `Email or password is empty: ${line.slice(0, 40)}` };
    return { values: [email, password, clientId, refreshToken, accountType, groupName] };
  });
  if (result.imported > 0) logActivity('blue', `Imported ${result.imported} Outlook accounts`);
  return c.json({ ...result, errors: result.errors.slice(0, 20) });
});

outlookRoutes.get('/outlook/accounts', (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const available = c.req.query('available');
  const group = c.req.query('group');

  const type = c.req.query('type');

  let sql = `SELECT oa.email, oa.token_status, oa.assigned_inbox_id, oa.group_name, oa.account_type, oa.created_at, oa.token_renewed_at, oa.last_checked_at,
             (SELECT id FROM inboxes WHERE provider='outlook' AND address=oa.email ORDER BY created_at DESC LIMIT 1) as last_inbox_id
             FROM outlook_accounts oa WHERE 1=1`;
  const conditions: string[] = [];
  const params: string[] = [];

  if (status) {
    conditions.push(`token_status = ?`);
    params.push(status);
  }
  if (available === 'true') conditions.push(`assigned_inbox_id IS NULL`);
  if (available === 'false') conditions.push(`assigned_inbox_id IS NOT NULL`);
  if (group) {
    conditions.push(`group_name = ?`);
    params.push(group);
  }
  if (type) {
    conditions.push(`account_type = ?`);
    params.push(type);
  }

  if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const accounts = db.prepare(sql).all(...params);

  return c.json({ accounts });
});

outlookRoutes.delete('/outlook/accounts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const emails: string[] = body.emails || [];
  if (!emails.length) return c.json({ error: 'Missing required field: emails' }, 400);

  const db = getDb();
  let deleted = 0;
  for (const email of emails) {
    const row = getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM outlook_accounts WHERE email = ? AND assigned_inbox_id IS NULL`,
      email,
    ) ?? { count: 0 };
    const count = row.count;
    if (count > 0) {
      db.prepare(`DELETE FROM outlook_accounts WHERE email = ? AND assigned_inbox_id IS NULL`).run(email);
      deleted++;
    }
  }
  return c.json({ deleted, requested: emails.length });
});

outlookRoutes.post('/outlook/check', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();

  let sql = `SELECT email, client_id, refresh_token FROM outlook_accounts`;
  if (body.emails?.length) {
    const placeholders = body.emails.map(() => '?').join(',');
    sql += ` WHERE email IN (${placeholders})`;
  }

  const rows = allRows<{ email: string; client_id: string; refresh_token: string }>(db, sql, ...(body.emails ?? []));

  const results: { email: string; valid: boolean }[] = [];
  for (const row of rows) {
    if (!row.client_id || !row.refresh_token) {
      db.prepare(`UPDATE outlook_accounts SET token_status = 'no_token' WHERE email = ?`).run(row.email);
      results.push({ email: row.email, valid: false });
      continue;
    }
    const valid = await checkToken(row.email, row.client_id, row.refresh_token);
    db.prepare(`UPDATE outlook_accounts SET token_status = ? WHERE email = ?`).run(valid ? 'valid' : 'invalid', row.email);
    results.push({ email: row.email, valid });
  }

  return c.json({
    checked: results.length,
    valid: results.filter((r) => r.valid).length,
    invalid: results.filter((r) => !r.valid).length,
    results,
  });
});

outlookRoutes.post('/outlook/renew', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();

  let sql = `SELECT email, client_id, refresh_token FROM outlook_accounts`;
  if (body.emails?.length) {
    const placeholders = body.emails.map(() => '?').join(',');
    sql += ` WHERE email IN (${placeholders})`;
  }

  const rows = allRows<{ email: string; client_id: string; refresh_token: string }>(db, sql, ...(body.emails ?? []));

  const results: { email: string; renewed: boolean }[] = [];
  for (const row of rows) {
    if (!row.client_id || !row.refresh_token) {
      results.push({ email: row.email, renewed: false });
      continue;
    }
    const result = await renewToken(row.client_id, row.refresh_token);
    if (result) {
      db.prepare(
        `UPDATE outlook_accounts SET refresh_token = ?, token_status = 'valid', token_renewed_at = datetime('now') WHERE email = ?`,
      ).run(result.newRefreshToken, row.email);
      results.push({ email: row.email, renewed: true });
    } else {
      db.prepare(`UPDATE outlook_accounts SET token_status = 'invalid' WHERE email = ?`).run(row.email);
      results.push({ email: row.email, renewed: false });
    }
  }

  return c.json({
    total: results.length,
    renewed: results.filter((r) => r.renewed).length,
    failed: results.filter((r) => !r.renewed).length,
    results,
  });
});

outlookRoutes.get('/outlook/stats', (c) => {
  const db = getDb();
  const row = getRow<{
    total: number;
    available: number | null;
    assigned: number | null;
    valid_token: number | null;
    invalid_token: number | null;
    long_count: number | null;
    short_count: number | null;
  }>(db, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN assigned_inbox_id IS NULL THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN assigned_inbox_id IS NOT NULL THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN token_status = 'valid' THEN 1 ELSE 0 END) as valid_token,
      SUM(CASE WHEN token_status = 'invalid' THEN 1 ELSE 0 END) as invalid_token,
      SUM(CASE WHEN account_type = 'long' THEN 1 ELSE 0 END) as long_count,
      SUM(CASE WHEN account_type = 'short' THEN 1 ELSE 0 END) as short_count
    FROM outlook_accounts
  `) ?? { total: 0, available: 0, assigned: 0, valid_token: 0, invalid_token: 0, long_count: 0, short_count: 0 };
  return c.json({
    total: row.total || 0,
    available: row.available || 0,
    assigned: row.assigned || 0,
    validToken: row.valid_token || 0,
    invalidToken: row.invalid_token || 0,
    longCount: row.long_count || 0,
    shortCount: row.short_count || 0,
  });
});

outlookRoutes.get('/outlook/settings', (c) => {
  return c.json({
    recordFailService: getSetting('outlook_record_fail_service') !== '0',
  });
});

outlookRoutes.patch('/outlook/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.recordFailService === 'boolean') {
    const val = body.recordFailService ? '1' : '0';
    setSetting('outlook_record_fail_service', val);
  }
  return c.json({ ok: true });
});
