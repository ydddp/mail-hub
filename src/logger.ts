import { isIP } from 'node:net';
import { isNativeError } from 'node:util/types';

type Level = 'info' | 'warn' | 'error';

const RESERVED_FIELDS = new Set(['time', 'level', 'module', 'msg']);
const ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'UpstreamHttpError', 'NoAssetCreatedError', 'MessageNotFoundError', 'ImapAddressConflictError', 'InvalidImapUsernameError',
  'AbortError', 'TimeoutError',
]);
const ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOSPC', 'EBUSY',
  'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_TRIGGER', 'SQLITE_CONSTRAINT_UNIQUE',
]);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const OMIT_FIELDS = /^(?:raw)?(?:message|detail|body|stack|retryafter)$|^rawerror$|^(?:error|lasterror)(?:message|detail|body|stack)$/;
const CREDENTIAL_FIELDS = /auth|header|cookie|token|password|passwd|passphrase|secret|credential|proxy|apibase|url|uri|endpoint|key/;

/** Read data only: diagnostics must never invoke an untrusted getter or hook. */
function ownData(object: object): Record<string, PropertyDescriptor> {
  try { return Object.getOwnPropertyDescriptors(object); }
  catch { return {}; }
}

function errorMetadata(error: object): Record<string, unknown> {
  const fields = ownData(error);
  const name = fields.name?.value;
  const code = fields.code?.value;
  const status = fields.status?.value ?? fields.statusCode?.value;
  const nativeError = isNativeError(error);
  // Built-in error names normally live on the prototype. Prefer their native
  // type over arbitrary constructor/name values supplied by an upstream.
  const errorClass = typeof name === 'string' && ERROR_CLASSES.has(name) ? name
    : nativeError && error instanceof TypeError ? 'TypeError'
    : nativeError && error instanceof SyntaxError ? 'SyntaxError'
    : nativeError && error instanceof RangeError ? 'RangeError' : 'Error';
  const safeCode = typeof code === 'string' && ERROR_CODES.has(code) ? code : undefined;
  const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const category = safeCode && NETWORK_CODES.has(safeCode) ? 'network'
    : errorClass === 'TimeoutError' ? 'timeout'
    : errorClass === 'AbortError' ? 'aborted'
    : safeStatus !== undefined ? 'upstream_http' : 'error';
  return { class: errorClass, category, ...(safeStatus === undefined ? {} : { status: safeStatus }), ...(safeCode ? { code: safeCode } : {}) };
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') {
    // Credentials can live in URL paths as well as userinfo/query parameters.
    return value.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, '[REDACTED_URL]');
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'object') return undefined;
  if (isNativeError(value)) return errorMetadata(value);
  if (depth >= 8) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const fields = ownData(value);
  const result: Record<string, unknown> = Object.create(null);
  // Descriptor values avoid Object.entries/spread/JSON.stringify invoking
  // getters or a custom toJSON. Functions and symbols never reach JSON.
  for (const [field, descriptor] of Object.entries(fields).slice(0, 100)) {
    if (!descriptor.enumerable || !('value' in descriptor)) continue;
    const key = field.replace(/[^a-z\d]/gi, '').toLowerCase();
    if (RESERVED_FIELDS.has(key) || OMIT_FIELDS.test(key) || key === 'useragent') continue;
    if (CREDENTIAL_FIELDS.test(key)) { result[field] = '[REDACTED]'; continue; }
    if (key === 'error' || key === 'lasterror') {
      if (descriptor.value && typeof descriptor.value === 'object') result[field] = errorMetadata(descriptor.value);
      continue;
    }
    if (key === 'code' && !(typeof descriptor.value === 'string' && ERROR_CODES.has(descriptor.value))) continue;
    if (key === 'requestid' && !(typeof descriptor.value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(descriptor.value))) continue;
    if (key === 'ip' && !(typeof descriptor.value === 'string' && isIP(descriptor.value))) continue;
    // Request completion, malformed JSON and unhandled-error logs all use
    // path. A private recovery ID must not escape through any of those sites.
    const value = key === 'path' && typeof descriptor.value === 'string'
      ? descriptor.value.replace(/(\/template-providers\/[^/]+\/recoveries\/)[^/]+/g, '$1:id')
      : descriptor.value;
    const sanitized = sanitizeValue(value, seen, depth + 1);
    if (sanitized !== undefined) result[field] = sanitized;
  }
  seen.delete(value);
  return Array.isArray(value)
    ? Object.keys(result).filter(key => /^\d+$/.test(key)).map(key => result[key])
    : result;
}

function emit(level: Level, module: string, message: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = Object.assign(Object.create(null), {
    time: new Date().toISOString(),
    level,
    module,
    msg: message,
  });
  if (extra) Object.assign(entry, sanitizeValue(extra, new WeakSet(), 0));
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function createLogger(module: string) {
  return {
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', module, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', module, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', module, msg, extra),
  };
}
