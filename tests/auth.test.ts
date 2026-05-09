import { describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
import { hashApiKey } from '../src/crypto.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';

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
});
