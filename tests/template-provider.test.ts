import { describe, expect, it } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../src/providers/base.js';
import type { TemplateProviderConfig } from '../src/providers/template-provider.js';
import { app, authHeaders, jsonHeaders, jsonOf } from './helpers/http.js';

const validConfig = {
  name: 'test-tmpl',
  displayName: 'Test Template',
  apiBase: 'https://api.example.com',
  domains: { mode: 'list' as const, endpoint: '/domains' },
  create: { method: 'POST' as const, endpoint: '/accounts', body: '{"address":"{{user}}@{{domain}}","password":"{{password}}"}' },
  messages: { method: 'GET' as const, endpoint: '/accounts/{{id}}/messages' },
  messageDetail: { method: 'GET' as const, endpoint: '/messages/{{messageId}}' },
};

function makeConfig(overrides: Partial<TemplateProviderConfig> = {}) {
  return { ...validConfig, ...overrides };
}

interface SuccessResponse { success: boolean; name?: string; enabled?: boolean }
interface ProviderListResponse { providers: TemplateProviderConfig[] }
interface ProviderConfigResponse { config: TemplateProviderConfig; enabled: boolean }
interface TemplateProviderRow { enabled: number; config_json: string }

class TestRegisteredProvider extends BaseProvider {
  meta: ProviderMeta = {
    name: '',
    displayName: 'Test registered provider',
    type: 'api',
    tier: 'free',
    trustLevel: 1,
    rateLimit: { createPerMinute: 1, pollPerMinute: 1 },
    retention: 'test',
    features: { customUsername: false, pollInbox: true, realtime: false, attachments: false },
  };

  constructor(name: string) {
    super();
    this.meta.name = name;
  }

  async getDomains(): Promise<string[]> { return []; }
  async createInbox(): Promise<InboxData> { throw new Error('not implemented'); }
  async getMessages(): Promise<Message[]> { return []; }
  async getMessage(): Promise<MessageDetail> { throw new Error('not implemented'); }
}

