import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { registry } from '../src/providers/registry.js';
import { TemplateProvider } from '../src/providers/template-provider.js';
import { app, jsonHeaders } from './helpers/http.js';

describe('provider configuration routes', () => {
  afterEach(() => vi.unstubAllGlobals());

  const fromCreateNames = ['tempmail-lol', 'tempmail-ing', 'runtime-from-create'];
  const readCases = fromCreateNames.flatMap(name => ['active', 'disabled', 'cooldown'].map(state => ({ name, state })));

  // Both public GETs must remain safe to refresh regardless of dispatch state.
  it.each(readCases)('reads $name domains without creation while $state', async ({ name, state }) => {
    if (name === 'runtime-from-create') {
      const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'tempmail-lol')!.config);
      cfg.name = name;
      const res = await app.request('/api/template-providers', {
        method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ config: cfg }),
      });
      expect(res.status).toBe(200);
    }
    if (state === 'disabled') getDb().prepare('UPDATE provider_config SET enabled = 0 WHERE provider = ?').run(name);
    if (state === 'cooldown') rateLimiter.setCooldown(name, Date.now() + 60_000, 'rate-limit');
    const provider = registry.get(name)!;
    const create = vi.spyOn(provider, 'createInbox');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      address: 'allocated@upstream.test', token: 'test-token', email: { address: 'allocated@upstream.test' },
    })));
    vi.stubGlobal('fetch', fetchMock);

    for (let repeat = 0; repeat < 2; repeat++) {
      for (const suffix of ['', '/domains']) {
        const res = await app.request(`/api/providers/${name}${suffix}`, { headers: jsonHeaders() });
        const data = await res.json() as { domainMode: string; domains: string[] };
        expect(res.status).toBe(200);
        expect(create).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(data.domainMode).toBe('from_create');
        expect(data.domains).toEqual([]);
      }
    }
    expect(getRow<{ count: number }>(getDb(), 'SELECT COUNT(*) AS count FROM inboxes')?.count).toBe(0);
  });

  it.each(['tempmail-lol', 'tempmail-ing'])('does not create when disabled template %s is unregistered', async (name) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const toggle = await app.request(`/api/template-providers/${name}/toggle`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);
    for (const suffix of ['', '/domains']) {
      const res = await app.request(`/api/providers/${name}${suffix}`, { headers: jsonHeaders() });
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(fromCreateNames)('saves one controlled %s inbox after read-only inspection', async (name) => {
    if (name === 'runtime-from-create') {
      const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'tempmail-lol')!.config);
      cfg.name = name;
      registry.register(new TemplateProvider(cfg));
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      address: 'allocated@upstream.test', token: 'test-token', email: { address: 'allocated@upstream.test' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    for (const suffix of ['', '/domains']) {
      await app.request(`/api/providers/${name}${suffix}`, { headers: jsonHeaders() });
    }
    const res = await app.request('/api/inbox', {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ for: 'r06.test', provider: name }),
    });
    const data = await res.json() as { id: string; address: string };
    expect(res.status).toBe(201);
    expect(data.address).toBe('allocated@upstream.test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRow<{ address: string; provider: string }>(getDb(), 'SELECT address, provider FROM inboxes WHERE id = ?', data.id))
      .toEqual({ address: data.address, provider: name });
  });

  it('returns auto-dispatch state in the provider list', async () => {
    getDb().prepare(`UPDATE provider_config SET auto_dispatch = 0 WHERE provider = ?`).run('mailtm');

    const res = await app.request('/api/providers', { headers: jsonHeaders() });
    const data = await res.json() as { providers: Array<{ name: string; autoDispatch?: boolean }> };
    const provider = data.providers.find((p) => p.name === 'mailtm');

    expect(res.status).toBe(200);
    expect(provider?.autoDispatch).toBe(false);
  });

  it('updates auto-dispatch using the public API field name', async () => {
    getDb().prepare(`UPDATE provider_config SET auto_dispatch = 0 WHERE provider = ?`).run('mailtm');

    const res = await app.request('/api/providers/mailtm', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ autoDispatch: true }),
    });
    const data = await res.json() as { autoDispatch: boolean };
    const row = getRow<{ auto_dispatch: number }>(
      getDb(),
      `SELECT auto_dispatch FROM provider_config WHERE provider = ?`,
      'mailtm',
    );

    expect(res.status).toBe(200);
    expect(data.autoDispatch).toBe(true);
    expect(row?.auto_dispatch).toBe(1);
  });

  it('returns cooldown state in provider rate status', async () => {
    rateLimiter.setCooldown('mailtm', Date.now() + 60_000, 'rate-limit');

    const res = await app.request('/api/providers', { headers: jsonHeaders() });
    const data = await res.json() as {
      providers: Array<{
        name: string;
        rateStatus?: { available: boolean; nextAvailableAt: string | null; cooldownReason?: string | null };
      }>;
    };
    const provider = data.providers.find((p) => p.name === 'mailtm');

    expect(res.status).toBe(200);
    expect(provider?.rateStatus?.available).toBe(false);
    expect(provider?.rateStatus?.cooldownReason).toBe('rate-limit');
    expect(provider?.rateStatus?.nextAvailableAt).not.toBeNull();
  });
});
