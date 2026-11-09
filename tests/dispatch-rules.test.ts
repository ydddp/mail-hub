import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../src/dispatcher.js';
import { getDb, getRow, getSetting, removeNullProviderConfigRows } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { UpstreamHttpError } from '../src/errors.js';
import { hashApiKey } from '../src/crypto.js';
import {
  SEEDED_FLAG,
  computeDefaultOrder,
  evaluateDispatch,
  resolveDispatchOrder,
  seedDispatchRulesFromPriority,
} from '../src/dispatch-rules.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';
import type { InboxData } from '../src/providers/base.js';

class FailingDomainsProvider extends FakeProvider {
  override async getDomains(): Promise<string[]> {
    this.getDomainsCount++;
    throw new UpstreamHttpError(`[${this.meta.name}] domains 503`, 503);
  }
}

class HangingDomainsProvider extends FakeProvider {
  override getDomains(): Promise<string[]> {
    this.getDomainsCount++;
    return new Promise(() => {});
  }
}

class TransientCreateProvider extends FakeProvider {
  override async createInbox(): Promise<InboxData> {
    this.createCount++;
    throw new UpstreamHttpError(`[${this.meta.name}] create 503`, 503);
  }
}

const OPEN = { createPerMinute: 0, pollPerMinute: 0 };

/** Disable every real provider so only the fakes registered here take part. */
function onlyFakes(...providers: FakeProvider[]): () => void {
  getDb().prepare(`UPDATE provider_config SET enabled = 0`).run();
  for (const p of providers) registry.register(p);
  return () => { for (const p of providers) registry.unregister(p.meta.name); };
}

