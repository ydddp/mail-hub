import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerUserscriptRoute, renderUserscript, ORIGIN_MARK } from '../src/userscript-route.js';
import { app as realApp } from './helpers/http.js';

/**
 * The browser assistant is installed from the user's own Mail Hub. The served
 * file must point its update URL and its default connection back at the
 * instance it came from, be reachable without an API key (the script manager
 * fetches it), and never carry a request header into the script unchecked.
 */

const SOURCE = [
  '// ==UserScript==',
  `// @updateURL    ${ORIGIN_MARK}/userscript/mail-hub.user.js`,
  `// @downloadURL  ${ORIGIN_MARK}/userscript/mail-hub.user.js`,
  '// ==/UserScript==',
  `const servedFrom = "${ORIGIN_MARK}";`,
].join('\n');

function fixtureApp(source: string | null) {
  const app = new Hono();
  registerUserscriptRoute(app, source);
  return app;
}

describe('renderUserscript', () => {
  it('points every mark at the serving origin', () => {
    const body = renderUserscript(SOURCE, 'https://mail.example.com');
    expect(body).toContain('// @updateURL    https://mail.example.com/userscript/mail-hub.user.js');
    expect(body).toContain('// @downloadURL  https://mail.example.com/userscript/mail-hub.user.js');
    expect(body).toContain('const servedFrom = "https://mail.example.com";');
    expect(body).not.toContain(ORIGIN_MARK);
  });
});

describe('GET /userscript/mail-hub.user.js', () => {
  it.each<[string, Record<string, string>, number, string | null]>([
    ['plain host', { host: 'mail.example.com' }, 200, 'http://mail.example.com'],
    ['behind a TLS proxy', { host: '127.0.0.1:3100', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mail.example.com' }, 200, 'https://mail.example.com'],
    ['host with port', { host: 'localhost:3000' }, 200, 'http://localhost:3000'],
    // Whatever the header says ends up inside a JavaScript string literal.
    ['a quote in the host is refused', { host: 'evil.example"+alert(1)+"' }, 400, null],
    ['an unknown scheme is refused', { host: 'mail.example.com', 'x-forwarded-proto': 'javascript' }, 400, null],
  ])('%s', async (_name, headers, status, origin) => {
    const response = await fixtureApp(SOURCE).request('/userscript/mail-hub.user.js', { headers });
    expect(response.status).toBe(status);
    if (!origin) return;
    expect(response.headers.get('content-type')).toContain('javascript');
    // Revalidate every time: a cached old script would skip an update.
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const body = await response.text();
    expect(body).toContain(`// @updateURL    ${origin}/userscript/mail-hub.user.js`);
    expect(body).not.toContain(ORIGIN_MARK);
  });

  it('says how to build it when the script was never built', async () => {
    const response = await fixtureApp(null).request('/userscript/mail-hub.user.js', { headers: { host: 'mail.example.com' } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('npm run build');
  });

  it('is served by the real app without an API key', async () => {
    // Built or not on this machine, the route exists and needs no auth.
    const response = await realApp.request('/userscript/mail-hub.user.js', { headers: { host: 'mail.example.com' } });
    expect([200, 404]).toContain(response.status);
    expect(response.status).not.toBe(401);
  });
});
