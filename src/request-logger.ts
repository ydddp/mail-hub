import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';
import { errorMessage, httpStatus } from './errors.js';
import { config } from './config.js';

const log = createLogger('request');

function clientIp(headers: Headers): string | undefined {
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim();
  return headers.get('x-real-ip') ?? undefined;
}

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now();
    const requestId = c.req.header('x-request-id') || randomUUID();
    c.header('X-Request-Id', requestId);

    let thrown: unknown;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const durationMs = Date.now() - startedAt;
      const status = thrown ? httpStatus(thrown) : c.res.status;
      const extra: Record<string, unknown> = {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs,
        ip: clientIp(c.req.raw.headers),
        userAgent: c.req.header('user-agent'),
      };
      if (thrown) extra.error = errorMessage(thrown);

      if (status >= 500 || thrown) {
        log.error('request completed', extra);
      } else if (status >= 400) {
        log.warn('request completed', extra);
      } else if (
        durationMs >= config.requestLogSlowMs
        || config.requestLogSuccess
        || Math.random() < config.requestLogSampleRate
      ) {
        log.info('request completed', extra);
      }
    }
  };
}
