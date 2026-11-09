import { describe, expect, it, afterEach, vi } from 'vitest';
import { dispatch } from '../src/dispatcher.js';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { NoAssetCreatedError, TemplateCreationRecoveryError, UpstreamHttpError } from '../src/errors.js';
import type { InboxData, ProviderDomainMode } from '../src/providers/base.js';
import { ImapProvider } from '../src/providers/imap.js';
import * as usernames from '../src/username-generator.js';
import { TemplateProvider } from '../src/providers/template-provider.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { OutlookProvider } from '../src/providers/outlook.js';
import { IcloudProvider } from '../src/providers/icloud.js';
import { YydsProvider } from '../src/providers/yyds.js';

class SlowFakeProvider extends FakeProvider {
  constructor(opts: ConstructorParameters<typeof FakeProvider>[0] & { delayMs: number }) {
    super(opts);
    this.delayMs = opts.delayMs;
  }

  private readonly delayMs: number;

  override async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.createInbox(opts);
  }
}

class DomainlessFakeProvider extends FakeProvider {
  getDomainsCount = 0;

  override getDomainMode(): ProviderDomainMode {
    return 'from_create';
  }

  override async getDomains(): Promise<string[]> {
    this.getDomainsCount++;
    throw new Error('getDomains should not be called for from_create providers');
  }
}

class RateLimitedFakeProvider extends FakeProvider {
  constructor(opts: ConstructorParameters<typeof FakeProvider>[0] & { retryAfter?: string }) {
    super(opts);
    this.retryAfter = opts.retryAfter;
  }

  private readonly retryAfter?: string;

  override async createInbox(): Promise<InboxData> {
    this.createCount++;
    throw new UpstreamHttpError(`[${this.meta.name}] Create failed: 429`, 429, this.retryAfter);
  }
}

class TransientFailingFakeProvider extends FakeProvider {
  override async createInbox(): Promise<InboxData> {
    this.createCount++;
    throw new UpstreamHttpError(`[${this.meta.name}] Create failed: 503`, 503);
  }
}

class LocalFailingFakeProvider extends FakeProvider {
  override async createInbox(): Promise<InboxData> {
    this.createCount++;
    // This fake fails before allocating anything, so it can provide proof.
    throw new NoAssetCreatedError('pool exhausted');
  }
}

