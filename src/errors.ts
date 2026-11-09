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

export class UpstreamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string | null,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'UpstreamHttpError';
  }
}

/** A create-path verdict that positively proves no asset was allocated. */
export class NoAssetCreatedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NoAssetCreatedError';
  }
}

/** This internal recovery ID and cause never belong in ordinary error text. */
export class TemplateCreationRecoveryError extends Error {
  readonly recoveryId!: string;
  readonly status: number;
  readonly retryAfter?: string;
  readonly assetMayExist = true;

  constructor(recoveryId: string, cause?: unknown) {
    super('Template inbox creation requires recovery', { cause });
    this.name = 'TemplateCreationRecoveryError';
    Object.defineProperty(this, 'recoveryId', { value: recoveryId });
    this.status = httpStatus(cause, 500);
    this.retryAfter = retryAfterHeader(cause);
  }
}

/** A missing message and a message outside the caller's scope share one verdict. */
export class MessageNotFoundError extends Error {
  constructor() {
    super('Message not found');
    this.name = 'MessageNotFoundError';
  }
}

export class ImapAddressConflictError extends NoAssetCreatedError {
  readonly status = 409;

  constructor() {
    super('IMAP address conflict');
    this.name = 'ImapAddressConflictError';
  }
}

export class InvalidImapUsernameError extends NoAssetCreatedError {
  readonly status = 400;

  constructor() {
    super('Invalid IMAP username');
    this.name = 'InvalidImapUsernameError';
  }
}

export function isImapAddressConflict(error: unknown): boolean {
  return error instanceof ImapAddressConflictError
    || (errorCode(error) === 'SQLITE_CONSTRAINT_TRIGGER' && errorMessage(error) === 'IMAP active address conflict');
}

export function httpStatus(error: unknown, fallback = 500): number {
  if (!error || typeof error !== 'object' || !('status' in error)) return fallback;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : fallback;
}

export function retryAfterHeader(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('retryAfter' in error)) return undefined;
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  return typeof retryAfter === 'string' ? retryAfter : undefined;
}

export function isRateLimitError(error: unknown): boolean {
  if (httpStatus(error, 0) === 429) return true;
  return /\b429\b|rate[- ]?limit|too many requests/i.test(errorMessage(error));
}

export function isTransientUpstreamError(error: unknown): boolean {
  // Wrapping asset-sensitive create failures must retain the same dispatch
  // cooldown/fallback policy as the original network or HTTP failure.
  if (error instanceof TemplateCreationRecoveryError) return isTransientUpstreamError(error.cause);
  const status = httpStatus(error, 0);
  if (status >= 500 && status < 600) return true;
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  const code = errorCode(error);
  return !!code && /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT)$/.test(code);
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
  const fields = Object.getOwnPropertyDescriptors(extra);
  fields.error = { value: error, enumerable: true };
  logger.warn(message, Object.create(null, fields));
}
