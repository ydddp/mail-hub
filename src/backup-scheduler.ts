import { BackupInfo, DEFAULT_SETTINGS, backupDb, getSetting, listBackups } from './db.js';
import { errorMessage } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('backup');
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let backupTimer: ReturnType<typeof setTimeout> | undefined;
let schedulerStarted = false;
let backupRunning = false;

function backupEnabled(): boolean {
  return getSetting('backup_enabled', DEFAULT_SETTINGS.backup_enabled) !== '0';
}

function backupIntervalMs(): number {
  const hours = Math.max(1, parseInt(getSetting('backup_interval_hours', DEFAULT_SETTINGS.backup_interval_hours), 10) || 6);
  return hours * 60 * 60 * 1000;
}

function newestBackup(backups: BackupInfo[]): BackupInfo | undefined {
  return backups
    .filter((backup) => Number.isFinite(Date.parse(backup.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

function nextDelayMs(): number {
  const latest = newestBackup(listBackups());
  if (!latest) return 0;
  const elapsedMs = Date.now() - Date.parse(latest.createdAt);
  return Math.max(0, backupIntervalMs() - elapsedMs);
}

function clearBackupTimer(): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = undefined;
}

function armBackupTimer(delayMs: number): void {
  const boundedDelayMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
  backupTimer = setTimeout(() => void runScheduledBackup(), boundedDelayMs);
  backupTimer.unref?.();
}

async function runScheduledBackup(): Promise<void> {
  clearBackupTimer();
  if (!schedulerStarted) return;

  let acquiredBackup = false;
  try {
    if (!backupEnabled()) {
      log.info('automatic backup skipped');
      return;
    }
    if (backupRunning) {
      log.warn('automatic backup skipped because another backup is running');
      return;
    }
    backupRunning = true;
    acquiredBackup = true;
    const backup = await backupDb();
    log.info('database backup complete', { filename: backup.filename, size: backup.size });
  } catch (e) {
    log.error('database backup failed', { error: errorMessage(e) });
  } finally {
    if (acquiredBackup) backupRunning = false;
    scheduleNextBackup('backup cycle complete');
  }
}

function scheduleNextBackup(reason: string): void {
  clearBackupTimer();
  if (!schedulerStarted) return;

  if (!backupEnabled()) {
    log.info('automatic backup disabled', { reason });
    return;
  }

  const delayMs = nextDelayMs();
  armBackupTimer(delayMs);
  log.info('automatic backup scheduled', {
    reason,
    nextRunAt: new Date(Date.now() + Math.min(delayMs, MAX_TIMER_DELAY_MS)).toISOString(),
    delayMs,
  });
}

export function startBackupScheduler(): void {
  schedulerStarted = true;
  scheduleNextBackup('startup');
}

export function rescheduleBackup(reason = 'settings updated'): void {
  scheduleNextBackup(reason);
}

export function stopBackupScheduler(): void {
  schedulerStarted = false;
  clearBackupTimer();
}
