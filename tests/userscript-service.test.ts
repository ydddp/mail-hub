import { describe, expect, it } from 'vitest';
import { normalizeService, registrableDomain, resolveService } from '../userscript/src/service.js';

// The service identifier is the `for` value the assistant sends upstream. It
// decides which dispatch rule applies, which domain blocks are checked and
// which service_stats bucket a success lands in. Getting it wrong is a silent
// data error, so every ownership decision is pinned here rather than in the
// panel.
describe('registrableDomain', () => {
  it.each([
    ['accounts.discord.com', 'discord.com'],
    ['login.example.co.uk', 'example.co.uk'],
    ['example.co.uk', 'example.co.uk'],
    ['a.github.io', 'a.github.io'],
    ['b.github.io', 'b.github.io'],
    ['x.blogspot.com', 'x.blogspot.com'],
    ['www.example.com', 'example.com'],
    // A trailing root dot is the same host, not a different one.
    ['example.com.', 'example.com'],
  ])('%s → %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it.each([['localhost'], ['127.0.0.1'], ['::1'], [''], ['intranet']])(
    'refuses to invent a registrable domain for %j',
    (host) => {
      expect(registrableDomain(host)).toBeNull();
    },
  );
});

describe('normalizeService', () => {
  it.each([
    ['  Example.COM  ', 'example.com'],
    ['GitHub.IO', 'github.io'],
    ['example.com.', 'example.com'],
    ['accounting', 'accounting'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeService(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['a b'],
    ['example.com/register'],
    ['?q=1'],
    ['x'.repeat(101)],
  ])('rejects %j instead of sending an unusable `for`', (input) => {
    expect(normalizeService(input)).toBeNull();
  });
});

describe('resolveService', () => {
  // The page the user is on when they summon the panel, not any URL the page
  // can navigate to afterwards.
  it.each([
    ['https://accounts.discord.com/register', 'discord.com'],
    ['https://login.example.co.uk', 'example.co.uk'],
    ['https://a.github.io', 'a.github.io'],
    ['https://b.github.io/x', 'b.github.io'],
    ['HTTP://WWW.Example.COM:8443/a', 'example.com'],
  ])('%s → %s', (url, service) => {
    const result = resolveService(url);
    expect(result).toMatchObject({ ok: true, service, source: 'public-suffix' });
  });

  it('reports the lowercased host so the panel can show what it recognised', () => {
    const result = resolveService('https://WWW.Example.COM:8443/a');
    expect(result).toMatchObject({ ok: true, host: 'www.example.com' });
  });

  // Internal browser pages and anything else that is not a web origin must not
  // produce a dispatch, not even a guessed one.
  it.each([
    ['chrome://extensions'],
    ['chrome-extension://abc/popup.html'],
    ['about:blank'],
    ['file:///C:/tmp/x.html'],
    ['ftp://example.com/x'],
    ['data:text/html,<p>x'],
    [''],
    ['not a url'],
  ])('does not run on %j', (url) => {
    expect(resolveService(url)).toMatchObject({ ok: false, reason: 'not-http' });
  });

  // Design rule: no guessed service name for an address that has no
  // registrable domain. The caller has to ask the user.
  it.each([
    ['http://localhost:3000/register', 'localhost'],
    ['http://127.0.0.1:8080/', '127.0.0.1'],
    ['http://[::1]/', '[::1]'],
  ])('asks for a service on %j but keeps the host', (url, host) => {
    expect(resolveService(url)).toMatchObject({ ok: false, reason: 'unresolvable', host });
  });

  describe('manual mappings', () => {
    it('beats the public suffix result for the exact host', () => {
      const result = resolveService('https://accounts.discord.com/register', {
        mappings: { 'accounts.discord.com': 'discord' },
      });
      expect(result).toMatchObject({ ok: true, service: 'discord', source: 'mapping' });
    });

    it('applies a main-domain mapping to the subdomains that belong to it', () => {
      const result = resolveService('https://accounts.discord.com/register', {
        mappings: { 'discord.com': 'discord' },
      });
      expect(result).toMatchObject({ ok: true, service: 'discord', source: 'mapping' });
    });

    it('prefers the more specific mapping when both exist', () => {
      const result = resolveService('https://accounts.discord.com/register', {
        mappings: { 'discord.com': 'discord', 'accounts.discord.com': 'discord-accounts' },
      });
      expect(result).toMatchObject({ ok: true, service: 'discord-accounts' });
    });

    // a.github.io and b.github.io are different registrable domains. A mapping
    // recorded on one must never be applied to the other, or the request would
    // carry the wrong service and hit the wrong dispatch rule.
    it('never leaks a mapping across registrable domains', () => {
      const result = resolveService('https://b.github.io/settings', {
        mappings: { 'a.github.io': 'alpha' },
      });
      expect(result).toMatchObject({ ok: true, service: 'b.github.io', source: 'public-suffix' });
    });

    it('rescues a host the public suffix list cannot resolve', () => {
      const result = resolveService('http://localhost:3000/register', {
        mappings: { localhost: 'local-dev' },
      });
      expect(result).toMatchObject({ ok: true, service: 'local-dev', source: 'mapping' });
    });

    it('ignores a mapping whose value is unusable and falls back', () => {
      const result = resolveService('https://accounts.discord.com/register', {
        mappings: { 'accounts.discord.com': '  ' },
      });
      expect(result).toMatchObject({ ok: true, service: 'discord.com', source: 'public-suffix' });
    });

    it('normalizes mapping keys before comparing', () => {
      const result = resolveService('https://accounts.discord.com/register', {
        mappings: { '  Accounts.Discord.COM. ': 'Discord' },
      });
      expect(result).toMatchObject({ ok: true, service: 'discord', source: 'mapping' });
    });
  });

  describe('explicit override', () => {
    it('beats every mapping', () => {
      const result = resolveService('https://accounts.discord.com/register', {
        mappings: { 'discord.com': 'discord' },
        override: 'discord-alt',
      });
      expect(result).toMatchObject({ ok: true, service: 'discord-alt', source: 'manual' });
    });

    it('is accepted on a host with no registrable domain', () => {
      const result = resolveService('http://127.0.0.1:8080/', { override: 'local-dev' });
      expect(result).toMatchObject({ ok: true, service: 'local-dev', source: 'manual' });
    });

    it('still refuses to run outside HTTP(S)', () => {
      expect(resolveService('chrome://extensions', { override: 'x' }))
        .toMatchObject({ ok: false, reason: 'not-http' });
    });
  });
});
