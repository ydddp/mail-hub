import { readFileSync } from 'fs';
import type { Context, Hono } from 'hono';
import { createLogger } from './logger.js';

/**
 * The browser assistant (userscript/) is installed from the Mail Hub itself.
 * The built file carries ORIGIN_MARK where its update URL and its default
 * connection address belong; serving it fills in this instance's origin, so
 * an installed script updates from, and connects to, the Mail Hub it came
 * from. The file is public: it contains no secret, and the script manager
 * fetches it without credentials.
 */

export const ORIGIN_MARK = '%%MAILHUB_ORIGIN%%';
export const USERSCRIPT_PATH = '/userscript/mail-hub.user.js';

const log = createLogger('userscript');

/** Read the built script once at startup; null when it was never built. */
export function loadUserscript(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    log.warn('browser assistant not built; run npm run build to serve it', { path });
    return null;
  }
}

export function renderUserscript(source: string, origin: string): string {
  return source.split(ORIGIN_MARK).join(origin);
}

const HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * Origin the client reached us at, the same way /v1/llms.txt reads it. The
 * value is written into a JavaScript string, so anything that is not a plain
 * http(s) origin is refused rather than escaped.
 */
export function requestOrigin(c: Context): string | null {
  const proto = (c.req.header('x-forwarded-proto') || 'http').split(',')[0].trim().toLowerCase();
  const host = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(',')[0].trim();
  if (proto !== 'http' && proto !== 'https') return null;
  if (!HOST.test(host)) return null;
  return `${proto}://${host}`;
}

export function registerUserscriptRoute(app: Hono<any>, source: string | null): void {
  app.get(USERSCRIPT_PATH, (c) => {
    if (!source) return c.text('The browser assistant has not been built on this server. Run npm run build.', 404);
    const origin = requestOrigin(c);
    if (!origin) return c.text('Unrecognised host for the browser assistant.', 400);
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    // Always revalidate: the script manager compares @version on update checks.
    c.header('Cache-Control', 'no-cache');
    return c.body(renderUserscript(source, origin));
  });
}