describe('template-provider CRUD', () => {
  describe('POST /api/template-providers', () => {
    it('creates a new template provider', async () => {
      const res = await app.request('/api/template-providers', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: validConfig }),
      });
      const data = await jsonOf<SuccessResponse>(res);
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.name).toBe('test-tmpl');

      const row = getRow<TemplateProviderRow>(getDb(), `SELECT * FROM template_providers WHERE name = ?`, 'test-tmpl');
      expect(row).toBeDefined();
      expect(row?.enabled).toBe(1);

      expect(registry.get('test-tmpl')).toBeDefined();
    });

    it('rejects duplicate name', async () => {
      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('dup', JSON.stringify(validConfig));

      const res = await app.request('/api/template-providers', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: makeConfig({ name: 'dup' }) }),
      });
      expect(res.status).toBe(409);
    });

    it('rejects incomplete config', async () => {
      const res = await app.request('/api/template-providers', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: { name: 'bad' } }),
      });
      expect(res.status).toBe(400);
    });

    it('requires admin auth', async () => {
      const res = await app.request('/api/template-providers', {
        method: 'POST',
        headers: jsonHeaders('wrong-key'),
        body: JSON.stringify({ config: validConfig }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/template-providers', () => {
    it('lists all template providers including newly added', async () => {
      const baseRes = await app.request('/api/template-providers', { headers: authHeaders() });
      const baseData = await jsonOf<ProviderListResponse>(baseRes);
      const baseCount = baseData.providers.length;

      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('tp1', JSON.stringify(makeConfig({ name: 'tp1' })));
      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('tp2', JSON.stringify(makeConfig({ name: 'tp2' })));

      const res = await app.request('/api/template-providers', { headers: authHeaders() });
      const data = await jsonOf<ProviderListResponse>(res);
      expect(res.status).toBe(200);
      expect(data.providers).toHaveLength(baseCount + 2);
    });

    it('returns providers as array', async () => {
      const res = await app.request('/api/template-providers', { headers: authHeaders() });
      const data = await jsonOf<ProviderListResponse>(res);
      expect(Array.isArray(data.providers)).toBe(true);
    });
  });

  describe('GET /api/template-providers/:name', () => {
    it('returns single provider config', async () => {
      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('tp-get', JSON.stringify(makeConfig({ name: 'tp-get' })));

      const res = await app.request('/api/template-providers/tp-get', { headers: authHeaders() });
      const data = await jsonOf<ProviderConfigResponse>(res);
      expect(res.status).toBe(200);
      expect(data.config.name).toBe('tp-get');
      expect(data.enabled).toBe(true);
    });

    it('returns 404 for missing provider', async () => {
      const res = await app.request('/api/template-providers/nope', { headers: authHeaders() });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/template-providers/:name', () => {
    it('updates an existing provider', async () => {
      const cfg = makeConfig({ name: 'tp-upd' });
      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('tp-upd', JSON.stringify(cfg));
      registry.register(new TestRegisteredProvider('tp-upd'));

      const updated = makeConfig({ name: 'tp-upd', displayName: 'Updated Name' });
      const res = await app.request('/api/template-providers/tp-upd', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: updated }),
      });
      expect(res.status).toBe(200);

      const row = getRow<TemplateProviderRow>(getDb(), `SELECT config_json FROM template_providers WHERE name = ?`, 'tp-upd');
      const stored = JSON.parse(row?.config_json ?? '{}');
      expect(stored.displayName).toBe('Updated Name');
    });

    it('returns 404 for non-existent provider', async () => {
      const res = await app.request('/api/template-providers/nope', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: validConfig }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects incomplete config', async () => {
      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('tp-bad', JSON.stringify(validConfig));

      const res = await app.request('/api/template-providers/tp-bad', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: { name: 'tp-bad' } }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/template-providers/:name', () => {
    it('deletes a provider and unregisters it', async () => {
      getDb().prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run('tp-del', JSON.stringify(validConfig));
      registry.register(new TestRegisteredProvider('tp-del'));

      const res = await app.request('/api/template-providers/tp-del', {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await jsonOf<SuccessResponse>(res);
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);

      const row = getDb().prepare(`SELECT * FROM template_providers WHERE name = ?`).get('tp-del');
      expect(row).toBeUndefined();
      expect(registry.get('tp-del')).toBeUndefined();
    });
  });

  describe('PATCH /api/template-providers/:name/toggle', () => {
    it('disables a provider', async () => {
      const cfg = makeConfig({ name: 'tp-tog' });
      getDb().prepare(`INSERT INTO template_providers (name, config_json, enabled) VALUES (?, ?, 1)`).run('tp-tog', JSON.stringify(cfg));

      const res = await app.request('/api/template-providers/tp-tog/toggle', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ enabled: false }),
      });
      const data = await jsonOf<SuccessResponse>(res);
      expect(res.status).toBe(200);
      expect(data.enabled).toBe(false);

      const row = getRow<TemplateProviderRow>(getDb(), `SELECT enabled FROM template_providers WHERE name = ?`, 'tp-tog');
      expect(row?.enabled).toBe(0);
      expect(registry.get('tp-tog')).toBeUndefined();
    });

    it('enables a disabled provider', async () => {
      const cfg = makeConfig({ name: 'tp-en' });
      getDb().prepare(`INSERT INTO template_providers (name, config_json, enabled) VALUES (?, ?, 0)`).run('tp-en', JSON.stringify(cfg));

      const res = await app.request('/api/template-providers/tp-en/toggle', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ enabled: true }),
      });
      const data = await jsonOf<SuccessResponse>(res);
      expect(data.enabled).toBe(true);

      const row = getRow<TemplateProviderRow>(getDb(), `SELECT enabled FROM template_providers WHERE name = ?`, 'tp-en');
      expect(row?.enabled).toBe(1);
    });

    it('returns 404 for missing provider', async () => {
      const res = await app.request('/api/template-providers/nope/toggle', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
    });
  });
});
