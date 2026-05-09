import { describe, it, expect } from 'vitest';
import { getDb } from '../src/db.js';
import { ImapProvider } from '../src/providers/imap.js';

describe('ImapProvider', () => {
  it('has correct meta', () => {
    const p = new ImapProvider();
    expect(p.meta.name).toBe('imap');
    expect(p.meta.type).toBe('api');
    expect(p.meta.trustLevel).toBe(10);
    expect(p.meta.features.pollInbox).toBe(true);
    expect(p.meta.features.customUsername).toBe(true);
  });

  it('returns empty domains when no accounts configured', async () => {
    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).toEqual([]);
  });

  it('throws on createInbox when no accounts configured', async () => {
    const p = new ImapProvider();
    await expect(p.createInbox()).rejects.toThrow('No active IMAP accounts configured');
  });

  it('returns domains from active accounts', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).toContain('example.com');
  });

  it('createInbox generates address under account domain', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const inbox = await p.createInbox({ domain: 'example.com' });
    expect(inbox.address).toMatch(/^[a-z0-9]+@example\.com$/);
    expect(inbox.provider).toBe('imap');
    expect(inbox.authData.imapAccountId).toBe('t1');
    expect(inbox.authData.domain).toBe('example.com');
    expect(inbox.authData.password).toBeUndefined();
    expect(inbox.authData.host).toBeUndefined();
  });

  it('createInbox supports custom username', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const inbox = await p.createInbox({ domain: 'example.com', username: 'testuser' });
    expect(inbox.address).toBe('testuser@example.com');
  });

  it('inactive accounts are excluded from domains', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain, status) VALUES ('t2', 'imap2.test.com', 993, 'u2', 'p2', 'disabled.com', 'inactive')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).not.toContain('disabled.com');
    expect(domains).toContain('example.com');
  });

  it('deduplicates domains from multiple accounts', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t3', 'imap3.test.com', 993, 'u3', 'p3', 'example.com')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    const exampleCount = domains.filter(d => d === 'example.com').length;
    expect(exampleCount).toBe(1);
  });
});
