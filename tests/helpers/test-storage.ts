import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

function assertRunRoot(root: string): string {
  const absolute = resolve(root);
  if (!isAbsolute(root) || dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('mail-hub-vitest-')) {
    throw new Error(`Refusing test storage outside an OS temporary run root: ${root}`);
  }
  if (lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new Error(`Refusing linked test storage root: ${root}`);
  }
  return absolute;
}

/** Validate before every test-owned filesystem mutation, including cleanup. */
export function assertTestPath(path: string, root = process.env.MAIL_HUB_TEST_ROOT): string {
  if (!root) throw new Error('MAIL_HUB_TEST_ROOT must be set by vitest.config.ts');
  const absoluteRoot = assertRunRoot(root);
  const absolute = resolve(path);
  if (!isAbsolute(path) || !isInside(absoluteRoot, absolute)) {
    throw new Error(`Refusing test storage outside ${absoluteRoot}: ${path}`);
  }
  // A lexical child can still escape through a symlink/junction. Check every
  // existing ancestor before allowing a write to a not-yet-created file.
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (ancestor !== absoluteRoot && !isInside(absoluteRoot, realpathSync(ancestor))) {
    throw new Error(`Refusing linked test storage outside ${absoluteRoot}: ${path}`);
  }
  return absolute;
}

export function createTestDirectory(prefix: string): string {
  const root = process.env.MAIL_HUB_TEST_ROOT;
  const path = assertTestPath(join(root ?? '', prefix));
  return mkdtempSync(path);
}

export function createTestDatabasePath(): string {
  const path = assertTestPath(join(createTestDirectory('suite-'), 'mail.db'));
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function removeTestPath(path: string): void {
  rmSync(assertTestPath(path), { recursive: true, force: true });
}

/** Only the reporter may remove a run, after all workers have closed SQLite. */
export function finishTestStorage(root: string, succeeded: boolean): void {
  const absolute = assertRunRoot(root);
  if (succeeded) rmSync(absolute, { recursive: true, force: true });
  else console.warn(`Retained failed test storage: ${absolute}`);
}
