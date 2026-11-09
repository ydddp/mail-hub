import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BackupInfo } from '../src/db.js';
import { createTestDatabasePath } from './helpers/test-storage.js';

describe('backup scheduler', () => {
  let database: typeof import('../src/db.js');
  let scheduler: typeof import('../src/backup-scheduler.js');

  async function waitForBackup(): Promise<void> {
    await vi.waitFor(() => {
      expect(database.listBackups()).toHaveLength(1);
    });
  }

  beforeEach(async () => {
    // A new database directory also gives each case fresh backup storage;
    // never erase a previous case's failure evidence to prepare the next one.
    // Backoff belongs to the scheduler instance and survives stop/start.
    // Isolate each case without changing that production lifecycle contract.
    vi.resetModules();
    const { config } = await import('../src/config.js');
    config.dbPath = createTestDatabasePath();
    database = await import('../src/db.js');
    database.initDb();
    scheduler = await import('../src/backup-scheduler.js');
  });

  afterEach(() => {
    scheduler.stopBackupScheduler();
    vi.restoreAllMocks();
    database.getDb().close();
  });

  it.each(['success', 'ENOSPC', 'EACCES'])('runs the first real backup chain and retains safe %s diagnostics', async outcome => {
    database.setSetting('backup_enabled', '1');
    database.setSetting('backup_interval_hours', '1');
    const output: string[] = [];
    if (outcome !== 'success') {
      const secret = 'opaque-native-backup-secret';
      vi.spyOn(database.getDb(), 'backup').mockRejectedValue(Object.assign(new Error(`${secret} https://user:${secret}@backup.test/private`), {
        code: outcome, body: secret,
      }));
      vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    }
    scheduler.startBackupScheduler();
    if (outcome === 'success') await waitForBackup();
    else {
      await vi.waitFor(() => expect(output.some(line => line.includes('automatic backup failed'))).toBe(true));
      expect(output.map(line => JSON.parse(line)).find(entry => entry.msg === 'automatic backup failed; retry scheduled'))
        .toMatchObject({ error: { class: 'Error', category: 'error', code: outcome }, delayMs: 60_000 });
      expect(output.join('')).not.toContain('opaque-native-backup-secret');
      expect(output.join('')).not.toContain('backup.test');
    }
  });

  it('reschedules when backup settings change after startup', async () => {
    database.setSetting('backup_enabled', '0');
    database.setSetting('backup_interval_hours', '1');
    scheduler.startBackupScheduler();

    database.setSetting('backup_enabled', '1');
    scheduler.rescheduleBackup('test settings updated');

    await waitForBackup();
  });
});

