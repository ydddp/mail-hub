import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { errorMessage, logIgnoredError, TemplateCreationRecoveryError, UpstreamHttpError } from '../src/errors.js';
import { getDb } from '../src/db.js';
import { app, jsonHeaders } from './helpers/http.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { TemplateProvider } from '../src/providers/template-provider.js';
import { createApp } from '../src/app.js';

function captureOutput() {
  const chunks: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
  }
  return {
    text: () => chunks.join(''),
    entries: () => chunks.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// This new suite locks the credential-output boundary shared by every backend
// logger, including errors whose opaque secrets have no recognizable prefix.
describe('credential-safe backend logs', () => {
  it.each([
    { failure: Object.assign(new Error('opaque-diagnostic-secret https://user:opaque-diagnostic-secret@private.test/body'), { code: 'ENOSPC', body: 'opaque-diagnostic-secret' }), category: 'error', errorClass: 'Error', code: 'ENOSPC' },
    { failure: Object.assign(new TypeError('opaque-diagnostic-secret'), { code: 'ECONNRESET', body: 'opaque-diagnostic-secret' }), category: 'network', errorClass: 'TypeError', code: 'ECONNRESET' },
  ])('retains safe $code diagnostics through the actual unhandled request failure', async ({ failure, category, errorClass, code }) => {
    const output = captureOutput();
    const diagnosticApp = createApp();
    diagnosticApp.get('/diagnostic-failure', () => { throw failure; });
    const response = await diagnosticApp.request('/diagnostic-failure');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
    expect(output.entries().find(entry => entry.msg === 'unhandled error'))
      .toMatchObject({ error: { class: errorClass, category, code } });
    expect(output.text()).not.toContain('opaque-diagnostic-secret');
    expect(output.text()).not.toContain('private.test');
  });

  it('redacts nested credentials and URLs while retaining controlled diagnostics on both streams', () => {
    const output = captureOutput();
    const markers = ['opaque-key-71', 'opaque-token-72', 'opaque-password-73', 'opaque-cookie-74', 'opaque-proxy-75', 'opaque-path-76', 'opaque-detail-77'];
    const error = new UpstreamHttpError(markers.join(' '), 503, markers[1], markers[3]);
    const extra = {
      provider: 'yyds', operation: 'check', status: 503, fingerprint: 'a12b34c56d78',
      api_key: markers[0], auth: { bearer: markers[1] }, nested: [{
        ...Object.fromEntries(['owner_key', 'signingKey', 'encryptionKey', 'key', 'api_key', 'refreshToken', 'password', 'set-cookie', 'authorization', 'headers'].map(field => [field, markers[0]])),
        password: markers[2], headers: { Cookie: markers[3] },
      }],
      proxy: `socks5://user:${markers[4]}@proxy.test`, apiBase: `https://api.test/${markers[5]}`,
      target: `https://api.test/${markers[5]}`, detail: markers[6], message: markers[6], body: markers[6], stack: markers[6], error, lastError: error,
      time: 'forged', level: 'forged', module: 'forged', msg: markers[0],
    };
    const log = createLogger('safe-test');
    log.warn('operation failed', extra);
    log.error('operation failed', extra);
    for (const marker of markers) expect(output.text()).not.toContain(marker);
    expect(output.entries()).toHaveLength(2);
    for (const entry of output.entries()) {
      expect(entry).toMatchObject({ module: 'safe-test', msg: 'operation failed', provider: 'yyds', operation: 'check', status: 503, fingerprint: 'a12b34c56d78', error: { class: 'UpstreamHttpError', category: 'upstream_http', status: 503 } });
      expect(entry.time).not.toBe('forged');
      expect(entry.lastError).toEqual(entry.error);
      expect(['warn', 'error']).toContain(entry.level);
      expect(Array.isArray(entry.nested)).toBe(true);
    }
    expect(errorMessage(error)).toBe(markers.join(' '));
    expect(error.body).toBe(markers[3]);
  });

  it('does not execute object hooks or getters and handles cycles without exposing arbitrary error names or codes', () => {
    const output = captureOutput();
    const getter = vi.fn(() => { throw new Error('getter must not execute'); });
    const toJSON = vi.fn(() => ({ password: 'opaque-hook-80' }));
    const toString = vi.fn(() => 'opaque-hook-81');
    const nested: Record<string, unknown> = { toJSON, toString, operation: 'read' };
    Object.defineProperty(nested, 'provider', { get: getter, enumerable: true });
    nested.self = nested;
    const error = Object.assign(new Error('opaque-error-82'), { name: 'opaque-name-83', code: 'opaque-code-84', status: 502 });
    expect(() => createLogger('safe-test').warn('safe object', { nested, error })).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(output.text()).not.toMatch(/opaque-/);
    expect(output.entries()[0]).toMatchObject({ nested: { operation: 'read' }, error: { class: 'Error', status: 502 } });
  });

  it('passes original ignored errors through the controlled error metadata boundary', () => {
    const output = captureOutput();
    const error = Object.assign(new TypeError('opaque-ignored-85'), { code: 'ECONNRESET' });
    const getter = vi.fn(() => { throw new Error('getter must not execute'); });
    const extra = Object.defineProperty({ provider: 'imap', operation: 'logout' }, 'headers', { get: getter, enumerable: true });
    expect(() => logIgnoredError(createLogger('safe-test'), 'ignored operation failed', error, extra)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(output.text()).not.toContain('opaque-ignored-85');
    expect(output.entries()[0]).toMatchObject({ provider: 'imap', operation: 'logout', error: { class: 'TypeError', category: 'network', code: 'ECONNRESET' } });
  });

  it('keeps malformed JSON snippets and arbitrary request headers out of logs while preserving the API response', async () => {
    const output = captureOutput();
    const marker = 'opaque-json-secret-86';
    const response = await app.request('/api/blocks', { method: 'POST', headers: { ...jsonHeaders(), 'x-request-id': marker, 'x-forwarded-for': marker, 'user-agent': marker }, body: marker });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON in request body' });
    expect(response.headers.get('X-Request-Id')).toBe(marker);
    expect(output.text()).not.toContain(marker);
    expect(output.text()).not.toContain('opaque-jso');
    expect(output.entries().some(entry => entry.msg === 'invalid JSON request body')).toBe(true);
    expect(JSON.stringify(getDb().prepare('SELECT text FROM activity_log').all())).not.toContain(marker);
  });

  it.each(['create', 'authenticate'])('keeps template %s payload private while retaining safe failure diagnostics', async (stage) => {
    const output = captureOutput();
    const body = 'opaque-template-body-87';
    const retryAfter = 'opaque-retry-header-88';
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === (stage === 'create' ? 'guerrillamail' : 'mailtm'))!.config);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => stage === 'authenticate' && String(url).endsWith('/accounts')
      ? new Response('{"address":"opaque-owned-89@example.test","id":"opaque-account-90"}', { status: 201 })
      : new Response(body, { status: 503, headers: { 'Retry-After': retryAfter } })));
    const error = await new TemplateProvider(cfg).createInbox({ domain: 'example.test' }).catch(error => error);
    // R05 intentionally replaced raw upstream payloads on ordinary errors
    // with a safe wrapper. The complete response now belongs to the private
    // durable recovery record; the logger still owes operators safe metadata.
    expect(error).toBeInstanceOf(TemplateCreationRecoveryError);
    expect(error).toMatchObject({ message: 'Template inbox creation requires recovery', status: 503, retryAfter });
    expect(error).not.toHaveProperty('body');
    const row = getDb().prepare('SELECT response_history_json FROM creation_recoveries WHERE id = ?').get(error.recoveryId) as { response_history_json: string };
    expect(JSON.parse(row.response_history_json)).toEqual(expect.arrayContaining([expect.objectContaining({ stage, status: 503, rawBody: body })]));
    expect(output.text()).not.toContain(body);
    expect(output.text()).not.toContain(retryAfter);
    expect(output.text()).not.toContain(error.recoveryId);
    expect(output.text()).not.toMatch(/opaque-owned-89|opaque-account-90/);
    expect(output.entries()).toHaveLength(1);
    expect(output.entries()[0]).toMatchObject({
      module: 'template-provider', msg: stage === 'create' ? 'template provider create failed' : 'template provider authentication failed',
      provider: cfg.name, status: 503, error: { class: 'UpstreamHttpError', category: 'upstream_http', status: 503 },
    });
  });
});
