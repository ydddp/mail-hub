import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { registerAllProviders } from '../src/providers/index.js';
import { BaseProvider, type InboxData, type Message, type MessageDetail, type ProviderMeta } from '../src/providers/base.js';
import { TemplateProvider, type TemplateProviderConfig } from '../src/providers/template-provider.js';
import { app, authHeaders, jsonHeaders, jsonOf } from './helpers/http.js';
import { MessageNotFoundError, TemplateCreationRecoveryError, UpstreamHttpError } from '../src/errors.js';

const validConfig: TemplateProviderConfig = {
  ...structuredClone(BUILTIN_TEMPLATES[0].config),
  name: 'test-tmpl',
  displayName: 'Test Template',
  apiBase: 'https://api.example.com',
};

// Read failures must reach callers as failures; only a valid success list is empty mail.
describe('template message read failures', () => {
  afterEach(() => vi.unstubAllGlobals());
  function fixture(fromList = false) {
    const config = structuredClone(validConfig);
    config.messages.resultPath = '$root';
    config.messages.itemMapping = { id: 'id', from: 'from', subject: 'subject', excerpt: 'text', receivedAt: 'date', text: 'text', html: 'html' };
    config.messageDetail.fromList = fromList;
    config.messageDetail.responseMapping = { id: 'id', from: 'from', subject: 'subject', text: 'text', html: 'html', receivedAt: 'date' };
    const inbox = { address: 'read@example.test', provider: config.name, authData: { token: 'test' } };
    return { config, inbox };
  }

  it.each([401, 403, 429, 503].flatMap(status => ['list', 'detail'].map(operation => ({ status, operation }))))
    ('preserves $status and Retry-After for $operation without exposing the body', async ({ status, operation }) => {
    const { config, inbox } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private mail and credentials', { status, headers: { 'Retry-After': '17' } })));
    const provider = new TemplateProvider(config);
    const result = await (operation === 'list' ? provider.getMessages(inbox) : provider.getMessage(inbox, 'm1')).catch(e => e);
    expect(result).toBeInstanceOf(UpstreamHttpError);
    expect(result).toMatchObject({ status, retryAfter: '17' });
    expect(String(result)).not.toContain('private mail');
  });

  it.each(['list', 'detail'])('rejects private malformed JSON for %s with a safe diagnostic', async operation => {
    const { config, inbox } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-mail-invalid-json')));
    const provider = new TemplateProvider(config);
    const result = await (operation === 'list' ? provider.getMessages(inbox) : provider.getMessage(inbox, 'm1')).catch(e => e);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Template message response is invalid');
  });

  it.each([
    null, {}, { emails: [] }, 'private body', [null], ['message'], [[]], [{}], [{ id: '' }], [{ id: '  ' }], [{ id: true }], [{ id: {} }],
    { success: false, messages: [] }, { errors: [{ message: 'private GraphQL error' }], data: { session: { mails: [] } } },
  ].map(body => ({ body })))('rejects malformed or explicit failure lists %#', async ({ body }) => {
    const { config, inbox } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(new TemplateProvider(config).getMessages(inbox)).rejects.toThrow();
  });

  it.each([
    ['$root', []], ['$root', [{ id: 0 }]], ['hydra:member', { 'hydra:member': [{ id: 0 }] }],
    ['emails', { emails: [{ id: 0 }] }], ['list', { list: [{ id: 0 }] }],
    ['data.session.mails', { errors: [], data: { session: { mails: [{ id: 0 }] } } }],
  ])('accepts configured %s successful lists and zero IDs', async (path, body) => {
    const { config, inbox } = fixture(true);
    config.messages.resultPath = String(path);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    const provider = new TemplateProvider(config);
    const messages = await provider.getMessages(inbox);
    if (path === '$root' && Array.isArray(body) && body.length === 0) expect(messages).toEqual([]);
    else {
      expect(messages).toEqual([{ id: '0', from: '', subject: '', excerpt: '', receivedAt: '' }]);
      expect(await provider.getMessage(inbox, '0')).toMatchObject({ id: '0', text: '', html: '' });
    }
  });

  it.each([
    { path: 'emails', body: { success: false, emails: [] } },
    { path: 'data.session.mails', body: { errors: [{ message: 'private GraphQL error' }], data: { session: { mails: [] } } } },
  ])('rejects explicit failure even when $path resolves to a valid empty array', async ({ path, body }) => {
    const { config, inbox } = fixture();
    config.messages.resultPath = path;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(new TemplateProvider(config).getMessages(inbox)).rejects.toThrow(/reports failure/);
  });

  it.each([null, [], 'mail', {}, { error: 'private error' }, { success: false, subject: '' }, { errors: [{ message: 'private error' }], subject: '' }].map(body => ({ body })))
    ('rejects fabricated blank detail %#', async ({ body }) => {
    const { config, inbox } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(new TemplateProvider(config).getMessage(inbox, 'm1')).rejects.toThrow();
  });

  it.each([{ subject: '' }, { text: '' }, { id: 0 }])('accepts recognized blank detail with requested ID fallback %#', async body => {
    const { config, inbox } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await new TemplateProvider(config).getMessage(inbox, 'm1')).toMatchObject({ id: 'id' in body ? '0' : 'm1', subject: '', receivedAt: '' });
  });

  it('keeps the validated fromList cache when a later list contains an invalid item', async () => {
    const { config, inbox } = fixture(true);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'm1', subject: 'Original' }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'm1', subject: 'Invalid cache' }, null]))));
    const provider = new TemplateProvider(config);
    await provider.getMessages(inbox);
    await expect(provider.getMessages(inbox)).rejects.toThrow();
    expect(await provider.getMessage(inbox, 'm1')).toMatchObject({ subject: 'Original' });
    await expect(provider.getMessage(inbox, 'missing')).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});

