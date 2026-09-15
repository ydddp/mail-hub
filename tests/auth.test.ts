import { describe, expect, it } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { hashApiKey } from '../src/crypto.js';
import { IMPORT_BODY_LIMIT_BYTES, REQUEST_BODY_LIMIT_BYTES } from '../src/app.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';

const CHUNK_BYTES = 64 * 1024;

// Pull-driven upload: with highWaterMark 0 a chunk is produced only when the
// server asks for it, so `pulled` is exactly how much of the body it consumed.
function meteredBody(totalBytes: number) {
  if (!Number.isSafeInteger(totalBytes)) throw new TypeError(`body size must be an integer, got ${totalBytes}`);
  const meter = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = Math.min(CHUNK_BYTES, totalBytes - meter.pulled);
      if (size <= 0) return controller.close();
      meter.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() {
      meter.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, meter };
}

function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

type StreamOptions = { method?: string; token?: string; contentType?: string; contentLength?: number };

// Sends no Content-Length unless one is given, like a chunked upload.
function sendStream(path: string, body: ReadableStream<Uint8Array>, opts: StreamOptions = {}) {
  const headers: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.contentLength !== undefined) headers['Content-Length'] = String(opts.contentLength);
  return app.request(path, { method: opts.method ?? 'POST', headers, body, duplex: 'half' } as RequestInit);
}

describe('API authentication and admin boundaries', () => {
  it('rejects API requests without a bearer token', async () => {
    const res = await app.request('/api/providers');

    expect(res.status).toBe(401);
  });

  it('allows ordinary API keys to read public provider metadata', async () => {
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey('mk_user'), 'user');

    const res = await app.request('/api/providers', { headers: authHeaders('mk_user') });

    expect(res.status).toBe(200);
  });

  it('blocks ordinary API keys from admin-only routes', async () => {
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey('mk_user'), 'user');

    const cases: Array<[string, RequestInit]> = [
      ['/api/keys', { headers: authHeaders('mk_user') }],
      ['/api/activity', { headers: authHeaders('mk_user') }],
      ['/api/outlook/accounts', { headers: authHeaders('mk_user') }],
      ['/api/yyds/accounts', { headers: authHeaders('mk_user') }],
      ['/api/providers/mailtm', { method: 'PATCH', headers: jsonHeaders('mk_user'), body: JSON.stringify({ enabled: false }) }],
      ['/api/blocks', { method: 'POST', headers: jsonHeaders('mk_user'), body: JSON.stringify({ service: 'svc', domain: 'example.test' }) }],
    ];

    for (const [path, init] of cases) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(403);
    }
  });

  it('allows the admin secret to manage protected resources', async () => {
    const res = await app.request('/api/blocks', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ service: 'svc', domain: 'example.test' }),
    });

    expect(res.status).toBe(201);
  });

  it('consumes daily API key quota atomically', async () => {
    const keyHash = hashApiKey('mk_limited');
    getDb().prepare(
      `INSERT INTO api_keys (key, name, daily_limit, daily_calls, daily_reset_at) VALUES (?, ?, 1, 0, ?)`,
    ).run(keyHash, 'limited', new Date().toISOString().slice(0, 10));

    const first = await app.request('/api/providers', { headers: authHeaders('mk_limited') });
    const second = await app.request('/api/providers', { headers: authHeaders('mk_limited') });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    const row = getRow<{ call_count: number; daily_calls: number }>(
      getDb(),
      `SELECT call_count, daily_calls FROM api_keys WHERE key = ?`,
      keyHash,
    );
    expect(row).toEqual({ call_count: 1, daily_calls: 1 });
  });
});