function putRule(service: string, body: unknown, token = 'admin-secret') {
  return app.request(`/api/dispatch/rules/${encodeURIComponent(service)}`, {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
}

async function preview(service?: string, token = 'admin-secret') {
  const qs = service ? `?for=${encodeURIComponent(service)}` : '';
  const res = await app.request(`/api/dispatch/preview${qs}`, { headers: authHeaders(token) });
  return { res, data: await res.json() as { service: string | null; rule: { source: string; others: string }; candidates: Array<{ provider: string; eligible: boolean; reason?: string; cooldownReason?: string | null; nextAvailableAt?: string | null }> } };
}

describe('dispatch order resolution', () => {
  it('computes the default order by trustLevel, registration order for ties', () => {
    const cleanup = onlyFakes(
      new FakeProvider({ name: 'low-a', trustLevel: 1, rateLimit: OPEN }),
      new FakeProvider({ name: 'high', trustLevel: 5, rateLimit: OPEN }),
      new FakeProvider({ name: 'low-b', trustLevel: 1, rateLimit: OPEN }),
    );
    const order = computeDefaultOrder();
    expect(order.indexOf('high')).toBeLessThan(order.indexOf('low-a'));
    expect(order.indexOf('low-a')).toBeLessThan(order.indexOf('low-b'));
    // IMAP/iCloud (trust 10) still lead, as the old score had them.
    expect(order[0]).toBe('imap');
    cleanup();
  });

  it('falls back to the computed default when no rule is saved', () => {
    const resolved = resolveDispatchOrder('nothing.test');
    expect(resolved.source).toBe('default');
    expect(resolved.order).toEqual(computeDefaultOrder());
  });

  it('uses the global rule and appends registered providers it does not mention', async () => {
    const cleanup = onlyFakes(
      new FakeProvider({ name: 'a', trustLevel: 1, rateLimit: OPEN }),
      new FakeProvider({ name: 'b', trustLevel: 1, rateLimit: OPEN }),
      new FakeProvider({ name: 'c', trustLevel: 1, rateLimit: OPEN }),
    );
    expect((await putRule('*', { order: ['b', 'a'], others: 'exclude' })).status).toBe(200);

    const resolved = resolveDispatchOrder('any.test');
    expect(resolved.source).toBe('global');
    expect(resolved.others).toBe('append');
    expect(resolved.order.slice(0, 2)).toEqual(['b', 'a']);
    expect(resolved.order).toContain('c');
    expect(resolved.order).toContain('imap');
    cleanup();
  });

  it('puts a service rule first and appends or excludes the rest', async () => {
    const cleanup = onlyFakes(
      new FakeProvider({ name: 'a', trustLevel: 1, rateLimit: OPEN }),
      new FakeProvider({ name: 'b', trustLevel: 1, rateLimit: OPEN }),
      new FakeProvider({ name: 'c', trustLevel: 1, rateLimit: OPEN }),
    );
    await putRule('*', { order: ['b', 'a'] });

    await putRule('append.test', { order: ['c'] });
    const appended = resolveDispatchOrder('append.test');
    expect(appended.source).toBe('service');
    expect(appended.order.slice(0, 3)).toEqual(['c', 'b', 'a']);

    await putRule('only.test', { order: ['c', 'a'], others: 'exclude' });
    const excluded = resolveDispatchOrder('only.test');
    expect(excluded.others).toBe('exclude');
    expect(excluded.order).toEqual(['c', 'a']);
    cleanup();
  });

  it('keeps unregistered names in the resolved order so the preview can report them', async () => {
    const cleanup = onlyFakes(new FakeProvider({ name: 'a', trustLevel: 1, rateLimit: OPEN }));
    getDb().prepare(`INSERT INTO provider_config (provider, enabled, priority, auto_dispatch) VALUES ('gone', 1, 0, 1)`).run();
    await putRule('svc.test', { order: ['gone', 'a'], others: 'exclude' });

    const evaluated = evaluateDispatch({ service: 'svc.test', needPolling: true });
    expect(evaluated.candidates).toEqual([
      { provider: 'gone', eligible: false, reason: 'unknown_provider' },
      { provider: 'a', eligible: true },
    ]);
    cleanup();
  });
});

describe('dispatch eligibility reasons', () => {
  afterEach(() => { rateLimiter.reset(); });

  it.each([
    ['disabled', (name: string) => { getDb().prepare(`UPDATE provider_config SET enabled = 0 WHERE provider = ?`).run(name); }, {}],
    ['manual_only', (name: string) => { getDb().prepare(`UPDATE provider_config SET auto_dispatch = 0 WHERE provider = ?`).run(name); }, {}],
    ['no_polling', () => {}, { features: { pollInbox: false, customUsername: true, realtime: false, attachments: false } }],
    ['rate_limited', (name: string) => { rateLimiter.reserveCreate(name); }, { rateLimit: { createPerMinute: 1, pollPerMinute: 0 } }],
    ['cooldown', (name: string) => { rateLimiter.recordTransientFailure(name); }, {}],
  ] as const)('reports %s', (reason, arrange, metaOverrides) => {
    const cleanup = onlyFakes(new FakeProvider({ name: 'probe', trustLevel: 1, rateLimit: OPEN, ...metaOverrides }));
    getDb().prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'probe'`).run();
    arrange('probe');

    const { candidates } = evaluateDispatch({ needPolling: true });
    const probe = candidates.find((c) => c.provider === 'probe');
    expect(probe?.eligible).toBe(false);
    expect(probe?.reason).toBe(reason);
    if (reason === 'cooldown') {
      expect(probe?.cooldownReason).toBe('transient-error');
      expect(probe?.nextAvailableAt).not.toBeNull();
    }
    cleanup();
  });

  it('lets a service rule name a manual-only provider but the global rule does not', async () => {
    const cleanup = onlyFakes(new FakeProvider({ name: 'paid', trustLevel: 1, rateLimit: OPEN }));
    getDb().prepare(`UPDATE provider_config SET enabled = 1, auto_dispatch = 0 WHERE provider = 'paid'`).run();

    await putRule('*', { order: ['paid'] });
    expect(evaluateDispatch({ service: 'other.test', needPolling: true }).candidates[0]).toMatchObject({ provider: 'paid', eligible: false, reason: 'manual_only' });

    await putRule('named.test', { order: ['paid'] });
    expect(evaluateDispatch({ service: 'named.test', needPolling: true }).candidates[0]).toEqual({ provider: 'paid', eligible: true });
    cleanup();
  });
});

describe('dispatch walks the resolved order', () => {
  afterEach(() => { rateLimiter.reset(); vi.useRealTimers(); });

  it('tries the first eligible provider and never touches the ones behind it', async () => {
    const first = new FakeProvider({ name: 'first', trustLevel: 1, rateLimit: OPEN });
    const second = new FakeProvider({ name: 'second', trustLevel: 5, rateLimit: OPEN });
    const cleanup = onlyFakes(first, second);
    await putRule('*', { order: ['first', 'second'] });

    await expect(dispatch({ for: 'svc.test' })).resolves.toMatchObject({ provider: 'first' });
    expect(first.getDomainsCount).toBe(1);
    expect(second.getDomainsCount).toBe(0);
    expect(second.createCount).toBe(0);
    cleanup();
  });

  it('skips a rate-limited leader and a disabled one, in order', async () => {
    const limited = new FakeProvider({ name: 'limited', rateLimit: { createPerMinute: 1, pollPerMinute: 0 } });
    const off = new FakeProvider({ name: 'off', rateLimit: OPEN });
    const ok = new FakeProvider({ name: 'ok', rateLimit: OPEN });
    const cleanup = onlyFakes(limited, off, ok);
    getDb().prepare(`UPDATE provider_config SET enabled = 0 WHERE provider = 'off'`).run();
    rateLimiter.reserveCreate('limited');
    await putRule('*', { order: ['limited', 'off', 'ok'] });

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'ok' });
    expect(limited.createCount).toBe(0);
    expect(off.createCount).toBe(0);
    cleanup();
  });

  it('falls through when the leader fails to create, cooling it down', async () => {
    const flaky = new TransientCreateProvider({ name: 'flaky', rateLimit: OPEN });
    const ok = new FakeProvider({ name: 'ok', rateLimit: OPEN });
    const cleanup = onlyFakes(flaky, ok);
    await putRule('*', { order: ['flaky', 'ok'] });

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'ok' });
    expect(flaky.createCount).toBe(1);
    expect(rateLimiter.getCreateStatus('flaky').cooldownReason).toBe('transient-error');
    cleanup();
  });

  it('falls through when the leader cannot list domains, cooling it down', async () => {
    const broken = new FailingDomainsProvider({ name: 'broken', rateLimit: OPEN });
    const ok = new FakeProvider({ name: 'ok', rateLimit: OPEN });
    const cleanup = onlyFakes(broken, ok);
    await putRule('*', { order: ['broken', 'ok'] });

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'ok' });
    expect(broken.createCount).toBe(0);
    expect(rateLimiter.getCreateStatus('broken').cooldownReason).toBe('transient-error');
    cleanup();
  });

  it('gives up on a domain fetch that never settles and cools the provider down', async () => {
    vi.useFakeTimers();
    const stuck = new HangingDomainsProvider({ name: 'stuck', rateLimit: OPEN });
    const ok = new FakeProvider({ name: 'ok', rateLimit: OPEN });
    const cleanup = onlyFakes(stuck, ok);
    await putRule('*', { order: ['stuck', 'ok'] });

    const pending = dispatch({});
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(pending).resolves.toMatchObject({ provider: 'ok' });
    expect(stuck.createCount).toBe(0);
    const status = rateLimiter.getCreateStatus('stuck');
    expect(status.cooldownReason).toBe('transient-error');
    expect(status.available).toBe(false);
    cleanup();
  });

  it('exhausts an exclude rule without touching anything outside it', async () => {
    const listed = new TransientCreateProvider({ name: 'listed', rateLimit: OPEN });
    const outside = new FakeProvider({ name: 'outside', rateLimit: OPEN });
    const cleanup = onlyFakes(listed, outside);
    await putRule('strict.test', { order: ['listed'], others: 'exclude' });

    await expect(dispatch({ for: 'strict.test' })).rejects.toThrow(/All providers exhausted[\s\S]*listed/);
    expect(outside.createCount).toBe(0);
    expect(outside.getDomainsCount).toBe(0);
    cleanup();
  });

  it('lists skipped providers with their reason in the exhaustion error', async () => {
    const cleanup = onlyFakes(new FakeProvider({ name: 'cold', rateLimit: OPEN }));
    rateLimiter.recordTransientFailure('cold');
    await putRule('*', { order: ['cold'] });

    await expect(dispatch({})).rejects.toThrow(/cold: skipped \(cooldown\)/);
    cleanup();
  });

  it('ignores rules entirely when the caller names a provider', async () => {
    const named = new FakeProvider({ name: 'named', rateLimit: OPEN });
    const cleanup = onlyFakes(named);
    getDb().prepare(`UPDATE provider_config SET auto_dispatch = 0 WHERE provider = 'named'`).run();
    await putRule('x.test', { order: ['imap'], others: 'exclude' });

    await expect(dispatch({ for: 'x.test', provider: 'named' })).resolves.toMatchObject({ provider: 'named' });
    cleanup();
  });
});

describe('dispatch preview endpoint', () => {
  afterEach(() => { rateLimiter.reset(); });

  it('shows the resolved order with reasons and calls nothing upstream', async () => {
    const a = new FakeProvider({ name: 'a', trustLevel: 1, rateLimit: OPEN });
    const b = new FakeProvider({ name: 'b', trustLevel: 1, rateLimit: OPEN });
    const cleanup = onlyFakes(a, b);
    rateLimiter.recordRateLimitFailure('b', '120');
    await putRule('svc.test', { order: ['b', 'a'], others: 'exclude' });

    const { res, data } = await preview('svc.test');
    expect(res.status).toBe(200);
    expect(data.service).toBe('svc.test');
    expect(data.rule).toEqual({ source: 'service', others: 'exclude' });
    expect(data.candidates[0]).toMatchObject({ provider: 'b', eligible: false, reason: 'cooldown', cooldownReason: 'rate-limit' });
    expect(data.candidates[0].nextAvailableAt).toBeTruthy();
    expect(data.candidates[1]).toEqual({ provider: 'a', eligible: true });
    expect(a.getDomainsCount).toBe(0);
    expect(b.getDomainsCount).toBe(0);
    cleanup();
  });

  it('reports the global or default source when no service is given', async () => {
    expect((await preview()).data.rule.source).toBe('default');
    await putRule('*', { order: ['imap'] });
    expect((await preview()).data.rule.source).toBe('global');
  });

  it('is readable with a regular API key', async () => {
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey('mk_user'), 'user');
    const { res } = await preview('svc.test', 'mk_user');
    expect(res.status).toBe(200);
  });
});

describe('dispatch rules API', () => {
  it('requires admin for rule management', async () => {
    getDb().prepare(`INSERT INTO api_keys (key, name) VALUES (?, ?)`).run(hashApiKey('mk_user'), 'user');
    expect((await app.request('/api/dispatch/rules', { headers: authHeaders('mk_user') })).status).toBe(403);
    expect((await putRule('*', { order: ['imap'] }, 'mk_user')).status).toBe(403);
  });

  it('lists the computed default alongside saved rules, global first', async () => {
    await putRule('zzz.test', { order: ['imap'] });
    await putRule('*', { order: ['outlook', 'imap'] });

    const res = await app.request('/api/dispatch/rules', { headers: authHeaders() });
    const data = await res.json() as { defaultOrder: string[]; rules: Array<{ service: string; order: string[]; others: string; updatedAt: string }> };
    expect(data.defaultOrder).toEqual(computeDefaultOrder());
    expect(data.rules.map((r) => r.service)).toEqual(['*', 'zzz.test']);
    expect(data.rules[0]).toMatchObject({ order: ['outlook', 'imap'], others: 'append' });
    expect(data.rules[0].updatedAt).toMatch(/Z$/);
  });

  it.each([
    ['empty order', '*', { order: [] }],
    ['non-string entry', '*', { order: ['imap', 7] }],
    ['duplicate', '*', { order: ['imap', 'imap'] }],
    ['unknown provider', '*', { order: ['imap', 'nope'] }],
    ['bad others', 'svc.test', { order: ['imap'], others: 'drop' }],
    ['example domain', 'example.com', { order: ['imap'] }],
    ['blank service', '  ', { order: ['imap'] }],
  ])('rejects %s with 400', async (_label, service, body) => {
    const res = await putRule(service, body);
    expect(res.status).toBe(400);
    expect(getRow(getDb(), `SELECT 1 FROM dispatch_rules WHERE service = ?`, service.trim())).toBeUndefined();
  });

  it('forces append on the global rule, upserts, and deletes idempotently', async () => {
    const created = await putRule('*', { order: ['imap'], others: 'exclude' });
    expect(await created.json()).toMatchObject({ service: '*', order: ['imap'], others: 'append' });

    const replaced = await putRule('*', { order: ['outlook', 'imap'] });
    expect(await replaced.json()).toMatchObject({ order: ['outlook', 'imap'] });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM dispatch_rules`).get()).toEqual({ n: 1 });

    for (let i = 0; i < 2; i++) {
      const res = await app.request('/api/dispatch/rules/*', { method: 'DELETE', headers: authHeaders() });
      expect(res.status).toBe(200);
    }
    expect(resolveDispatchOrder().source).toBe('default');
  });

  it('keeps a disabled template in a rule, lets other entries be edited, and restores it on re-enable', async () => {
    const tpl = new FakeProvider({ name: 'tpl', trustLevel: 1, rateLimit: OPEN });
    const cleanup = onlyFakes(tpl, new FakeProvider({ name: 'm1', rateLimit: OPEN }), new FakeProvider({ name: 'm2', rateLimit: OPEN }));
    expect((await putRule('svc.test', { order: ['tpl', 'm1', 'm2'], others: 'exclude' })).status).toBe(200);

    // Disabling a template unregisters it; its provider_config row survives.
    registry.unregister('tpl');
    expect((await putRule('svc.test', { order: ['tpl', 'm2', 'm1'], others: 'exclude' })).status).toBe(200);
    expect((await preview('svc.test')).data.candidates[0]).toEqual({ provider: 'tpl', eligible: false, reason: 'unknown_provider' });

    // A brand-new unknown name is still a typo.
    expect((await putRule('svc.test', { order: ['tpl', 'typo'], others: 'exclude' })).status).toBe(400);

    registry.register(tpl);
    getDb().prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'tpl'`).run();
    const after = (await preview('svc.test')).data.candidates;
    expect(after[0]).toEqual({ provider: 'tpl', eligible: true });
    expect(after.map((c) => c.provider)).toEqual(['tpl', 'm2', 'm1']);
    cleanup();
  });
});

describe('priority removal and upgrade path', () => {
  it('rejects priority on PATCH /providers/:name and no longer reports it', async () => {
    const res = await app.request('/api/providers/mailtm', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ priority: 5 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/dispatch\/rules/);

    const list = await (await app.request('/api/providers', { headers: authHeaders() })).json() as { providers: Array<Record<string, unknown>> };
    expect(list.providers.every((p) => !('priority' in p))).toBe(true);
    const one = await (await app.request('/api/providers/mailtm', { headers: authHeaders() })).json() as Record<string, unknown>;
    expect('priority' in one).toBe(false);
  });

  it('removes NULL-keyed provider_config rows and refuses to recreate them', () => {
    const db = getDb();
    db.prepare(`INSERT INTO provider_config (provider, enabled, priority, auto_dispatch) VALUES (NULL, 1, 0, 1)`).run();
    db.prepare(`INSERT INTO provider_config (provider, enabled, priority, auto_dispatch) VALUES (NULL, 1, 0, 1)`).run();

    expect(removeNullProviderConfigRows(db)).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM provider_config WHERE provider IS NULL`).get()).toEqual({ n: 0 });

    const unnamed = new FakeProvider({ name: '' });
    expect(() => registry.register(unnamed)).toThrow(/meta\.name/);
  });

  it('seeds a global rule from legacy priority using the old static score, once', () => {
    const db = getDb();
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(SEEDED_FLAG);
    // IMAP trust 10 + priority 1 = 101 beats Outlook trust 4 + priority 2 = 42;
    // a lexicographic (priority, trust) sort would have flipped them.
    db.prepare(`UPDATE provider_config SET priority = 1 WHERE provider = 'imap'`).run();
    db.prepare(`UPDATE provider_config SET priority = 2 WHERE provider = 'outlook'`).run();

    expect(seedDispatchRulesFromPriority()).toBe(true);
    const rule = resolveDispatchOrder();
    expect(rule.source).toBe('global');
    expect(rule.order.indexOf('imap')).toBeLessThan(rule.order.indexOf('outlook'));
    expect(getSetting(SEEDED_FLAG)).toBe('1');

    db.prepare(`UPDATE provider_config SET priority = 500 WHERE provider = 'mailtm'`).run();
    expect(seedDispatchRulesFromPriority()).toBe(false);
    expect(resolveDispatchOrder().order[0]).not.toBe('mailtm');
  });

  it('does not seed anything when no priority was ever set', () => {
    const db = getDb();
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(SEEDED_FLAG);
    expect(seedDispatchRulesFromPriority()).toBe(false);
    expect(resolveDispatchOrder().source).toBe('default');
    expect(getSetting(SEEDED_FLAG)).toBe('1');
  });

  it('ranks a template that is disabled during the upgrade at its earned position', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(SEEDED_FLAG);
    db.prepare(`INSERT INTO template_providers (name, config_json, enabled) VALUES ('tpl-x', ?, 0)`)
      .run(JSON.stringify({ name: 'tpl-x', displayName: 'X', trustLevel: 5 }));
    db.prepare(`INSERT INTO provider_config (provider, enabled, priority, auto_dispatch) VALUES ('tpl-x', 1, 100, 1)`).run();

    expect(seedDispatchRulesFromPriority()).toBe(true);
    // tpl-x: 5*10 + 100 = 150 > imap: 10*10 + 0 = 100.
    const order = resolveDispatchOrder().order;
    expect(order[0]).toBe('tpl-x');
    expect(order[1]).toBe('imap');

    // Re-enabling registers it again; it is back at the top and dispatchable.
    const tpl = new FakeProvider({ name: 'tpl-x', trustLevel: 5, rateLimit: OPEN });
    registry.register(tpl);
    expect((await preview()).data.candidates[0]).toEqual({ provider: 'tpl-x', eligible: true });
    registry.unregister('tpl-x');
  });
});
