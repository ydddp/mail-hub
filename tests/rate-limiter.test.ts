import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimiter } from '../src/rate-limiter.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';

// A refund belongs to one request, even when other requests finish first.
describe('create reservations', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const name of ['reserved', 'cold-reservation-provider', 'other-reserved']) registry.unregister(name);
  });

  function setup(name = 'reserved', limit = 2): void {
    registry.register(new FakeProvider({ name, rateLimit: { createPerMinute: limit, pollPerMinute: 0 } }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
  }

  it('checks and reserves capacity atomically, including cooldowns and unknown providers', () => {
    setup('reserved', 1);
    expect(rateLimiter.reserveCreate('reserved')).toEqual(expect.any(String));
    expect(rateLimiter.reserveCreate('reserved')).toBeNull();
    expect(rateLimiter.getCreateStatus('reserved').currentCount).toBe(1);
    expect(rateLimiter.reserveCreate('unknown-reservation-provider')).toBeNull();
    rateLimiter.setCooldown('cold-reservation-provider', Date.now() + 60_000);
    registry.register(new FakeProvider({ name: 'cold-reservation-provider' }));
    expect(rateLimiter.reserveCreate('cold-reservation-provider')).toBeNull();
    expect(rateLimiter.getCreateStatus('cold-reservation-provider').currentCount).toBe(0);
  });

  it.each([0, 10_000])('refunds A after B succeeds %ims later while preserving B and its original expiry', (delta) => {
    setup();
    const start = Date.now();
    const a = rateLimiter.reserveCreate('reserved')!;
    vi.setSystemTime(start + delta);
    const b = rateLimiter.reserveCreate('reserved')!;
    expect(b).not.toBe(a);
    rateLimiter.recordCreateSuccess('reserved');

    vi.setSystemTime(start + 20_000);
    rateLimiter.refundCreate('reserved', a);
    expect(rateLimiter.getCreateStatus('reserved').currentCount).toBe(1);
    expect(rateLimiter.reserveCreate('reserved')).not.toBeNull();
    expect(rateLimiter.getCreateStatus('reserved').nextAvailableAt).toBe(new Date(start + delta + 60_000).toISOString());
    vi.setSystemTime(start + 60_001);
    expect(rateLimiter.getCreateStatus('reserved').currentCount).toBe(delta === 0 ? 1 : 2);
    vi.setSystemTime(start + 70_000);
    expect(rateLimiter.getCreateStatus('reserved').currentCount).toBe(1);
  });

  it.each(['duplicate', 'expired', 'wrong provider', 'unknown id'])('ignores a %s refund', (kind) => {
    setup();
    const a = rateLimiter.reserveCreate('reserved')!;
    if (kind === 'duplicate') rateLimiter.refundCreate('reserved', a);
    if (kind === 'expired') vi.setSystemTime(Date.now() + 60_000);
    const b = rateLimiter.reserveCreate('reserved')!;
    const before = rateLimiter.getCreateStatus('reserved');
    if (kind === 'wrong provider') {
      registry.register(new FakeProvider({ name: 'other-reserved' }));
      rateLimiter.reserveCreate('other-reserved');
      rateLimiter.refundCreate('other-reserved', a);
      expect(rateLimiter.getCreateStatus('other-reserved').currentCount).toBe(1);
    } else rateLimiter.refundCreate('reserved', kind === 'unknown id' ? 'missing' : a);
    expect(rateLimiter.getCreateStatus('reserved')).toEqual(before);
    rateLimiter.refundCreate('reserved', b);
    expect(rateLimiter.getCreateStatus('reserved').currentCount).toBe(before.currentCount - 1);
  });
});

describe('rate limiter cooldowns never shorten', () => {
  // Two creates in flight on the same provider: one gets 429 Retry-After 600,
  // the other times out on getDomains a moment later. The later, shorter
  // transient verdict must not reopen the provider after 30 s.
  it('keeps a longer rate-limit cooldown when a transient failure lands after it', () => {
    registry.register(new FakeProvider({ name: 'cool-a' }));
    rateLimiter.recordRateLimitFailure('cool-a', '600');
    const before = rateLimiter.getCreateStatus('cool-a');

    rateLimiter.recordTransientFailure('cool-a');
    const after = rateLimiter.getCreateStatus('cool-a');

    expect(after.available).toBe(false);
    expect(after.cooldownReason).toBe('rate-limit');
    expect(after.nextAvailableAt).toBe(before.nextAvailableAt);
    expect(Date.parse(after.nextAvailableAt!) - Date.now()).toBeGreaterThan(500_000);
    registry.unregister('cool-a');
  });

  it('extends a short transient cooldown when a rate-limit verdict lands after it', () => {
    registry.register(new FakeProvider({ name: 'cool-b' }));
    rateLimiter.recordTransientFailure('cool-b');
    rateLimiter.recordRateLimitFailure('cool-b', '600');

    const status = rateLimiter.getCreateStatus('cool-b');
    expect(status.cooldownReason).toBe('rate-limit');
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeGreaterThan(500_000);
    registry.unregister('cool-b');
  });

  it('replaces an expired cooldown instead of keeping its stale deadline', () => {
    registry.register(new FakeProvider({ name: 'cool-c' }));
    rateLimiter.setCooldown('cool-c', Date.now() - 1_000, 'rate-limit');
    rateLimiter.recordTransientFailure('cool-c');

    const status = rateLimiter.getCreateStatus('cool-c');
    expect(status.available).toBe(false);
    expect(status.cooldownReason).toBe('transient-error');
    registry.unregister('cool-c');
  });

  it('still clears every cooldown on a real create success', () => {
    registry.register(new FakeProvider({ name: 'cool-d' }));
    rateLimiter.recordRateLimitFailure('cool-d', '600');
    rateLimiter.recordCreateSuccess('cool-d');

    expect(rateLimiter.getCreateStatus('cool-d').available).toBe(true);
    registry.unregister('cool-d');
  });
});
