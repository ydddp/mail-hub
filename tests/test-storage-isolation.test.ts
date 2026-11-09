import { describe, expect, it, vi } from 'vitest';
import type { TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { config } from '../src/config.js';
import { backupDb, deleteBackup, getDb, listBackups } from '../src/db.js';
import { trustTokenPath } from '../src/providers/icloud-auth.js';
import { assertTestPath, createTestDirectory, removeTestPath } from './helpers/test-storage.js';
import { TestStorageReporter } from './test-storage-reporter.js';

describe('test storage isolation', () => {
  // Loading application modules must already be safe: many suites import
  // config before their first hook, when a late DB_PATH override cannot help.
  it('selects an absolute, unique OS temporary root before application imports', () => {
    const root = process.env.MAIL_HUB_TEST_ROOT;
    expect(root).toBeTypeOf('string');
    expect(isAbsolute(root!)).toBe(true);
    expect(relative(resolve(tmpdir()), resolve(root!))).toMatch(/^mail-hub-vitest-[^\\/]+$/);
    expect(basename(root!)).toMatch(/^mail-hub-vitest-/);
    expect(isAbsolute(config.dbPath)).toBe(true);
    expect(relative(root!, config.dbPath)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(config.dbPath).not.toBe(resolve('data/test-mail.db'));
    expect(dirname(config.dbPath)).not.toBe(root);
    expect(assertTestPath(join(dirname(config.dbPath), 'backups'))).toBeTruthy();
    expect(assertTestPath(trustTokenPath('isolated@icloud.com'))).toBeTruthy();
  });

  // Writes and cleanup use the same containment check. A root-prefix lookalike
  // or relative path must never authorize a write/delete in user storage.
  it.each(['workspace', 'parent', 'prefix-lookalike', 'relative', 'run-root'])(
    'refuses %s paths before writing or deleting them', (kind) => {
      const root = process.env.MAIL_HUB_TEST_ROOT!;
      const paths: Record<string, string> = {
        workspace: resolve('data/backups/operator-sentinel.db'),
        parent: resolve(root, '..', 'operator-sentinel.db'),
        'prefix-lookalike': `${root}-external/backups/operator-sentinel.db`,
        relative: 'data/backups/operator-sentinel.db',
        'run-root': root,
      };
      expect(() => assertTestPath(paths[kind])).toThrow(/Refusing/);
      expect(() => removeTestPath(paths[kind])).toThrow(/Refusing/);
    },
  );

  it('keeps an external backup sentinel intact through real backup creation and deletion', async () => {
    // This models a user's backup directory beside the test database, safely
    // inside this run's temporary root rather than touching real user files.
    const external = createTestDirectory('external-storage-');
    const backups = assertTestPath(join(external, 'backups'));
    mkdirSync(backups);
    const sentinel = assertTestPath(join(backups, 'mail-2000-01-01T00-00-00-000Z.db'));
    writeFileSync(sentinel, 'operator-owned-backup');

    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('storage-isolation', 'stored')`).run();
    const backup = await backupDb();
    expect(listBackups().map((entry) => entry.filename)).toEqual([backup.filename]);
    deleteBackup(backup.filename);

    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('operator-owned-backup');
    expect(readFileSync(assertTestPath(config.dbPath)).byteLength).toBeGreaterThan(0);
  });

  it.each([
    { name: 'test or hook failure', state: 'failed', reason: 'failed', errors: [] },
    { name: 'interruption', state: 'passed', reason: 'interrupted', errors: [] },
    { name: 'unhandled error', state: 'passed', reason: 'passed', errors: [new Error('unhandled')] },
    { name: 'unfinished suite', state: 'pending', reason: 'passed', errors: [] },
  ])('retains database, backups and auth evidence after $name', ({ state, reason, errors }) => {
    const root = process.env.MAIL_HUB_TEST_ROOT!;
    const marker = assertTestPath(join(createTestDirectory('failure-evidence-'), 'sentinel'));
    writeFileSync(marker, 'keep failure evidence');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reporter = new TestStorageReporter(root);
      reporter.onTestRunEnd([{ state: () => state } as TestModule], errors, reason as TestRunEndReason);
      expect(readFileSync(marker, 'utf8')).toBe('keep failure evidence');
      expect(existsSync(config.dbPath)).toBe(true);
      expect(warning).toHaveBeenCalledWith(`Retained failed test storage: ${root}`);
    } finally {
      warning.mockRestore();
    }
  });

  it('cleans only its own OS temporary root after a completely successful run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mail-hub-vitest-'));
    const marker = assertTestPath(join(root, 'sentinel'), root);
    writeFileSync(marker, 'successful test scratch');
    new TestStorageReporter(root).onTestRunEnd([{ state: () => 'passed' } as TestModule], [], 'passed');
    expect(existsSync(root)).toBe(false);
    expect(existsSync(config.dbPath)).toBe(true);
  });

  it('keeps watch storage available for reruns and earlier failure evidence', () => {
    const root = process.env.MAIL_HUB_TEST_ROOT!;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reporter = new TestStorageReporter(root);
      reporter.onInit({ config: { watch: true } } as Vitest);
      reporter.onTestRunEnd([{ state: () => 'passed' } as TestModule], [], 'passed');
      expect(existsSync(config.dbPath)).toBe(true);
      expect(warning).toHaveBeenCalledWith(`Retained watch test storage: ${root}`);
    } finally {
      warning.mockRestore();
    }
  });
});
