import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { assertTestPath, createTestDirectory } from './helpers/test-storage.js';
import { join } from 'path';
import { Hono } from 'hono';
import { loadPublicBundle, registerAssetRoutes } from '../src/static-assets.js';
import { app as realApp } from './helpers/http.js';

// The SPA ships as index.html plus files under /assets. A stale cached file
// after a deploy, a file that is not served, or a route that leaks anything
// outside public/ would each break or expose the admin UI.

let dir: string;

function write(path: string, body: string) {
  const full = assertTestPath(join(dir, path));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function shortHash(body: string) {
  return createHash('sha256').update(body).digest('hex').slice(0, 10);
}

function fixtureApp() {
  const app = new Hono();
  registerAssetRoutes(app, loadPublicBundle(dir));
  return app;
}

beforeEach(() => {
  dir = createTestDirectory('public-');
  write('index.html', '<link rel="stylesheet" href="/assets/css/base.css"><script src="/assets/js/app.js"></script><div id="v-docs" data-src="/assets/views/docs.html"></div>');
  write('css/base.css', 'body{color:red}');
  write('js/app.js', 'console.log(1)');
  write('views/docs.html', '<h2>Docs</h2>');
  write('extensions.js', 'optional script');
  write('logo.png', 'not text');
});

describe('loadPublicBundle', () => {
  // A module imported by plain path but loaded by the entry tag under a hashed
  // URL would be two modules with two copies of its state; the map keeps one.
  it('maps every module path to its hashed URL, ahead of the first module script', () => {
    write('index.html', '<head></head><body><script type="module" src="/assets/js/app.js"></script></body>');
    write('js/lib/util.js', 'export const x = 1;');
    const { indexHtml } = loadPublicBundle(dir);
    const map = /<script type="importmap">(.*?)<\/script>\n<script type="module"/.exec(indexHtml);
    expect(map).not.toBeNull();
    expect(JSON.parse(map![1]).imports).toEqual({
      '/assets/js/app.js': `/assets/js/app.js?h=${shortHash('console.log(1)')}`,
      '/assets/js/lib/util.js': `/assets/js/lib/util.js?h=${shortHash('export const x = 1;')}`,
    });
  });
  it('pins every /assets URL in index.html to the file content hash', () => {
    const { indexHtml } = loadPublicBundle(dir);
    expect(indexHtml).toContain(`href="/assets/css/base.css?h=${shortHash('body{color:red}')}"`);
    expect(indexHtml).toContain(`src="/assets/js/app.js?h=${shortHash('console.log(1)')}"`);
    // Markup fetched by script is named in data-src and pinned the same way.
    expect(indexHtml).toContain(`data-src="/assets/views/docs.html?h=${shortHash('<h2>Docs</h2>')}"`);

    write('css/base.css', 'body{color:blue}');
    expect(loadPublicBundle(dir).indexHtml).toContain(`?h=${shortHash('body{color:blue}')}`);
  });

  it('refuses to start when index.html names an asset that does not exist', () => {
    write('index.html', '<script src="/assets/js/missing.js"></script>');
    expect(() => loadPublicBundle(dir)).toThrow(/missing\.js/);
  });
});

describe('asset routes', () => {
  it.each([
    ['css/base.css', 'text/css; charset=utf-8', 'body{color:red}'],
    ['js/app.js', 'application/javascript; charset=utf-8', 'console.log(1)'],
    ['views/docs.html', 'text/html; charset=utf-8', '<h2>Docs</h2>'],
  ])('serves %s with its content type', async (path, type, body) => {
    const res = await fixtureApp().request(`/assets/${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(await res.text()).toBe(body);
  });

  it('caches a hashed URL for good and revalidates an unhashed one', async () => {
    const app = fixtureApp();
    const hash = shortHash('body{color:red}');
    const pinned = await app.request(`/assets/css/base.css?h=${hash}`);
    expect(pinned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const bare = await app.request('/assets/css/base.css');
    expect(bare.headers.get('cache-control')).toBe('no-cache');
    const etag = bare.headers.get('etag')!;
    expect(etag).toBe(`"${hash}"`);
    expect((await app.request('/assets/css/base.css', { headers: { 'If-None-Match': etag } })).status).toBe(304);
  });

  it.each([
    '/assets/css/missing.css',
    '/assets/index.html',
    '/assets/extensions.js',
    '/assets/logo.png',
    '/assets/%2e%2e/index.html',
    '/assets/css/%2e%2e%2f%2e%2e%2fextensions.js',
    '/assets/%E0%A4%A',
  ])('answers 404 for %s', async (path) => {
    expect((await fixtureApp().request(path)).status).toBe(404);
  });

  it('is reachable without credentials on the real app', async () => {
    // API_SECRET is set in tests; an auth-guarded route would answer 401.
    expect((await realApp.request('/assets/css/not-there.css')).status).toBe(404);
  });

  // The page requests /extensions.js on every visit, whether or not the file is present.
  it('serves /extensions.js as a script whether or not the file is present', async () => {
    const res = await realApp.request('/extensions.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });
});
