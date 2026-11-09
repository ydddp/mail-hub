import type { Reporter, TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import { finishTestStorage } from './helpers/test-storage.js';

export class TestStorageReporter implements Reporter {
  private watch = false;

  constructor(private readonly root: string) {}

  onInit(vitest: Vitest): void {
    this.watch = vitest.config.watch;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<unknown>, reason: TestRunEndReason): void {
    const succeeded = reason === 'passed' && errors.length === 0
      && modules.length > 0 && modules.every((module) => ['passed', 'skipped'].includes(module.state()));
    // Watch reruns reuse the config's environment. Keep this root available,
    // including evidence from an earlier failure, until the watcher exits.
    if (this.watch && succeeded) console.warn(`Retained watch test storage: ${this.root}`);
    else finishTestStorage(this.root, succeeded);
  }
}
