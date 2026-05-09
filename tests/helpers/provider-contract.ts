import { expect } from 'vitest';
import type { BaseProvider } from '../../src/providers/base.js';

export async function expectProviderContract(provider: BaseProvider): Promise<void> {
  expect(provider.meta.name).toMatch(/^[a-z0-9-]+$/);
  expect(provider.meta.displayName.length).toBeGreaterThan(0);
  expect(provider.meta.rateLimit.createPerMinute).toBeGreaterThanOrEqual(0);
  expect(provider.meta.rateLimit.pollPerMinute).toBeGreaterThanOrEqual(0);

  const domains = await provider.getDomains();
  expect(domains.length).toBeGreaterThan(0);
  expect(domains[0]).toContain('.');

  const inbox = await provider.createInbox({ domain: domains[0], username: 'contract' });
  expect(inbox.provider).toBe(provider.meta.name);
  expect(inbox.address).toContain('@');
  expect(inbox.authData).toEqual(expect.any(Object));

  if (provider.meta.features.pollInbox) {
    const messages = await provider.getMessages(inbox);
    expect(Array.isArray(messages)).toBe(true);
  }

  await expect(provider.deleteInbox(inbox)).resolves.toBeUndefined();
}
