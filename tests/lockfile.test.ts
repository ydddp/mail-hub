import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

type LockEntry = {
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const lock = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf-8'),
) as { packages: Record<string, LockEntry> };

// Finds `name` from the package at `from` the way Node does: its own
// node_modules first, then each enclosing node_modules up to the root.
function resolvesInLock(from: string, name: string): boolean {
  let dir = from;
  for (;;) {
    if (lock.packages[`${dir ? `${dir}/` : ''}node_modules/${name}`]) return true;
    if (!dir) return false;
    const parent = dir.lastIndexOf('/node_modules/');
    dir = parent === -1 ? '' : dir.slice(0, parent);
  }
}

describe('package-lock.json', () => {
  // The hanabi deploy (npm 10.9) and the Docker build (node:20, npm 10.8) both
  // run `npm ci`. npm 11 can write a lockfile that leaves a peer dependency
  // unplaced, which npm 10 rejects as "Missing: <pkg> from lock file"; both then
  // fall back to an unlocked `npm install` that ignores the lockfile entirely.
  it('places every dependency and required peer where npm 10 `npm ci` looks for it', () => {
    const unresolved: string[] = [];
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (entry.link) continue;
      const wanted = new Set([
        ...Object.keys(entry.dependencies ?? {}),
        ...Object.keys(entry.optionalDependencies ?? {}),
        ...(path === '' ? Object.keys(entry.devDependencies ?? {}) : []),
        ...Object.keys(entry.peerDependencies ?? {}).filter((peer) => !entry.peerDependenciesMeta?.[peer]?.optional),
      ]);
      for (const name of wanted) {
        if (!resolvesInLock(path, name)) unresolved.push(`${path || '(root)'} -> ${name}`);
      }
    }

    expect(
      unresolved,
      'Declare each missing peer in devDependencies and re-run `npm install`, so npm 10 and npm 11 place it the same way',
    ).toEqual([]);
  });
});
