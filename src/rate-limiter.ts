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
}

class RateLimiter {
  private createWindows = new Map<string, Window>();
  private pollWindows = new Map<string, Window>();
  private cooldowns = new Map<string, number>();

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

  recordPoll(provider: string): void {
    const w = this.getWindow(this.pollWindows, provider);
    w.timestamps.push(Date.now());
  }

  setCooldown(provider: string, untilMs: number): void {
    this.cooldowns.set(provider, untilMs);
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
    };
  }

  reset(): void {
    this.createWindows.clear();
    this.pollWindows.clear();
    this.cooldowns.clear();
  }
}

export const rateLimiter = new RateLimiter();