describe('backup scheduler recovery and lifecycle', () => {
  let scheduler: typeof import('../src/backup-scheduler.js');
  let database: typeof import('../src/db.js');
  let settings: Record<string, string>;
  let backups: BackupInfo[];
  let backup: MockInstance<typeof import('../src/db.js')['backupDb']>;
  let readSetting: MockInstance<typeof import('../src/db.js')['getSetting']>;
  let readBackups: MockInstance<typeof import('../src/db.js')['listBackups']>;
  let timer: MockInstance<typeof setTimeout>;

  function completeBackup(createdAt = new Date().toISOString()): BackupInfo {
    const result = { filename: `mail-${createdAt.replace(/[:.]/g, '-')}.db`, size: 4096, createdAt };
    backups = [result, ...backups];
    return result;
  }

  function expectDelay(delayMs: number): void {
    expect(vi.getTimerCount()).toBe(1);
    expect(timer.mock.calls.at(-1)?.[1]).toBe(delayMs);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T00:00:00.000Z'));
    // Each scheduler instance owns fresh lifecycle/backoff state. Database
    // boundaries are mocked only here; the real-backup cases above stay real.
    vi.resetModules();
    database = await import('../src/db.js');
    scheduler = await import('../src/backup-scheduler.js');
    settings = { backup_enabled: '1', backup_interval_hours: '1' };
    backups = [];
    readSetting = vi.spyOn(database, 'getSetting').mockImplementation((key, fallback = '') => settings[key] ?? fallback);
    readBackups = vi.spyOn(database, 'listBackups').mockImplementation(() => backups);
    backup = vi.spyOn(database, 'backupDb').mockImplementation(async () => completeBackup());
    timer = vi.spyOn(globalThis, 'setTimeout');
  });

  afterEach(() => {
    scheduler.stopBackupScheduler();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['no backup', 'overdue backup'])('waits a minute after a failed backup with %s', async (state) => {
    if (state === 'overdue backup') completeBackup('2026-11-06T00:00:00.000Z');
    const previousBackups = [...backups];
    const secret = 'opaque-backup-failure-secret';
    const failure = Object.assign(new Error(`${secret} https://user:${secret}@backup.test/${secret}`), {
      code: 'ENOSPC', body: secret, status: 503,
    });
    backup.mockRejectedValue(failure);
    const output: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });

    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(backup).toHaveBeenCalledTimes(1);
    expectDelay(60_000);
    expect(backups).toEqual(previousBackups);
    const entry = output.map(line => JSON.parse(line)).find(entry => entry.msg === 'automatic backup failed; retry scheduled');
    expect(entry).toMatchObject({ error: { class: 'Error', category: 'upstream_http', code: 'ENOSPC', status: 503 } });
    expect(output.join('')).not.toContain(secret);
    expect(output.join('')).not.toContain('backup.test');
    stderr.mockRestore();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(backup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backup).toHaveBeenCalledTimes(2);
    expectDelay(120_000);
  });

  it('caps consecutive failure delays at fifteen minutes and resets only after a successful backup', async () => {
    backup.mockRejectedValue(new Error('disk full'));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);

    let attempts = 1;
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      expectDelay(delay);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(backup).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(backup).toHaveBeenCalledTimes(++attempts);
    }

    backup.mockImplementation(async () => completeBackup());
    await vi.advanceTimersByTimeAsync(900_000);
    expect(backup).toHaveBeenCalledTimes(++attempts);
    expectDelay(3_600_000);

    backup.mockRejectedValue(new Error('disk full again'));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(backup).toHaveBeenCalledTimes(++attempts);
    expectDelay(60_000);
  });

  it('keeps successful scheduling anchored to the latest successful backup time', async () => {
    backup.mockImplementation(async () => completeBackup('2026-11-06T23:50:00.000Z'));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expectDelay(50 * 60_000);
    await vi.advanceTimersByTimeAsync(50 * 60_000 - 1);
    expect(backup).toHaveBeenCalledTimes(1);
  });

  const schedulingErrors = ['enabled setting', 'interval setting', 'directory listing', 'backup stat'] as const;
  it.each(schedulingErrors.flatMap((source) => ['startup', 'reschedule', 'completion'].map((stage) => ({ source, stage }))))(
    'backs off an EACCES from $source during $stage without escaping the scheduler',
    async ({ source, stage }) => {
      let fail = stage !== 'completion';
      const error = Object.assign(new Error(`EACCES: ${source}`), {
        code: 'EACCES', syscall: source === 'directory listing' ? 'scandir' : source === 'backup stat' ? 'stat' : 'read',
      });
      readSetting.mockImplementation((key, fallback = '') => {
        if (fail && key === (source === 'enabled setting' ? 'backup_enabled' : source === 'interval setting' ? 'backup_interval_hours' : '')) {
          throw error;
        }
        return settings[key] ?? fallback;
      });
      // listBackups performs both readdirSync and backupInfo's statSync; both
      // filesystem failures must be contained at this scheduler boundary.
      readBackups.mockImplementation(() => {
        if (fail && (source === 'directory listing' || source === 'backup stat')) throw error;
        return backups;
      });
      if (source === 'interval setting') completeBackup();

      if (stage === 'reschedule') {
        settings.backup_enabled = '0';
        fail = false;
        scheduler.startBackupScheduler();
        settings.backup_enabled = '1';
        fail = true;
        expect(() => scheduler.rescheduleBackup()).not.toThrow();
      } else if (stage === 'completion') {
        backups = [];
        backup.mockImplementationOnce(async () => {
          const result = completeBackup();
          fail = true;
          return result;
        });
        scheduler.startBackupScheduler();
        await vi.advanceTimersByTimeAsync(0);
        expect(backup).toHaveBeenCalledTimes(1);
      } else {
        expect(() => scheduler.startBackupScheduler()).not.toThrow();
      }

      expectDelay(60_000);
      fail = false;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(backup).toHaveBeenCalledTimes(stage === 'completion' ? 1 : 0);
      await vi.advanceTimersByTimeAsync(1);
      expect(backup).toHaveBeenCalledTimes(stage === 'completion' ? 2 : 1);
      expectDelay(3_600_000);
    },
  );

  it('backs off a settings failure when a scheduled timer fires', async () => {
    scheduler.startBackupScheduler();
    readSetting.mockImplementation(() => { throw new Error('settings unavailable'); });
    await vi.advanceTimersByTimeAsync(0);

    expect(backup).not.toHaveBeenCalled();
    expectDelay(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backup).not.toHaveBeenCalled();
    expectDelay(120_000);
  });

  it('disables pending retries and preserves their backoff when enabled again', async () => {
    backup.mockRejectedValue(new Error('disk full'));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expectDelay(60_000);

    settings.backup_enabled = '0';
    scheduler.rescheduleBackup();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    settings.backup_enabled = '1';
    scheduler.rescheduleBackup();
    expectDelay(30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(backup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backup).toHaveBeenCalledTimes(2);
    expectDelay(120_000);
  });

  it.each(['success', 'failure'])('does not rearm after stop while a backup is pending (%s)', async (outcome) => {
    let resolve!: (result: BackupInfo) => void;
    let reject!: (error: Error) => void;
    backup.mockImplementationOnce(() => new Promise<BackupInfo>((done, failed) => { resolve = done; reject = failed; }));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(backup).toHaveBeenCalledTimes(1);

    scheduler.stopBackupScheduler();
    if (outcome === 'success') resolve(completeBackup());
    else reject(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('defers repeated reschedules until the running backup settles', async () => {
    let resolve!: (result: BackupInfo) => void;
    backup.mockImplementationOnce(() => new Promise<BackupInfo>((done) => { resolve = done; }));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);

    for (let index = 0; index < 3; index++) {
      scheduler.rescheduleBackup();
      expect(vi.getTimerCount()).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backup).toHaveBeenCalledTimes(1);

    settings.backup_interval_hours = '2';
    scheduler.rescheduleBackup();
    resolve(completeBackup());
    await vi.advanceTimersByTimeAsync(0);
    expectDelay(7_200_000);
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(backup).toHaveBeenCalledTimes(2);
    expectDelay(7_200_000);
  });

  it.each(['success', 'failure'])('waits for an old pending backup across stop/start and schedules the current generation (%s)', async (outcome) => {
    let resolve!: (result: BackupInfo) => void;
    let reject!: (error: Error) => void;
    backup.mockImplementationOnce(() => new Promise<BackupInfo>((done, failed) => { resolve = done; reject = failed; }));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stopBackupScheduler();
    scheduler.startBackupScheduler();
    scheduler.startBackupScheduler();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backup).toHaveBeenCalledTimes(1);

    settings.backup_interval_hours = '2';
    if (outcome === 'success') resolve(completeBackup());
    else reject(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(0);
    const delay = outcome === 'success' ? 7_200_000 : 60_000;
    expectDelay(delay);
    await vi.advanceTimersByTimeAsync(delay);
    expect(backup).toHaveBeenCalledTimes(2);
    expectDelay(7_200_000);
  });

  it.each(['success', 'failure'])('honors disabling during a pending backup (%s)', async (outcome) => {
    let resolve!: (result: BackupInfo) => void;
    let reject!: (error: Error) => void;
    backup.mockImplementationOnce(() => new Promise<BackupInfo>((done, failed) => { resolve = done; reject = failed; }));
    scheduler.startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);
    settings.backup_enabled = '0';
    scheduler.rescheduleBackup();
    expect(vi.getTimerCount()).toBe(0);

    if (outcome === 'success') resolve(completeBackup());
    else reject(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    settings.backup_enabled = '1';
    scheduler.rescheduleBackup();
    expectDelay(outcome === 'success' ? 3_600_000 : 60_000);
  });
});
