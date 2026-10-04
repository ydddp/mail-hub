import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatcher.js';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { UpstreamHttpError } from '../src/errors.js';
import type { InboxData, ProviderDomainMode } from '../src/providers/base.js';

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
    throw new Error('pool exhausted');
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

  it('does not fallback to disabled paired providers', async () => {
    const mailtm = new FakeProvider({ name: 'mailtm', displayName: 'Mail.tm' });
    const mailgw = new FakeProvider({ name: 'mailgw', displayName: 'Mail.gw' });
    registry.register(mailtm);
    registry.register(mailgw);
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    db.prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'mailtm'`).run();
    rateLimiter.recordCreate('mailtm');

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

  it('fetches domains once per auto-dispatch, reusing the scoring result', async () => {
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
