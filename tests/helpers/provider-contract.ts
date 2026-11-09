import { expect } from 'vitest';
import type { BaseProvider } from '../../src/providers/base.js';

export async function expectProviderContract(provider: BaseProvider): Promise<void> {
  expect(provider.meta.name).toMatch(/^[a-z0-9-]+$/);
  expect(provider.meta.displayName.length).toBeGreaterThan(0);
  expect(provider.meta.rateLimit.createPerMinute).toBeGreaterThanOrEqual(0);
  expect(provider.meta.rateLimit.pollPerMinute).toBeGreaterThanOrEqual(0);

  const domains = await provider.getDomains();
  // Some upstreams decide the address only when an inbox is explicitly
  // created. Discovery may therefore be empty without making them unusable.
  if (provider.getDomainMode() !== 'from_create') expect(domains.length).toBeGreaterThan(0);
  if (domains.length) expect(domains[0]).toContain('.');

  const inbox = await provider.createInbox({ ...(domains[0] ? { domain: domains[0] } : {}), username: 'contract' });
  expect(inbox.provider).toBe(provider.meta.name);
  expect(inbox.address).toContain('@');
  expect(inbox.authData).toEqual(expect.any(Object));

  if (provider.meta.features.pollInbox) {
    const messages = await provider.getMessages(inbox);
    expect(Array.isArray(messages)).toBe(true);
  }

  await expect(provider.deleteInbox(inbox)).resolves.toBeUndefined();
}
