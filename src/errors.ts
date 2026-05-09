import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createLogger } from './logger.js';

const VALID_CONTENTFUL_STATUS = new Set<number>([
  100, 102, 103,
  200, 201, 202, 203, 206, 207, 208, 226,
  300, 301, 302, 303, 305, 306, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
]);

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function httpStatus(error: unknown, fallback = 500): number {
  if (!error || typeof error !== 'object' || !('status' in error)) return fallback;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : fallback;
}

export function jsonStatus(status: number): ContentfulStatusCode {
  return VALID_CONTENTFUL_STATUS.has(status) ? status as ContentfulStatusCode : 500;
}

export function logIgnoredError(
  logger: ReturnType<typeof createLogger>,
  message: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  logger.warn(message, { ...extra, error: errorMessage(error) });
}
