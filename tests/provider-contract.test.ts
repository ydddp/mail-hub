import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from './helpers/fake-provider.js';
import { expectProviderContract } from './helpers/provider-contract.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { TemplateProvider } from '../src/providers/template-provider.js';

describe('provider contract helper', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['tempmail-lol', 'tempmail-ing'])('allows %s to decide its address at creation without discovery creates', async (name) => {
    const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === name)!.config);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      address: 'contract@example.test', token: 'test-token', email: { address: 'contract@example.test' }, emails: [],
    })));
    vi.stubGlobal('fetch', fetchMock);
    await expectProviderContract(new TemplateProvider(cfg));
    // One explicit create and one message read; domain discovery is local.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('documents the shared expectations for future mail channels', async () => {
    await expectProviderContract(new FakeProvider());
  });
});
