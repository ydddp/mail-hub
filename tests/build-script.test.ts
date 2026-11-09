import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { assertTestPath, createTestDirectory } from './helpers/test-storage.js';
import { join, resolve } from 'path';

// The server serves every file under dist/public. A deploy rebuilds in place, so a file deleted
// from src/public must also leave dist/public, or it stays online (an old module once did).
// This runs the copy step of the real build script in a scratch directory.
const build = (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts: { build: string } }).scripts.build;
const copyStep = build.match(/node --input-type=commonjs -e "(.+)"$/)?.[1];

let dir: string;
const write = (path: string, body: string) => {
  const full = assertTestPath(join(dir, path));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
};

describe('build: copying the SPA into dist', () => {
  beforeEach(() => { dir = createTestDirectory('build-'); });

  it('leaves dist/public an exact copy of src/public, dropping files the source no longer has', () => {
    expect(copyStep).toBeTruthy();
    write('src/public/index.html', 'new index');
    write('src/public/js/core/kept.js', 'new kept');
    write('dist/public/index.html', 'old index');
    write('dist/public/js/core/kept.js', 'old kept');
    write('dist/public/js/core/deleted.js', 'gone from src');
    write('dist/app.js', 'compiled server');

    execFileSync(process.execPath, ['--input-type=commonjs', '-e', copyStep!], { cwd: dir });

    expect(readFileSync(join(dir, 'dist/public/index.html'), 'utf8')).toBe('new index');
    expect(readFileSync(join(dir, 'dist/public/js/core/kept.js'), 'utf8')).toBe('new kept');
    expect(existsSync(join(dir, 'dist/public/js/core/deleted.js'))).toBe(false);
    // Only the copied tree is replaced; the compiled server next to it stays.
    expect(readFileSync(join(dir, 'dist/app.js'), 'utf8')).toBe('compiled server');
  });
});
