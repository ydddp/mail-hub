import { describe, it } from 'vitest';
import { FakeProvider } from './helpers/fake-provider.js';
import { expectProviderContract } from './helpers/provider-contract.js';

describe('provider contract helper', () => {
  it('documents the shared expectations for future mail channels', async () => {
    await expectProviderContract(new FakeProvider());
  });
});