// Template operations can write remotely even when their configured method is
// GET. A lost response must never allocate, authenticate or delete twice.
describe('template write retry safety', () => {
  it.each([
    ['guerrillamail', 'create'], ['guerrillamail', 'delete'],
    ['runtime-template', 'create'], ['runtime-template', 'postCreate'], ['runtime-template', 'delete'],
  ])('does not repeat %s %s after a remote write and disconnect', async (name, operation) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'guerrillamail')!.config);
    cfg.name = name;
    if (operation === 'postCreate') {
      cfg.create.skip = true;
      cfg.postCreate = { path: '?f=authenticate', method: 'GET', responseMapping: { authData: { token: 'token' } } };
    }
    let committedWrites = 0;
    const disconnected = new TypeError('response lost after remote commit');
    const fetchMock = vi.fn(async () => { committedWrites++; throw disconnected; });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const provider = new TemplateProvider(cfg);
      const operationPromise = operation === 'delete'
        ? provider.deleteInbox({ address: 'owned@example.test', provider: name, authData: { sid: 's' } })
        : provider.createInbox();
      const result = operationPromise.catch(error => error);
      await vi.runAllTimersAsync();
      // Creation now wraps failures to keep account/response material out of
      // ordinary errors. R09 still requires the original cause and one write;
      // deletion has no creation recovery boundary and keeps its old identity.
      if (operation === 'delete') expect(await result).toBe(disconnected);
      else {
        expect(await result).toBeInstanceOf(TemplateCreationRecoveryError);
        expect(await result).toMatchObject({ message: 'Template inbox creation requires recovery', cause: disconnected });
      }
      expect(committedWrites).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

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
    it.each([
      { mode: 'default', enabled: undefined, expected: 1 },
      { mode: 'enabled', enabled: true, expected: 1 },
      { mode: 'disabled', enabled: false, expected: 0 },
    ])('creates a new $mode template provider', async ({ mode, enabled, expected }) => {
      const config = makeConfig({ name: `test-tmpl-${mode}` });
      const res = await app.request('/api/template-providers', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ config, enabled }),
      });
      const data = await jsonOf<SuccessResponse>(res);
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.name).toBe(config.name);

      const row = getRow<TemplateProviderRow>(getDb(), `SELECT * FROM template_providers WHERE name = ?`, config.name);
      expect(row).toBeDefined();
      expect(row?.enabled).toBe(expected);

      expect(Boolean(registry.get(config.name))).toBe(expected === 1);
      registry.unregister(config.name);
      registerAllProviders();
      expect(Boolean(registry.get(config.name))).toBe(expected === 1);
    });

    it('field-tests a retained disabled config without enrolling it in dispatch', async () => {
      const config = makeConfig({
        name: '_test_retained_disabled',
        domains: { mode: 'static', list: ['local.example.test'] },
        create: { path: '/accounts', method: 'POST', body: { address: '{{address}}' }, responseMapping: { address: 'address', authData: { token: 'token' } } },
        postCreate: undefined,
        messages: { ...validConfig.messages, path: '/messages', resultPath: '$root' },
      });
      const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        expect(options?.method).not.toBe('DELETE');
        return new Response(String(url).endsWith('/accounts') ? '{"address":"owned@local.example.test","token":"private-token"}' : '[]', { status: 200 });
      });
      vi.stubGlobal('fetch', fetch);
      try {
        expect((await app.request('/api/template-providers', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ config, enabled: false }) })).status).toBe(200);
        const response = await app.request(`/api/template-providers/${config.name}/test`, { method: 'POST', headers: jsonHeaders() });
        const result = await jsonOf<{ success: boolean; recovery: { id: string; phase: string } }>(response);
        expect(result).toMatchObject({ success: true, recovery: { id: expect.any(String), phase: 'ready' } });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(getRow<TemplateProviderRow>(getDb(), 'SELECT enabled FROM template_providers WHERE name = ?', config.name)?.enabled).toBe(0);
        expect(registry.get(config.name)).toBeUndefined();
        expect(getDb().prepare('SELECT provider FROM provider_config WHERE provider = ?').get(config.name)).toBeUndefined();
        registerAllProviders();
        expect(registry.get(config.name)).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
        registry.unregister(config.name);
      }
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
      create: { path: '/accounts', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { address: 'address', authData: { token: 'token' } } },
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
      return new Response(JSON.stringify({ address: body.address ?? 'x@pw.example.test', token: 'test-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  it.each(['tempmail-lol', 'tempmail-ing', 'custom-from-create'])('never creates an inbox to read %s domains', async (name) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === (name === 'custom-from-create' ? 'tempmail-lol' : name))!.config);
    cfg.name = name;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      address: 'allocated@upstream.test', token: 'test-token', email: { address: 'allocated@upstream.test' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new TemplateProvider(cfg);
      const create = vi.spyOn(provider, 'createInbox');
      const domains = [await provider.getDomains(), await provider.getDomains()];
      expect(create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(domains).toEqual([[], []]);

      // Even a direct create has not been saved by dispatch, so it must not
      // become a domain-discovery cache entry.
      await provider.createInbox();
      await expect(provider.getDomains()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns configured from-create domains without probing upstream', async () => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'tempmail-lol')!.config);
    cfg.domains.list = ['known.example.test'];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ address: 'allocated@upstream.test' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(new TemplateProvider(cfg).getDomains()).resolves.toEqual(['known.example.test']);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves successful endpoint domain caching', async () => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'mailtm')!.config);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ 'hydra:member': [{ domain: 'cached.example.test', isActive: true }] })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new TemplateProvider(cfg);
      await expect(provider.getDomains()).resolves.toEqual(['cached.example.test']);
      await expect(provider.getDomains()).resolves.toEqual(['cached.example.test']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
