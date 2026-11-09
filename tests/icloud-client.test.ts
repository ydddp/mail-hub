import { describe, it, expect, vi, afterEach } from 'vitest';
import { IcloudClient, IcloudApiError, MAILHUB_HME_LABEL } from '../src/providers/icloud-client.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * The client reads the body as text before parsing, so it can report an HTML
 * sign-in page as an expired session instead of a parser error. A stub that
 * only offers json() no longer matches a real Response.
 */
function stubJson(handler: (url: string, init?: RequestInit) => unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(handler(String(url), init)),
  })));
}

/** Whatever the endpoint, answer with this status and body. */
function stubStatus(status: number, body: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  })));
}

describe('IcloudClient', () => {
  const alias = { hme: 'a@icloud.com', anonymousId: 'anon-a', isActive: true, label: MAILHUB_HME_LABEL, note: '' };

  it.each([
    ['missing positive success', { result: { hmeEmails: [] } }],
    ['null success', { success: null, result: { hmeEmails: [] } }],
    ['missing aliases', { success: true, result: {} }],
    ['null aliases', { success: true, result: { hmeEmails: null } }],
    ['non-array aliases', { success: true, result: { hmeEmails: {} } }],
    ...[null, {}, { ...alias, anonymousId: '' }, { ...alias, hme: ' ' }, { ...alias, isActive: undefined },
      { ...alias, isActive: null }, { ...alias, isActive: 'false' }].map(item =>
      ['invalid final alias', { success: true, result: { hmeEmails: [alias, item] } }]),
    ...[{ partial: true }, { hasMore: true }, { complete: false }, { continuationToken: 'next' },
      { pagination: { nextPageToken: 'next' } }].map(flags =>
      ['incomplete aliases', { success: true, result: { hmeEmails: [alias], ...flags } }]),
    ['partial envelope', { success: true, partial: true, result: { hmeEmails: [alias] } }],
    ['conflicting identity', { success: true, result: { hmeEmails: [alias, { ...alias, isActive: false }] } }],
    ['conflicting address', { success: true, result: { hmeEmails: [alias, { ...alias, anonymousId: 'other' }] } }],
  ])('refuses %s as a complete activity snapshot', async (_label, envelope) => {
    stubJson(() => envelope);
    const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
    await expect(client.listWithForwarding()).rejects.toThrow(IcloudApiError);
  });

  it.each([[], [alias, alias]].map(entries => ({ entries })))('accepts a positively successful complete list and optional forwarding defaults: $entries', async ({ entries }) => {
    stubJson(() => ({ success: true, result: { hmeEmails: entries } }));
    const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
    expect(await client.listWithForwarding()).toEqual({
      hmeEmails: entries.length ? [alias] : [], selectedForwardTo: '', forwardToEmails: [],
    });
  });

  it('keeps the existing POST envelope compatibility independently of strict list evidence', async () => {
    stubJson(() => ({ result: { hme: 'compatible@icloud.com' } }));
    await expect(new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' }).generate())
      .resolves.toBe('compatible@icloud.com');
  });

  it.each(['generate', 'reserve', 'deactivate'] as const)('does not repeat %s after Apple writes and disconnects', async (operation) => {
    const disconnected = new TypeError('response lost after Apple committed the write');
    let committedWrites = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { committedWrites++; throw disconnected; }));
    vi.useFakeTimers();
    try {
      const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
      const pending = (operation === 'generate' ? client.generate()
        : operation === 'reserve' ? client.reserve('a@icloud.com', 'label', 'note')
        : client.deactivate('anon-1')).catch(error => error);
      await vi.runAllTimersAsync();
      expect(await pending).toBe(disconnected);
      expect(committedWrites).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains bounded retries for the read-only alias list', async () => {
    const disconnected = new TypeError('list disconnected');
    const fetchMock = vi.fn().mockRejectedValue(disconnected);
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
      const pending = client.list().catch(error => error);
      await vi.runAllTimersAsync();
      expect(await pending).toBe(disconnected);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks deactivation authority after service discovery and immediately before the POST', async () => {
    const order: string[] = [];
    stubJson(url => {
      order.push(url.includes('/validate') ? 'validate' : 'deactivate');
      return { webservices: { premiummailsettings: { url: 'https://svc.test' } } };
    });
    const lost = new Error('operation no longer owns the lease');
    const client = new IcloudClient({ cookies: 'c', region: 'global' });
    await expect(client.deactivate('alias', () => { order.push('guard'); throw lost; })).rejects.toBe(lost);
    expect(order).toEqual(['validate', 'guard']);
  });

  it('discovers the premiummailsettings url instead of hardcoding a partition host', async () => {
    stubJson((url) => {
      if (url.includes('/setup/ws/1/validate')) {
        return { webservices: { premiummailsettings: { url: 'https://p68-maildomainws.icloud.com', status: 'active' } } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const client = new IcloudClient({ cookies: 'X-APPLE=1', region: 'global' });
    const url = await client.validate();

    expect(url).toBe('https://p68-maildomainws.icloud.com');
    expect(client.serviceUrl()).toBe('https://p68-maildomainws.icloud.com');
  });

  it('uses the china setup host for a china account', async () => {
    const seen: string[] = [];
    stubJson((url) => {
      seen.push(url);
      return { webservices: { premiummailsettings: { url: 'https://p217-maildomainws.icloud.com.cn', status: 'active' } } };
    });

    await new IcloudClient({ cookies: 'c', region: 'china' }).validate();

    expect(seen[0]).toContain('setup.icloud.com.cn');
  });

  it('returns the generated address', async () => {
    stubJson(() => ({ success: true, result: { hme: 'quiet.fox.42@icloud.com' } }));

    const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
    await expect(client.generate()).resolves.toBe('quiet.fox.42@icloud.com');
  });

  it('stamps the Mail Hub marker onto every reserved address', async () => {
    let body: Record<string, unknown> = {};
    stubJson((_url, init) => {
      body = JSON.parse(String(init?.body));
      return { success: true, result: { hme: { hme: 'a@icloud.com', anonymousId: 'anon-9', label: '', note: '', isActive: true } } };
    });

    const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
    const reserved = await client.reserve('a@icloud.com', MAILHUB_HME_LABEL, 'note');

    // Reconciliation adopts only marked addresses; an unmarked one may be the
    // account owner's personal alias and must never enter the tenant pool.
    expect(body.label).toBe(MAILHUB_HME_LABEL);
    expect(reserved.anonymousId).toBe('anon-9');
  });

  it('preserves Apple’s own error text rather than inventing a code', async () => {
    stubJson(() => ({ success: false, error: { errorMessage: 'You have reached your limit' } }));

    const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
    await expect(client.generate()).rejects.toThrow(IcloudApiError);
    await expect(client.generate()).rejects.toThrow('You have reached your limit');
  });

  it('resolves the partition host on first use instead of demanding a prior validate()', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      const isValidate = String(url).includes('/setup/ws/1/validate');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(
          isValidate
            ? { webservices: { premiummailsettings: { url: 'https://p68.test' } } }
            : { success: true, result: { hme: 'auto@icloud.com' } },
        ),
      };
    }));

    // A freshly added account has no cached service url. Requiring the caller
    // to know it must press "test connection" first made every first generate
    // fail with an error about our internals.
    const client = new IcloudClient({ cookies: 'c', region: 'global' });
    await expect(client.generate()).resolves.toBe('auto@icloud.com');

    expect(seen[0]).toContain('/setup/ws/1/validate');
    expect(seen[1]).toBe('https://p68.test/v1/hme/generate');
  });

  it('names an invalid session rather than surfacing a JSON parse error', async () => {
    // Apple answers an expired cookie with a sign-in page, and a bare
    // res.json() turns that into "Unexpected token '<'" — which sends the
    // operator hunting for a parser bug instead of re-copying their cookie.
    stubStatus(401, '<!DOCTYPE html><html><body>Sign in</body></html>');

    const client = new IcloudClient({ cookies: 'stale', region: 'global', serviceUrl: 'https://svc.test' });
    await expect(client.generate()).rejects.toThrow(/session is not valid/);
  });

  it('translates the 421 a stale cookie actually gets, not just 401', async () => {
    // Observed against the real endpoint: a stale or wrong-partition cookie
    // comes back 421 with a JSON blob pointing at the sign-in widget. Echoing
    // that blob told the operator nothing they could act on.
    stubStatus(421, '{"success":false,"configBag":{"urls":{"accountLoginUI":"https://idmsa.apple.com/appleauth/auth/signin?widgetKey=d39ba9"}}}');

    const client = new IcloudClient({ cookies: 'stale', region: 'global' });
    await expect(client.validate()).rejects.toThrow(/session is not valid/);
    await expect(client.validate()).rejects.toThrow(/X-APPLE-WEBAUTH-TOKEN/);
  });

  it('reports a 200 that is not JSON as a lost session, not a crash', async () => {
    stubStatus(200, '<html>signin</html>');

    const client = new IcloudClient({ cookies: 'c', region: 'global', serviceUrl: 'https://svc.test' });
    await expect(client.generate()).rejects.toThrow(IcloudApiError);
    await expect(client.generate()).rejects.toThrow(/no longer signed in/);
  });

  it('says the subscription is missing when iCloud signs in but offers no HME service', async () => {
    stubJson(() => ({ webservices: { ckdatabasews: { url: 'https://x' } } }));

    const client = new IcloudClient({ cookies: 'c', region: 'global' });
    await expect(client.validate()).rejects.toThrow(/no active iCloud\+ subscription/);
  });
});
