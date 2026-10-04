import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../src/providers/base.js';
import { TemplateProvider, type TemplateProviderConfig } from '../src/providers/template-provider.js';
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

describe('template message timestamp contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])('reads TempMail.lol milliseconds with legacy config=%s', async (legacy) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'tempmail-lol')!.config);
    if (legacy) { delete cfg.messages.timestampFormat; delete cfg.messageDetail.timestampFormat; }
    const raw = { from: 'sender@example.test', subject: 'code', body: '123456', date: 1715200000000 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ emails: [raw] }))));
    const provider = new TemplateProvider(cfg);
    const inbox = {address:'test@example.test',provider:cfg.name,apiBase:cfg.apiBase,authData:{token:'test'}};
    const expected = '2024-05-08T20:26:40.000Z';
    expect((await provider.getMessages(inbox))[0].receivedAt).toBe(expected);
    expect((await provider.getMessage(inbox, String(raw.date))).receivedAt).toBe(expected);
  });

  it.each(['mail_date', 'mail_timestamp'])('uses Guerrilla Mail Unix time with %s mappings (including legacy DB configs)', async (field) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'guerrillamail')!.config);
    cfg.messages.itemMapping.receivedAt = field;
    cfg.messageDetail.responseMapping.receivedAt = field;
    // Real upstream field sample retained in docs/providers/guerrillamail-api.md.
    const raw = { mail_id: 'm1', mail_date: '02:38:20', mail_timestamp: 1778294300 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('fetch_email') ? raw : { list: [raw] }))));
    const provider = new TemplateProvider(cfg);
    const inbox = { address: 'test@example.test', provider: cfg.name, apiBase: cfg.apiBase, authData: { sid: 'test' } };
    const expected = new Date(raw.mail_timestamp * 1000).toISOString();
    expect((await provider.getMessages(inbox))[0].receivedAt).toBe(expected);
    expect((await provider.getMessage(inbox, 'm1')).receivedAt).toBe(expected);
  });

  it.each([
    { value: '2026-10-04T21:00:00+09:00', format: 'iso', expected: '2026-10-04T12:00:00.000Z' },
    { value: '2026-10-04 12:00:00', format: 'utc', expected: '2026-10-04T12:00:00.000Z' },
    { value: '2026-10-04 12:00:00', format: 'iso', expected: '' },
    { value: 1791115200, format: 'unix_seconds', expected: '2026-10-04T12:00:00.000Z' },
    { value: '1791115200000', format: 'unix_milliseconds', expected: '2026-10-04T12:00:00.000Z' },
    { value: '12:00:00', format: 'iso', expected: '' },
  ] as const)('normalizes $format times on list and both detail paths', async ({ value, format, expected }) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES[0].config);
    cfg.messages.resultPath = '$root';
    cfg.messages.timestampFormat = format;
    cfg.messages.itemMapping = { id: 'id', from: 'from', subject: 'subject', excerpt: 'text', receivedAt: 'date' };
    cfg.messageDetail.timestampFormat = format;
    cfg.messageDetail.responseMapping = { id: 'id', from: 'from', subject: 'subject', receivedAt: 'date' };
    const raw = { id: 'm1', from: 'sender@example.test', subject: 'Code', text: '123456', date: value };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('/m1') ? raw : [raw]))));
    const inbox = { address: 'test@example.test', provider: cfg.name, apiBase: cfg.apiBase, authData: { token: 'test' } };
    const provider = new TemplateProvider(cfg);
    expect((await provider.getMessages(inbox))[0].receivedAt).toBe(expected);
    expect((await provider.getMessage(inbox, 'm1')).receivedAt).toBe(expected);
    cfg.messageDetail.fromList = true;
    const fromList = new TemplateProvider(cfg);
    expect((await fromList.getMessage(inbox, 'm1')).receivedAt).toBe(expected);
  });
});

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

    it('rejects deleting built-in providers', async () => {
      const res = await app.request('/api/template-providers/tempmail-lol', {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);

      const row = getDb().prepare(`SELECT * FROM template_providers WHERE name = ?`).get('tempmail-lol');
      expect(row).toBeDefined();
      expect(registry.get('tempmail-lol')).toBeDefined();
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

describe('template provider account password', () => {
  function passwordProvider() {
    return new TemplateProvider({
      name: 'pw-tmpl',
      displayName: 'PW',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 10 },
      retention: 'test',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://pw.example.test',
      auth: { type: 'none' },
      domains: { mode: 'static', list: ['pw.example.test'] },
      create: { path: '/accounts', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { address: 'address', authData: {} } },
      messages: { path: '/messages', authFrom: 'inbox', itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'excerpt', receivedAt: 'receivedAt' } },
      messageDetail: { path: '/messages/{{messageId}}', authFrom: 'inbox', responseMapping: { id: 'id', from: 'from', subject: 'subject', receivedAt: 'receivedAt' } },
    });
  }

  /** Create one inbox and return the password actually sent upstream. */
  async function capturePassword(): Promise<string> {
    let sent = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { address?: string; password?: string };
      if (body.password) sent = body.password;
      return new Response(JSON.stringify({ address: body.address ?? 'x@pw.example.test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      await passwordProvider().createInbox({ domain: 'pw.example.test' });
    } finally {
      vi.unstubAllGlobals();
    }
    return sent;
  }

  it('sends a password upstream at all', async () => {
    expect(await capturePassword()).not.toBe('');
  });

  it('does not repeat a password across accounts', async () => {
    expect(await capturePassword()).not.toBe(await capturePassword());
  });

  // The lock: this password is the upstream mailbox's only credential, so it
  // must come from a CSPRNG. Pinning Math.random would freeze any
  // Math.random()-derived value — a constant password here means the
  // generator regressed to a predictable sequence.
  it('stays unpredictable even when Math.random is pinned', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.42);
    try {
      expect(await capturePassword()).not.toBe(await capturePassword());
    } finally {
      spy.mockRestore();
    }
  });

  it('carries enough entropy to resist guessing', async () => {
    const pw = await capturePassword();
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(new Set(pw).size).toBeGreaterThan(8);
  });
});

describe('template provider domain failure caching', () => {
  it('caches a failed domain fetch briefly instead of refetching every call', async () => {
    const provider = new TemplateProvider({
      name: 'negcache-tmpl',
      displayName: 'NegCache',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 10 },
      retention: 'test',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://negcache.example.test',
      auth: { type: 'none' },
      domains: { mode: 'endpoint', path: '/domains' },
      create: { path: '/accounts', method: 'POST', responseMapping: { address: 'address', authData: {} } },
      messages: { path: '/messages', authFrom: 'inbox', itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'excerpt', receivedAt: 'receivedAt' } },
      messageDetail: { path: '/messages/{{messageId}}', authFrom: 'inbox', responseMapping: { id: 'id', from: 'from', subject: 'subject', receivedAt: 'receivedAt' } },
    });
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(provider.getDomains()).resolves.toEqual([]);
      await expect(provider.getDomains()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