describe('API request body limits', () => {
  it.each([
    { name: 'a JSON POST without a token', path: '/api/inbox' },
    { name: 'a JSON POST with an unknown key', path: '/api/inbox', token: 'mk_unknown' },
    { name: 'a POST to the public OAuth callback path', path: '/api/outlook/oauth/callback' },
    { name: 'a non-JSON DELETE', path: '/api/yyds/accounts', method: 'DELETE', contentType: 'text/plain' },
  ])('rejects $name before reading its body', async ({ path, method, token, contentType }) => {
    const { stream, meter } = meteredBody(2 * REQUEST_BODY_LIMIT_BYTES);

    const res = await sendStream(path, stream, { method, token, contentType });

    expect(res.status).toBe(401);
    expect(meter.pulled).toBe(0);
  });

  it.each([
    { name: 'a chunked JSON body with no length', path: '/api/blocks' },
    { name: 'a body whose Content-Length under-reports it', path: '/api/blocks', contentLength: 64 },
    { name: 'a non-JSON DELETE body the route reads itself', path: '/api/yyds/accounts', method: 'DELETE', contentType: 'text/plain' },
    { name: 'an ordinary key creating an inbox', path: '/api/inbox', token: 'mk_user' },
    { name: 'an ordinary key on an import route', path: '/api/outlook/import', token: 'mk_user' },
    { name: 'an admin import past the import limit', path: '/api/outlook/import', limit: IMPORT_BODY_LIMIT_BYTES },
  ])('stops reading $name once it passes the limit', async ({
    path, method, token = 'admin-secret', contentType, contentLength, limit = REQUEST_BODY_LIMIT_BYTES,
  }) => {
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey('mk_user'), 'user');
    const { stream, meter } = meteredBody(limit + 16 * CHUNK_BYTES);

    const res = await sendStream(path, stream, { method, token, contentType, contentLength });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toHaveProperty('error');
    expect(meter.pulled).toBeLessThanOrEqual(limit + CHUNK_BYTES);
    expect(meter.cancelled).toBe(true);
  });

  it('rejects a declared Content-Length over the limit without reading the body', async () => {
    const { stream, meter } = meteredBody(REQUEST_BODY_LIMIT_BYTES + 1);

    const res = await sendStream('/api/blocks', stream, { token: 'admin-secret', contentLength: REQUEST_BODY_LIMIT_BYTES + 1 });

    expect(res.status).toBe(413);
    expect(meter.pulled).toBe(0);
  });

  it('accepts a chunked body of exactly the limit split inside a UTF-8 character', async () => {
    const skeleton = { service: '测试服务', domain: 'example.test', reason: '' };
    const padding = REQUEST_BODY_LIMIT_BYTES - Buffer.byteLength(JSON.stringify(skeleton));
    const bytes = new TextEncoder().encode(JSON.stringify({ ...skeleton, reason: 'x'.repeat(padding) }));
    expect(bytes.byteLength).toBe(REQUEST_BODY_LIMIT_BYTES);
    const splitAt = Buffer.byteLength('{"service":"') + 1;
    const chunks = [bytes.subarray(0, splitAt)];
    for (let i = splitAt; i < bytes.byteLength; i += CHUNK_BYTES) chunks.push(bytes.subarray(i, i + CHUNK_BYTES));

    const res = await sendStream('/api/blocks', chunkedBody(chunks), { token: 'admin-secret' });

    expect(res.status).toBe(201);
    expect(getRow(getDb(), `SELECT service FROM blocks WHERE domain = ?`, 'example.test')).toEqual({ service: '测试服务' });
  });

  it('imports an Outlook batch larger than the default limit', async () => {
    // A real account line is ~520 bytes, most of it the refresh token.
    const count = 4000;
    const lines = Array.from({ length: count }, (_, i) =>
      `user${i}@outlook.com----Passw0rd${i}----11111111-1111-1111-1111-111111111111----M.C5${'x'.repeat(433)}`);
    const body = JSON.stringify({ accounts: lines.join('\n'), type: 'long' });
    expect(Buffer.byteLength(body)).toBeGreaterThan(REQUEST_BODY_LIMIT_BYTES);

    const res = await app.request('/api/outlook/import', { method: 'POST', headers: jsonHeaders(), body });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ imported: count, skipped: 0 });
  });

  it('still rejects malformed JSON from an authenticated caller', async () => {
    const res = await app.request('/api/blocks', { method: 'POST', headers: jsonHeaders(), body: '{"service":' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid JSON in request body' });
  });
});
