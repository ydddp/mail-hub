import { Hono } from 'hono';
import { existsSync, statSync } from 'fs';
import { allRows, DEFAULT_SETTINGS, backupDb, deleteBackup, getDb, getSetting, listBackups, setSetting } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { APP_VERSION } from '../version.js';
import { rescheduleBackup } from '../backup-scheduler.js';

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];

function normalizeSettingValue(key: keyof typeof DEFAULT_SETTINGS, value: unknown): string {
  if (key === 'backup_enabled') return value === '0' || value === false ? '0' : '1';
  if (key === 'proxy_url') return String(value ?? '').trim();
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SETTINGS[key];
  return String(Math.min(n, key === 'backup_interval_hours' ? 24 * 30 : 10000));
}

export const settingsRoutes = new Hono<AdminEnv>();

settingsRoutes.use('/admin/*', requireAdmin);

settingsRoutes.get('/admin/settings', (c) => {
  const db = getDb();
  const rows = allRows<{
    key: string;
    value: string;
    updated_at: string;
  }>(db, `SELECT key, value, updated_at FROM settings`);
  const settings: Record<string, string> = { ...DEFAULT_SETTINGS };
  const updatedAt: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
    updatedAt[row.key] = row.updated_at;
  }
  return c.json({ settings, defaults: DEFAULT_SETTINGS, updatedAt, env: { proxyUrl: config.proxyUrl } });
});

settingsRoutes.patch('/admin/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updates = body.settings && typeof body.settings === 'object' ? body.settings : body;
  const saved: Record<string, string> = {};
  let backupScheduleChanged = false;
  for (const key of SETTING_KEYS) {
    if (updates[key] === undefined) continue;
    const value = normalizeSettingValue(key, updates[key]);
    setSetting(key, value);
    saved[key] = value;
    if (key === 'backup_enabled' || key === 'backup_interval_hours') {
      backupScheduleChanged = true;
    }
  }
  if (backupScheduleChanged) {
    rescheduleBackup('settings updated');
  }
  return c.json({ ok: true, settings: saved });
});

settingsRoutes.post('/admin/backup', async (c) => {
  const backup = await backupDb();
  return c.json({ ok: true, backup });
});

settingsRoutes.get('/admin/backups', (c) => {
  return c.json({ backups: listBackups() });
});

settingsRoutes.delete('/admin/backups/:filename', (c) => {
  deleteBackup(c.req.param('filename'));
  return c.json({ ok: true });
});

settingsRoutes.get('/admin/system-info', (c) => {
  const dbExists = existsSync(config.dbPath);
  return c.json({
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    dbPath: config.dbPath,
    dbSize: dbExists ? statSync(config.dbPath).size : 0,
    backupEnabled: getSetting('backup_enabled', DEFAULT_SETTINGS.backup_enabled),
    backupIntervalHours: getSetting('backup_interval_hours', DEFAULT_SETTINGS.backup_interval_hours),
  });
});
