import { registry } from './providers/registry.js';

interface Window {
  timestamps: number[];
}

export interface RateLimitStatus {
  provider: string;
  maxPerWindow: number;
  windowSeconds: number;
  currentCount: number;
  available: boolean;
  nextAvailableAt: string | null;
  cooldownReason?: string | null;
}

class RateLimiter {
  private createWindows = new Map<string, Window>();
  private pollWindows = new Map<string, Window>();
  private cooldowns = new Map<string, number>();
  private cooldownReasons = new Map<string, string>();
  private rateLimitFailures = new Map<string, number>();

  private getWindow(map: Map<string, Window>, provider: string): Window {
    let w = map.get(provider);
    if (!w) {
      w = { timestamps: [] };
      map.set(provider, w);
    }
    return w;
  }

  private pruneWindow(w: Window, windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    w.timestamps = w.timestamps.filter((t) => t > cutoff);
  }

  recordCreate(provider: string): void {
    const w = this.getWindow(this.createWindows, provider);
    w.timestamps.push(Date.now());
  }

  /**
   * Return the most recently recorded create slot to the window. Used when a
   * create attempt fails deterministically (e.g. upstream 4xx that is not a
   * rate limit), so a failed request that never produced an inbox does not
   * count against the per-minute budget and cascade into spurious 429s.
   */
  refundCreate(provider: string): void {
    const w = this.createWindows.get(provider);
    if (w && w.timestamps.length > 0) w.timestamps.pop();
  }

  tryRecordCreate(provider: string): boolean {
    if (!this.isCreateAvailable(provider)) return false;
    this.recordCreate(provider);
    return true;
  }

  recordPoll(provider: string): void {
    const w = this.getWindow(this.pollWindows, provider);
    w.timestamps.push(Date.now());
  }

  setCooldown(provider: string, untilMs: number, reason = 'cooldown'): void {
    this.cooldowns.set(provider, untilMs);
    this.cooldownReasons.set(provider, reason);
  }

  clearCooldown(provider: string): void {
    this.cooldowns.delete(provider);
    this.cooldownReasons.delete(provider);
    this.rateLimitFailures.delete(provider);
  }

  recordCreateSuccess(provider: string): void {
    this.clearCooldown(provider);
  }

  recordRateLimitFailure(provider: string, retryAfter?: string): void {
    const now = Date.now();
    const retryAfterMs = this.parseRetryAfter(retryAfter, now);
    let delayMs = retryAfterMs;
    if (delayMs === null) {
      const failures = (this.rateLimitFailures.get(provider) ?? 0) + 1;
      this.rateLimitFailures.set(provider, failures);
      delayMs = Math.min(60_000 * 2 ** (failures - 1), 600_000);
    }
    this.setCooldown(provider, now + delayMs, 'rate-limit');
  }

  recordTransientFailure(provider: string): void {
    this.setCooldown(provider, Date.now() + 30_000, 'transient-error');
  }

  private parseRetryAfter(retryAfter: string | undefined, now: number): number | null {
    if (!retryAfter) return null;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600_000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs - now, 0), 600_000);
    return null;
  }

  isCreateAvailable(provider: string): boolean {
    const cooldown = this.cooldowns.get(provider);
    if (cooldown && Date.now() < cooldown) return false;

    const p = registry.get(provider);
    if (!p) return false;

    const limit = p.meta?.rateLimit?.createPerMinute ?? 0;
    if (limit <= 0) return true;

    const w = this.getWindow(this.createWindows, provider);
    this.pruneWindow(w, 60_000);
    return w.timestamps.length < limit;
  }

  isPollAvailable(provider: string): boolean {
    const p = registry.get(provider);
    if (!p) return false;

    const limit = p.meta?.rateLimit?.pollPerMinute ?? 0;
    if (limit <= 0) return true;

    const w = this.getWindow(this.pollWindows, provider);
    this.pruneWindow(w, 60_000);
    return w.timestamps.length < limit;
  }

  getPollStatus(provider: string): RateLimitStatus {
    return this.getStatus(provider, 'poll');
  }

  getCreateStatus(provider: string): RateLimitStatus {
    return this.getStatus(provider, 'create');
  }

  private getStatus(provider: string, type: 'create' | 'poll'): RateLimitStatus {
    const p = registry.get(provider);
    const limit = type === 'create'
      ? (p?.meta?.rateLimit?.createPerMinute ?? 0)
      : (p?.meta?.rateLimit?.pollPerMinute ?? 0);
    const windowMs = 60_000;

    const w = this.getWindow(type === 'create' ? this.createWindows : this.pollWindows, provider);
    this.pruneWindow(w, windowMs);

    const cooldown = type === 'create' ? this.cooldowns.get(provider) : undefined;
    const inCooldown = cooldown ? Date.now() < cooldown : false;
    if (cooldown && !inCooldown && type === 'create') {
      this.cooldowns.delete(provider);
      this.cooldownReasons.delete(provider);
    }

    let nextAvailableAt: string | null = null;
    if (inCooldown && cooldown) {
      nextAvailableAt = new Date(cooldown).toISOString();
    } else if (limit > 0 && w.timestamps.length >= limit) {
      nextAvailableAt = new Date(w.timestamps[0] + windowMs).toISOString();
    }

    return {
      provider,
      maxPerWindow: limit,
      windowSeconds: 60,
      currentCount: w.timestamps.length,
      available: !inCooldown && (limit <= 0 || w.timestamps.length < limit),
      nextAvailableAt,
      cooldownReason: inCooldown ? (this.cooldownReasons.get(provider) ?? 'cooldown') : null,
    };
  }

  reset(): void {
    this.createWindows.clear();
    this.pollWindows.clear();
    this.cooldowns.clear();
    this.cooldownReasons.clear();
    this.rateLimitFailures.clear();
  }
}

export const rateLimiter = new RateLimiter();
