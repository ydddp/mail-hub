import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { allRows, buildSetClause, getDb, logActivity } from '../db.js';
import { config } from '../config.js';
import { hashApiKey, encryptApiKey, decryptApiKey } from '../crypto.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { todayDateString } from '../utils.js';

export const keyRoutes = new Hono<AdminEnv>();

keyRoutes.use('/keys', requireAdmin);
keyRoutes.use('/keys/*', requireAdmin);

keyRoutes.post('/keys', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = body.name?.trim();
  if (!name) return c.json({ error: 'Missing required field: name' }, 400);

  const plainKey = 'mk_' + nanoid(32);
  const keyHash = hashApiKey(plainKey);
  const keyEncrypted = config.apiSecret ? encryptApiKey(plainKey, config.apiSecret) : '';
  const db = getDb();
  db.prepare(`INSERT INTO api_keys (key, key_encrypted, name) VALUES (?, ?, ?)`).run(keyHash, keyEncrypted, name);
  logActivity('blue', `Created API key ${name}`);

  return c.json({ key: plainKey, keyHash, name, callCount: 0, lastUsedAt: null, active: true }, 201);
});

keyRoutes.get('/keys', (c) => {
  const db = getDb();
  const rows = allRows<{
    key: string;
    key_encrypted: string;
    name: string;
    call_count: number | null;
    last_used_at: string | null;
    created_at: string;
    active: number;
    daily_limit: number | null;
    daily_calls: number;
    daily_reset_at: string | null;
  }>(db,
    `SELECT key, key_encrypted, name, call_count, last_used_at, created_at, active, daily_limit, daily_calls, daily_reset_at FROM api_keys ORDER BY created_at DESC`
  );

  const today = todayDateString();
  const keys = rows.map((row) => ({
    key: row.key_encrypted && config.apiSecret
      ? (decryptApiKey(row.key_encrypted, config.apiSecret) ?? '(cannot decrypt)')
      : '(not encrypted)',
    keyHash: row.key,
    name: row.name,
    callCount: row.call_count || 0,
    dailyLimit: row.daily_limit,
    dailyCalls: row.daily_reset_at?.startsWith(today) ? row.daily_calls : 0,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    active: !!row.active,
  }));

  return c.json({ keys });
});

keyRoutes.patch('/keys/:key', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();

  const exists = db.prepare(`SELECT key FROM api_keys WHERE key = ?`).get(key);
  if (!exists) {
    return c.json({ error: 'Key not found' }, 404);
  }

  const clause = buildSetClause(body, {
    name: (v) => (v as string).trim(),
    active: (v) => (v ? 1 : 0),
    dailyLimit: (v) => (v === null || v === '' ? null : Math.max(1, parseInt(v as string, 10) || 0)),
  });
  if (clause) {
    db.prepare(`UPDATE api_keys SET ${clause.setClause} WHERE key = ?`).run(...clause.params, key);
  }

  return c.json({ ok: true });
});

keyRoutes.delete('/keys/:key', (c) => {
  const key = c.req.param('key');
  const db = getDb();
  db.prepare(`DELETE FROM api_keys WHERE key = ?`).run(key);
  return c.json({ ok: true });
});
