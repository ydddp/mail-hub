import { parseTimestamp } from './time.js';
import { BackupInfo, DEFAULT_SETTINGS, backupDb, getSetting, listBackups } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('backup');
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 900_000;

let backupTimer: ReturnType<typeof setTimeout> | undefined;
let schedulerStarted = false;
let backupRunning = false;
let generation = 0;
let consecutiveFailures = 0;
let retryAt = 0;

function backupEnabled(): boolean {
  return getSetting('backup_enabled', DEFAULT_SETTINGS.backup_enabled) !== '0';
}

function backupIntervalMs(): number {
  const hours = Math.max(1, parseInt(getSetting('backup_interval_hours', DEFAULT_SETTINGS.backup_interval_hours), 10) || 6);
  return hours * 60 * 60 * 1000;
}

function newestBackup(backups: BackupInfo[]): BackupInfo | undefined {
  return backups
    .filter((backup) => Number.isFinite(parseTimestamp(backup.createdAt)))
    .sort((a, b) => parseTimestamp(b.createdAt) - parseTimestamp(a.createdAt))[0];
}

function nextDelayMs(): number {
  const latest = newestBackup(listBackups());
  if (!latest) return 0;
  const elapsedMs = Date.now() - parseTimestamp(latest.createdAt);
  return Math.max(0, backupIntervalMs() - elapsedMs);
}

function clearBackupTimer(): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = undefined;
}

function armBackupTimer(delayMs: number): void {
  const boundedDelayMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
  const armedGeneration = generation;
  backupTimer = setTimeout(() => void runScheduledBackup(armedGeneration), boundedDelayMs);
  backupTimer.unref?.();
}

function recordFailure(error: unknown): void {
  // Saturate the counter too, so a long outage cannot overflow the exponent.
  consecutiveFailures = Math.min(consecutiveFailures + 1, 5);
  const delayMs = Math.min(MIN_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1), MAX_RETRY_DELAY_MS);
  retryAt = Date.now() + delayMs;
  log.error('automatic backup failed; retry scheduled', { error: error, delayMs });
}

async function runScheduledBackup(armedGeneration: number): Promise<void> {
  if (!schedulerStarted || armedGeneration !== generation) return;
  clearBackupTimer();
  if (backupRunning) return;

  backupRunning = true;
  let failed = false;
  try {
    if (!backupEnabled()) {
      log.info('automatic backup skipped');
      return;
    }
    const backup = await backupDb();
    consecutiveFailures = 0;
    retryAt = 0;
    log.info('database backup complete', { filename: backup.filename, size: backup.size });
  } catch (e) {
    failed = true;
    recordFailure(e);
  } finally {
    backupRunning = false;
    // Control actions do not arm timers while a backup is pending. On settle,
    // hand scheduling to the current generation, including after stop/start.
    scheduleNextBackup('backup cycle complete', failed);
  }
}

function scheduleNextBackup(reason: string, cycleFailed = false): void {
  clearBackupTimer();
  if (!schedulerStarted || backupRunning) return;

  try {
    if (!backupEnabled()) {
      log.info('automatic backup disabled', { reason });
      return;
    }

    const delayMs = consecutiveFailures > 0 ? Math.max(0, retryAt - Date.now()) : nextDelayMs();
    armBackupTimer(delayMs);
    log.info('automatic backup scheduled', {
      reason,
      nextRunAt: new Date(Date.now() + Math.min(delayMs, MAX_TIMER_DELAY_MS)).toISOString(),
      delayMs,
    });
  } catch (e) {
    // A settings error can occur both at the timer's entry and again here;
    // count that failed cycle once and never let finally reject its promise.
    if (!cycleFailed) recordFailure(e);
    armBackupTimer(Math.max(0, retryAt - Date.now()));
  }
}

export function startBackupScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  generation++;
  scheduleNextBackup('startup');
}

export function rescheduleBackup(reason = 'settings updated'): void {
  if (!schedulerStarted) return;
  generation++;
  scheduleNextBackup(reason);
}

export function stopBackupScheduler(): void {
  schedulerStarted = false;
  generation++;
  clearBackupTimer();
}
