import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

type LockEntry = {
  version?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const lock = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf-8'),
) as { version: string; packages: Record<string, LockEntry> };
const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string; dependencies: Record<string, string> };
const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf-8');

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
  // Node 22 installs (npm 10) and the Docker build (node:24, npm 11) both
  // run `npm ci`. npm 11 can write a lockfile that leaves a peer dependency
  // unplaced, which npm 10 rejects as "Missing: <pkg> from lock file".
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

  it('keeps the release version and dependency declarations consistent with package.json', () => {
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[''].version).toBe(manifest.version);
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
  });

  // These are advisory-safe floors, not snapshots of the selected patch versions.
  // A future compatible update can pass without weakening the security boundary.
  it.each([
    ['hono', '4.13.11'],
    ['@hono/node-server', '2.1.3'],
    ['undici', '7.30.1'],
    ['ip-address', '10.7.4'],
  ])('keeps %s outside the reviewed vulnerable version range', (name, floor) => {
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
      .map(([, entry]) => entry.version!);
    expect(versions.length).toBeGreaterThan(0);
    if (manifest.dependencies[name]) versions.push(manifest.dependencies[name].replace(/^[~^]/, ''));
    const minimum = floor.split('.').map(Number);
    for (const version of versions) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      const current = version.split('.').map(Number);
      const firstDifference = current.findIndex((part, index) => part !== minimum[index]);
      expect(
        firstDifference === -1 || current[firstDifference] > minimum[firstDifference],
        `${name} ${version} must be at least ${floor}`,
      ).toBe(true);
    }
  });

  // A floating base can reintroduce embedded-Undici vulnerabilities independently
  // of npm dependencies; an unlocked fallback can hide a broken release lockfile.
  it('builds both Docker stages from the reviewed base and fails on a broken lockfile', () => {
    const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match => match[1]);
    const base = 'node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8';
    expect.soft(bases).toEqual([base, base]);
    expect.soft(dockerfile).toMatch(/^RUN npm ci --omit=optional\s*$/m);
    expect.soft(dockerfile).not.toMatch(/\bnpm\s+(?:install|i)\b/);
  });
});
