import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatcher.js';
import { getDb } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { rateLimiter } from '../src/rate-limiter.js';

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
});
