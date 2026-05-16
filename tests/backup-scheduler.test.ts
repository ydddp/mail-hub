import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../src/config.js';
import { listBackups, setSetting } from '../src/db.js';
import { rescheduleBackup, startBackupScheduler, stopBackupScheduler } from '../src/backup-scheduler.js';

function backupDir(): string {
  return join(dirname(config.dbPath), 'backups');
}

function removeBackups(): void {
  const dir = backupDir();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

async function waitForBackup(): Promise<void> {
  await vi.waitFor(() => {
    expect(listBackups()).toHaveLength(1);
  });
}

describe('backup scheduler', () => {
  beforeEach(() => {
    removeBackups();
  });

  afterEach(() => {
    stopBackupScheduler();
    removeBackups();
  });

  it('runs the first automatic backup immediately when no backup exists', async () => {
    setSetting('backup_enabled', '1');
    setSetting('backup_interval_hours', '1');

    startBackupScheduler();

    await waitForBackup();
  });

  it('reschedules when backup settings change after startup', async () => {
    setSetting('backup_enabled', '0');
    setSetting('backup_interval_hours', '1');
    startBackupScheduler();

    setSetting('backup_enabled', '1');
    rescheduleBackup('test settings updated');

    await waitForBackup();
  });
});