describe('dispatcher provider selection', () => {
  it('honors explicit provider create rate limits', async () => {
    const provider = new FakeProvider();
    registry.register(provider);

    await expect(dispatch({ provider: 'fake' })).resolves.toMatchObject({
      address: 'user1@example.test',
      provider: 'fake',
    });
    await expect(dispatch({ provider: 'fake' })).rejects.toThrow(/rate-limited/);
    expect(provider.createCount).toBe(1);

    registry.unregister('fake');
  });

  it('does not dispatch to disabled explicit providers', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    getDb().prepare(`UPDATE provider_config SET enabled = 0 WHERE provider = ?`).run('fake');

    await expect(dispatch({ provider: 'fake' })).rejects.toThrow(/disabled/);
    expect(provider.createCount).toBe(0);

    registry.unregister('fake');
  });

  it('does not fall back to a disabled provider when the leader is rate-limited', async () => {
    const mailtm = new FakeProvider({ name: 'mailtm', displayName: 'Mail.tm' });
    const mailgw = new FakeProvider({ name: 'mailgw', displayName: 'Mail.gw' });
    registry.register(mailtm);
    registry.register(mailgw);
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    db.prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'mailtm'`).run();
    rateLimiter.reserveCreate('mailtm');

    await expect(dispatch({})).rejects.toThrow(/rate-limited|exhausted/i);
    expect(mailgw.createCount).toBe(0);

    registry.unregister('mailtm');
    registry.unregister('mailgw');
  });

  it('applies service block rules to explicit providers', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    getDb().prepare(
      `INSERT INTO blocks (service, domain, provider) VALUES (?, ?, ?)`,
    ).run('svc', 'example.test', 'fake');

    await expect(dispatch({ provider: 'fake', for: 'svc', domain: 'example.test' }))
      .rejects.toThrow(/blocked/);
    expect(provider.createCount).toBe(0);

    registry.unregister('fake');
  });

  it('rotates domains when an explicit provider has multiple available domains', async () => {
    const provider = new FakeProvider({
      domains: ['a.test', 'b.test', 'c.test'],
      rateLimit: { createPerMinute: 0, pollPerMinute: 2 },
    });
    registry.register(provider);

    await dispatch({ provider: 'fake' });
    await dispatch({ provider: 'fake' });
    await dispatch({ provider: 'fake' });

    expect(new Set(provider.createdDomains)).toEqual(new Set(['a.test', 'b.test', 'c.test']));

    registry.unregister('fake');
  });

  it('rotates only across unblocked domains', async () => {
    const provider = new FakeProvider({
      domains: ['a.test', 'b.test', 'c.test'],
      rateLimit: { createPerMinute: 0, pollPerMinute: 2 },
    });
    registry.register(provider);
    getDb().prepare(
      `INSERT INTO blocks (service, domain, provider) VALUES (?, ?, ?)`,
    ).run('svc', 'b.test', 'fake');

    await dispatch({ provider: 'fake', for: 'svc' });
    await dispatch({ provider: 'fake', for: 'svc' });
    await dispatch({ provider: 'fake', for: 'svc' });
    await dispatch({ provider: 'fake', for: 'svc' });

    expect(provider.createdDomains).not.toContain('b.test');
    expect(new Set(provider.createdDomains)).toEqual(new Set(['a.test', 'c.test']));

    registry.unregister('fake');
  });

  it('applies lowercase block rules to mixed-case IMAP domains during automatic dispatch', async () => {
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    db.prepare(`UPDATE provider_config SET enabled = 1, auto_dispatch = 1 WHERE provider = 'imap'`).run();
    db.prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain)
       VALUES ('case-block', 'imap.case.test', 993, 'user', 'password', 'Case.Test')`,
    ).run();
    db.prepare(
      `INSERT INTO blocks (service, domain, provider) VALUES (?, ?, ?)`,
    ).run('case-target.test', 'case.test', 'imap');

    await expect(dispatch({ for: 'case-target.test' })).rejects.toThrow(/exhausted|blocked|unblocked/i);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM inboxes`).get()).toEqual({ count: 0 });
  });

  it('reserves create capacity before upstream calls during auto-dispatch', async () => {
    const primary = new SlowFakeProvider({
      name: 'primary',
      displayName: 'Primary',
      trustLevel: 5,
      rateLimit: { createPerMinute: 1, pollPerMinute: 2 },
      delayMs: 25,
    });
    const fallback = new FakeProvider({
      name: 'fallback',
      displayName: 'Fallback',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(primary);
    registry.register(fallback);

    const results = await Promise.all([dispatch({}), dispatch({})]);

    expect(results.map((r) => r.provider).sort()).toEqual(['fallback', 'primary']);
    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(1);

    registry.unregister('primary');
    registry.unregister('fallback');
  });

  it('does not call getDomains while auto-dispatching from_create providers', async () => {
    const provider = new DomainlessFakeProvider({
      name: 'domainless',
      displayName: 'Domainless',
      rateLimit: { createPerMinute: 1, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(provider);

    await expect(dispatch({})).resolves.toMatchObject({
      provider: 'domainless',
    });
    expect(provider.getDomainsCount).toBe(0);
    expect(provider.createCount).toBe(1);

    registry.unregister('domainless');
  });

  it('falls back and cools down a provider that returns upstream 429', async () => {
    const primary = new RateLimitedFakeProvider({
      name: 'primary-429',
      displayName: 'Primary 429',
      trustLevel: 5,
      retryAfter: '120',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const fallback = new FakeProvider({
      name: 'fallback-429',
      displayName: 'Fallback 429',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(primary);
    registry.register(fallback);

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'fallback-429' });
    const status = rateLimiter.getCreateStatus('primary-429');

    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(1);
    expect(status.available).toBe(false);
    expect(status.cooldownReason).toBe('rate-limit');
    expect(status.nextAvailableAt).not.toBeNull();
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeGreaterThan(100_000);

    registry.unregister('primary-429');
    registry.unregister('fallback-429');
  });

  it('uses exponential default cooldown when upstream 429 has no Retry-After', async () => {
    const provider = new RateLimitedFakeProvider({
      name: 'no-retry-after',
      displayName: 'No Retry After',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    registry.register(provider);

    rateLimiter.recordRateLimitFailure('no-retry-after');
    const first = rateLimiter.getCreateStatus('no-retry-after').nextAvailableAt!;
    rateLimiter.recordRateLimitFailure('no-retry-after');
    const second = rateLimiter.getCreateStatus('no-retry-after').nextAvailableAt!;

    expect(Date.parse(first) - Date.now()).toBeGreaterThan(50_000);
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first) + 50_000);

    registry.unregister('no-retry-after');
  });

  it('does not fall back when an explicit provider returns upstream 429', async () => {
    const primary = new RateLimitedFakeProvider({
      name: 'explicit-429',
      displayName: 'Explicit 429',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const fallback = new FakeProvider({
      name: 'explicit-fallback',
      displayName: 'Explicit Fallback',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    registry.register(primary);
    registry.register(fallback);

    await expect(dispatch({ provider: 'explicit-429' })).rejects.toMatchObject({ status: 429 });
    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(0);

    registry.unregister('explicit-429');
    registry.unregister('explicit-fallback');
  });

  it('falls back and briefly cools down a provider that returns upstream 5xx', async () => {
    const primary = new TransientFailingFakeProvider({
      name: 'primary-503',
      displayName: 'Primary 503',
      trustLevel: 5,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const fallback = new FakeProvider({
      name: 'fallback-503',
      displayName: 'Fallback 503',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(primary);
    registry.register(fallback);

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'fallback-503' });
    const status = rateLimiter.getCreateStatus('primary-503');

    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(1);
    expect(status.available).toBe(false);
    expect(status.cooldownReason).toBe('transient-error');
    expect(status.nextAvailableAt).not.toBeNull();
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeGreaterThan(20_000);
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeLessThanOrEqual(30_000);

    registry.unregister('primary-503');
    registry.unregister('fallback-503');
  });

  it('refunds create capacity when a provider fails locally before any upstream call', async () => {
    const provider = new LocalFailingFakeProvider({
      name: 'local-fail',
      displayName: 'Local Fail',
      rateLimit: { createPerMinute: 1, pollPerMinute: 2 },
    });
    registry.register(provider);

    await expect(dispatch({ provider: 'local-fail' })).rejects.toThrow(/pool exhausted/);

    const status = rateLimiter.getCreateStatus('local-fail');
    expect(status.currentCount).toBe(0);
    expect(status.available).toBe(true);

    registry.unregister('local-fail');
  });

  it('fetches domains once per auto-dispatch', async () => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 10, pollPerMinute: 2 } });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(provider);

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'fake' });
    expect(provider.getDomainsCount).toBe(1);

    registry.unregister('fake');
  });

  it('dispatches nothing when every provider is explicitly disabled', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    getDb().prepare(`UPDATE provider_config SET enabled = 0`).run();

    await expect(dispatch({})).rejects.toThrow(/All providers exhausted/);
    expect(provider.createCount).toBe(0);

    registry.unregister('fake');
  });
});

// Failures after a possible upstream allocation must still consume capacity.
describe('dispatch reservation outcomes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const name of ['uncertain-create', 'uncertain-template', 'concurrent-refund', 'empty-template']) registry.unregister(name);
  });

  it.each([
    ['HTTP 400', new UpstreamHttpError('bad request', 400)],
    ['HTTP 401', new UpstreamHttpError('unauthorized', 401)],
    ['timeout', new DOMException('response timed out', 'TimeoutError')],
    ['JSON parsing', new SyntaxError('invalid JSON response')],
    ['unclassified local error', new Error('unknown creation outcome')],
  ])('retains capacity after %s without no-asset proof', async (_label, failure) => {
    const provider = new FakeProvider({ name: 'uncertain-create' });
    vi.spyOn(provider, 'createInbox').mockRejectedValue(failure);
    registry.register(provider);
    await expect(dispatch({ provider: provider.meta.name })).rejects.toBe(failure);
    expect(rateLimiter.getCreateStatus(provider.meta.name).currentCount).toBe(1);
    await expect(dispatch({ provider: provider.meta.name })).rejects.toThrow(/rate-limited/);
    expect(provider.createInbox).toHaveBeenCalledTimes(1);
  });

  it.each(['JSON response', 'postCreate JSON'])('retains the slot after a real template %s failure following allocation', async (stage) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'mailtm')!.config);
    cfg.name = 'uncertain-template';
    cfg.rateLimit.createPerMinute = 1;
    let writes = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      writes++;
      if (stage === 'JSON response' || writes > 1) return new Response('invalid JSON', { status: 200 });
      return new Response(JSON.stringify({ address: 'created@example.test', id: 'created-account' }));
    }));
    const provider = new TemplateProvider(cfg);
    registry.register(provider);
    // R05 wraps the upstream parse error so credentials cannot reach ordinary
    // aggregates. Keep R13's write count and consumed-capacity assertions.
    const failure = await dispatch({ provider: cfg.name, domain: 'example.test' }).catch(error => error);
    expect(failure).toBeInstanceOf(TemplateCreationRecoveryError);
    expect(failure.cause).toBeInstanceOf(SyntaxError);
    expect(writes).toBe(stage === 'JSON response' ? 1 : 2);
    expect(rateLimiter.getCreateStatus(cfg.name).currentCount).toBe(1);
  });

  it('refunds a delayed proven failure without removing a later success or changing its expiry', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-07T00:00:00Z').getTime();
    vi.setSystemTime(start);
    const provider = new FakeProvider({ name: 'concurrent-refund', rateLimit: { createPerMinute: 2, pollPerMinute: 0 } });
    let rejectFirst!: (error: Error) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const realCreate = provider.createInbox.bind(provider);
    vi.spyOn(provider, 'createInbox').mockImplementationOnce(() => {
      started();
      return new Promise((_resolve, reject) => { rejectFirst = reject; });
    }).mockImplementation(realCreate);
    registry.register(provider);
    const first = dispatch({ provider: provider.meta.name }).catch(error => error);
    await firstStarted;
    vi.setSystemTime(start + 10_000);
    await dispatch({ provider: provider.meta.name });
    vi.setSystemTime(start + 20_000);
    rejectFirst(new NoAssetCreatedError('pool exhausted'));
    expect(await first).toBeInstanceOf(NoAssetCreatedError);
    expect(rateLimiter.getCreateStatus(provider.meta.name).currentCount).toBe(1);
    await dispatch({ provider: provider.meta.name });
    expect(rateLimiter.getCreateStatus(provider.meta.name).nextAvailableAt).toBe(new Date(start + 70_000).toISOString());
    vi.setSystemTime(start + 60_001);
    expect(rateLimiter.getCreateStatus(provider.meta.name).currentCount).toBe(2);
  });

  it.each([
    ['imap', () => new ImapProvider()],
    ['outlook', () => new OutlookProvider()],
    ['icloud', () => new IcloudProvider()],
    ['yyds', () => new YydsProvider()],
    ['empty-template', () => {
      const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === 'mailtm')!.config);
      cfg.name = 'empty-template';
      cfg.domains = { mode: 'static', list: [] };
      return new TemplateProvider(cfg);
    }],
  ] as const)('refunds a proven empty %s provider before any create write', async (name, makeProvider) => {
    const fetchMock = vi.fn(() => { throw new Error('unexpected network'); });
    vi.stubGlobal('fetch', fetchMock);
    const provider = makeProvider();
    registry.register(provider);
    // A domain is supplied to reach provider-local empty-pool validation.
    const opts = { provider: name, domain: 'example.test' };
    if (name === 'empty-template') {
      vi.spyOn(provider, 'getDomains').mockResolvedValueOnce(['example.test']);
      delete (opts as { domain?: string }).domain;
      // Dispatch selects a domain; force the provider to recheck its empty pool.
      const create = provider.createInbox.bind(provider);
      vi.spyOn(provider, 'createInbox').mockImplementation(() => create());
    }
    const error = await dispatch(opts).catch(error => error);
    expect(error).toBeInstanceOf(NoAssetCreatedError);
    expect(rateLimiter.getCreateStatus(name).currentCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('inbox expiry', () => {
  it.each(['2026-02-30T00:00:00Z', 'not-a-date'])('falls back to the requested TTL for invalid upstream expiry %s', async (expiresAt) => {
    registry.register(new FakeProvider({name:'bad-expiry',expiresAt}));
    const before = Date.now();
    const result = await dispatch({provider:'bad-expiry',duration:600});
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(before + 600_000);
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('stores provider expiry, tightens it with a requested duration, and defaults to 24h', async () => {
    const withExpiry = new FakeProvider({
      name: 'exp-provider',
      displayName: 'With Expiry',
      rateLimit: { createPerMinute: 0, pollPerMinute: 2 },
    });
    const withoutExpiry = new FakeProvider({
      name: 'noexp-provider',
      displayName: 'No Expiry',
      expiresAt: null,
      rateLimit: { createPerMinute: 0, pollPerMinute: 2 },
    });
    registry.register(withExpiry);
    registry.register(withoutExpiry);
    const db = getDb();

    const upstream = await dispatch({ provider: 'exp-provider' });
    expect(upstream.expiresAt).toBe('2099-01-01T00:00:00.000Z');

    const tightened = await dispatch({ provider: 'exp-provider', duration: 600 });
    const tightenedMs = Date.parse(tightened.expiresAt);
    expect(tightenedMs).toBeGreaterThan(Date.now() + 500_000);
    expect(tightenedMs).toBeLessThan(Date.now() + 700_000);

    const defaulted = await dispatch({ provider: 'noexp-provider' });
    const defaultedMs = Date.parse(defaulted.expiresAt);
    expect(defaultedMs).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(defaultedMs).toBeLessThan(Date.now() + 25 * 3_600_000);

    const row = getRow<{ expires_at: string | null }>(db, `SELECT expires_at FROM inboxes WHERE id = ?`, defaulted.id);
    expect(row?.expires_at).toBe(defaulted.expiresAt);

    registry.unregister('exp-provider');
    registry.unregister('noexp-provider');
  });
});

describe('IMAP dispatch address claims', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(): ImapProvider {
    const provider = new ImapProvider();
    registry.register(provider);
    getDb().prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('claim', 'imap.test', 993, 'u', 'p', ' Example.COM ')`).run();
    return provider;
  }

  it('lets only one concurrent specified claim win and refunds the conflict reservation', async () => {
    setup();
    const results = await Promise.allSettled([
      dispatch({ provider: 'imap', username: ' Alice ', for: 'claim.test' }),
      dispatch({ provider: 'imap', username: 'ALICE', for: 'claim.test' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(getDb().prepare(`SELECT address FROM inboxes`).all()).toEqual([{ address: 'alice@example.com' }]);
    expect(rateLimiter.getCreateStatus('imap').currentCount).toBe(1);
    expect(getDb().prepare(`SELECT inbox_count FROM service_stats WHERE name = 'claim.test'`).get()).toEqual({ inbox_count: 1 });
  });

  it.each(['', null, false, 0])('passes provided invalid username %j through dispatch for rejection', async (username) => {
    setup();
    await expect(dispatch({ provider: 'imap', username } as Parameters<typeof dispatch>[0])).rejects.toMatchObject({ status: 400 });
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM inboxes`).get()).toEqual({ count: 0 });
    expect(rateLimiter.getCreateStatus('imap').currentCount).toBe(0);
  });

  it('retries a generated INSERT race without reserving or counting twice', async () => {
    setup();
    const draws = ['same', 'same', 'fresh'];
    vi.spyOn(usernames, 'randomUsername').mockImplementation(() => draws.shift() ?? 'fresh');
    const results = await Promise.all([
      dispatch({ provider: 'imap', for: 'random.test' }),
      dispatch({ provider: 'imap', for: 'random.test' }),
    ]);
    expect(results.map((inbox) => inbox.address).sort()).toEqual(['fresh@example.com', 'same@example.com']);
    expect(rateLimiter.getCreateStatus('imap').currentCount).toBe(2);
    expect(getDb().prepare(`SELECT inbox_count FROM service_stats WHERE name = 'random.test'`).get()).toEqual({ inbox_count: 2 });
  });

  it('keeps a generated INSERT retry on the first resolved domain after an unknown domain fallback', async () => {
    const provider = setup();
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('second-domain', 'imap.other.test', 993, 'u2', 'p2', 'other.test')`).run();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(0.99);
    const draws = ['same', 'fresh'];
    vi.spyOn(usernames, 'randomUsername').mockImplementation(() => draws.shift() ?? 'fresh');
    const createdAddresses: string[] = [];
    const realCreate = provider.createInbox.bind(provider);
    vi.spyOn(provider, 'createInbox').mockImplementation(async (opts) => {
      const inbox = await realCreate(opts);
      createdAddresses.push(inbox.address);
      if (createdAddresses.length === 1) {
        // Another writer claims the first address after the provider precheck.
        db.prepare(`INSERT INTO inboxes (id, provider, address, auth_data) VALUES ('racing-writer', 'imap', ?, '{}')`).run(inbox.address);
      }
      return inbox;
    });

    const result = await dispatch({ provider: 'imap', domain: 'unknown.test', for: 'pinned.test' });

    expect(createdAddresses).toEqual(['same@example.com', 'fresh@example.com']);
    expect(result.address).toBe('fresh@example.com');
    expect(rateLimiter.getCreateStatus('imap').currentCount).toBe(1);
    expect(db.prepare(`SELECT inbox_count FROM service_stats WHERE name = 'pinned.test'`).get()).toEqual({ inbox_count: 1 });
  });

  it('rejects a changed retry domain when the original IMAP account becomes unavailable', async () => {
    const provider = setup();
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('second-domain', 'imap.other.test', 993, 'u2', 'p2', 'other.test')`).run();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const draws = ['same', 'fresh'];
    vi.spyOn(usernames, 'randomUsername').mockImplementation(() => draws.shift() ?? 'fresh');
    const realCreate = provider.createInbox.bind(provider);
    let creates = 0;
    vi.spyOn(provider, 'createInbox').mockImplementation(async (opts) => {
      const inbox = await realCreate(opts);
      if (++creates === 1) {
        db.prepare(`INSERT INTO inboxes (id, provider, address, auth_data) VALUES ('racing-writer', 'imap', ?, '{}')`).run(inbox.address);
        db.prepare(`UPDATE imap_accounts SET status = 'inactive' WHERE id = 'claim'`).run();
      }
      return inbox;
    });

    await expect(dispatch({ provider: 'imap', domain: 'unknown.test', for: 'pinned.test' })).rejects.toMatchObject({ status: 409 });
    expect(creates).toBe(2);
    expect(db.prepare(`SELECT address FROM inboxes`).all()).toEqual([{ address: 'same@example.com' }]);
    expect(rateLimiter.getCreateStatus('imap').currentCount).toBe(0);
    expect(db.prepare(`SELECT inbox_count FROM service_stats WHERE name = 'pinned.test'`).get()).toBeUndefined();
  });

  it('bounds generated INSERT conflict retries and refunds an exhausted request', async () => {
    const provider = setup();
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data) VALUES ('held', 'imap', 'same@example.com', '{}')`).run();
    const create = vi.spyOn(provider, 'createInbox').mockResolvedValue({ address: 'same@example.com', provider: 'imap', authData: {}, apiBase: '' });
    await expect(dispatch({ provider: 'imap', for: 'random.test' })).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(8);
    expect(rateLimiter.getCreateStatus('imap').currentCount).toBe(0);
    expect(getDb().prepare(`SELECT inbox_count FROM service_stats WHERE name = 'random.test'`).get()).toBeUndefined();
  });

  it('keeps an automatic specified conflict instead of falling through to another provider or domain', async () => {
    setup();
    const fallback = new FakeProvider({ name: 'fallback-claim', trustLevel: 1, domains: ['other.test'] });
    registry.register(fallback);
    getDb().exec(`UPDATE provider_config SET enabled = 0 WHERE provider NOT IN ('imap', 'fallback-claim')`);
    getDb().prepare(`INSERT INTO inboxes (id, provider, address, auth_data) VALUES ('held', 'imap', 'alice@example.com', '{}')`).run();
    await expect(dispatch({ username: 'ALICE' })).rejects.toMatchObject({ status: 409 });
    expect(fallback.createCount).toBe(0);
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM inboxes`).get()).toEqual({ count: 1 });
    registry.unregister('fallback-claim');
  });

  it('preserves non-IMAP handling of empty usernames and duplicate addresses', async () => {
    const provider = new FakeProvider({ rateLimit: { createPerMinute: 0, pollPerMinute: 2 } });
    registry.register(provider);
    expect((await dispatch({ provider: 'fake', username: '' })).address).toBe('user1@example.test');
    const first = await dispatch({ provider: 'fake', username: 'same' });
    const second = await dispatch({ provider: 'fake', username: 'same' });
    expect(second.address).toBe(first.address);
    registry.unregister('fake');
  });
});
