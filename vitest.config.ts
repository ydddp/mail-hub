import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TestStorageReporter } from './tests/test-storage-reporter.js';

// Set these while loading the config, before any application module captures
// process.env. Never inherit a developer/production DB_PATH into a test run.
const testRoot = mkdtempSync(join(tmpdir(), 'mail-hub-vitest-'));
process.env.MAIL_HUB_TEST_ROOT = testRoot;
process.env.DB_PATH = join(testRoot, 'mail.db');
process.env.API_SECRET = 'admin-secret';

export default defineConfig({
  test: {
    globals: true,
    env: {
      API_SECRET: 'admin-secret',
      DB_PATH: process.env.DB_PATH,
      MAIL_HUB_TEST_ROOT: testRoot,
    },
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    isolate: true,
    reporters: ['default', new TestStorageReporter(testRoot)],
  },
});
