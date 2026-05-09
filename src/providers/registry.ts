import { allRows, getDb, getRow } from '../db.js';
import type { BaseProvider, ProviderMeta } from './base.js';

class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.meta.name, provider);
    const db = getDb();
    const existing = db.prepare(`SELECT provider FROM provider_config WHERE provider = ?`)
      .get(provider.meta.name);
    if (!existing) {
      db.prepare(`INSERT INTO provider_config (provider, enabled, priority, auto_dispatch) VALUES (?, 1, 0, ?)`)
        .run(provider.meta.name, provider.meta.tier === 'paid' ? 0 : 1);
    }
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  get(name: string): BaseProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): BaseProvider[] {
    return Array.from(this.providers.values());
  }

  getEnabled(): BaseProvider[] {
    const db = getDb();
    const rows = allRows<{ provider: string }>(db, `SELECT provider FROM provider_config WHERE enabled = 1`);
    if (!rows.length) return this.getAll();
    const enabledSet = new Set(rows.map((r) => r.provider));
    return this.getAll().filter((p) => enabledSet.has(p.meta.name));
  }

  getConfig(name: string): { enabled: boolean; priority: number; autoDispatch: boolean } {
    const db = getDb();
    const row = getRow<{ enabled: number; priority: number; auto_dispatch: number }>(
      db,
      `SELECT enabled, priority, auto_dispatch FROM provider_config WHERE provider = ?`,
      name,
    );
    if (!row) {
      return { enabled: true, priority: 0, autoDispatch: true };
    }
    return { enabled: row.enabled === 1, priority: row.priority, autoDispatch: row.auto_dispatch !== 0 };
  }

  listMeta(): (ProviderMeta & { enabled: boolean; priority: number })[] {
    const db = getDb();
    const cfgs = allRows<{ provider: string; enabled: number; priority: number; auto_dispatch: number }>(
      db,
      `SELECT provider, enabled, priority, auto_dispatch FROM provider_config`,
    );
    const cfgMap = new Map(cfgs.map((c) => [c.provider, c]));
    return this.getAll().map((p) => {
      const c = cfgMap.get(p.meta.name);
      if (!c) return { ...p.meta, enabled: true, priority: 0 };
      return { ...p.meta, enabled: c.enabled === 1, priority: c.priority };
    });
  }
}

export const registry = new ProviderRegistry();
