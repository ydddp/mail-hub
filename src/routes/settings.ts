import { toUtcIso } from '../time.js';
import { Hono } from 'hono';
import { existsSync, statSync } from 'fs';
import { allRows, DEFAULT_SETTINGS, backupDb, deleteBackup, getDb, getSetting, listBackups, setSetting } from '../db.js';
import { config } from '../config.js';
import { errorMessage } from '../errors.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { checkForUpdates } from '../update-check.js';
import { APP_VERSION } from '../version.js';
import { rescheduleBackup } from '../backup-scheduler.js';
import { rescheduleIcloudPool } from '../providers/icloud-pool.js';

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];

function normalizeSettingValue(key: keyof typeof DEFAULT_SETTINGS, value: unknown): string {
  if (key === 'backup_enabled' || key === 'icloud_pool_enabled') return value === '0' || value === false ? '0' : '1';
  if (key === 'proxy_url') return String(value ?? '').trim();
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SETTINGS[key];
  // A pool target above what an Apple ID can ever hold is not a setting, it is
  // a way to spend the account. 750 is the lifetime cap on one ID.
  const ceiling = key === 'backup_interval_hours' ? 24 * 30
    : key === 'icloud_pool_target' ? 750
    : 10000;
  return String(Math.min(n, ceiling));
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
  const updatedAt: Record<string, string | null> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
    updatedAt[row.key] = toUtcIso(row.updated_at);
  }
  return c.json({ settings, defaults: DEFAULT_SETTINGS, updatedAt, env: { proxyUrl: config.proxyUrl } });
});

settingsRoutes.patch('/admin/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updates = body.settings && typeof body.settings === 'object' ? body.settings : body;
  const saved: Record<string, string> = {};
  let backupScheduleChanged = false;
  let icloudScheduleChanged = false;
  for (const key of SETTING_KEYS) {
    if (updates[key] === undefined) continue;
    const value = normalizeSettingValue(key, updates[key]);
    setSetting(key, value);
    saved[key] = value;
    if (key === 'backup_enabled' || key === 'backup_interval_hours') {
      backupScheduleChanged = true;
    }
    // The enabled switch is read per pass and needs no re-arm; the interval is
    // baked into the running timer, so it does. backup has the same split.
    if (key === 'icloud_pool_interval_minutes') {
      icloudScheduleChanged = true;
    }
  }
  if (backupScheduleChanged) {
    rescheduleBackup('settings updated');
  }
  if (icloudScheduleChanged) {
    rescheduleIcloudPool('settings updated');
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

settingsRoutes.get('/admin/update-check', async (c) => {
  try {
    return c.json(await checkForUpdates());
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 502);
  }
});
