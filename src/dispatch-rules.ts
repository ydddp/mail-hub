import { allRows, getDb, getRow, getSetting, setSetting } from './db.js';
import { registry } from './providers/registry.js';
import { rateLimiter } from './rate-limiter.js';
import { toUtcIso } from './time.js';
import { createLogger } from './logger.js';

const log = createLogger('dispatch-rules');

export const GLOBAL_RULE = '*';
export const SEEDED_FLAG = 'dispatch_rules_seeded';

// Same list dispatch() rejects for `for`; a rule for a placeholder service
// could never match a real request.
export const EXAMPLE_SERVICE_RE = /^(example\.(com|org|net)|test\.(com|org)|localhost)$/i;

export type RuleOthers = 'append' | 'exclude';

export interface DispatchRule {
  service: string;
  order: string[];
  others: RuleOthers;
  updatedAt: string | null;
}

export type RuleSource = 'service' | 'global' | 'default';

export interface ResolvedOrder {
  source: RuleSource;
  others: RuleOthers;
  /** Resolved candidate names, first tried first. May name providers that are not registered right now. */
  order: string[];
  /** Names the service rule itself lists; these may be dispatched even with auto_dispatch = 0. */
  namedByService: Set<string>;
}

export type SkipReason =
  | 'unknown_provider'
  | 'disabled'
  | 'manual_only'
  | 'no_polling'
  | 'rate_limited'
  | 'cooldown';

export interface Candidate {
  provider: string;
  eligible: boolean;
  reason?: SkipReason;
  cooldownReason?: string | null;
  nextAvailableAt?: string | null;
}

export interface EvaluatedDispatch {
  source: RuleSource;
  others: RuleOthers;
  candidates: Candidate[];
}

export class DispatchRuleError extends Error {
  readonly status = 400;
}

interface RuleRow {
  service: string;
  order_json: string;
  others: string;
  updated_at: string;
}

function parseOrder(json: string, service: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string' || !item || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  } catch (error) {
    log.warn('unreadable dispatch rule order', { service, error: error });
    return [];
  }
}

function rowToRule(row: RuleRow): DispatchRule {
  return {
    service: row.service,
    order: parseOrder(row.order_json, row.service),
    // The global rule never excludes: it is the list everything else falls back to.
    others: row.service !== GLOBAL_RULE && row.others === 'exclude' ? 'exclude' : 'append',
    updatedAt: toUtcIso(row.updated_at),
  };
}

export function getRule(service: string): DispatchRule | undefined {
  const row = getRow<RuleRow>(getDb(), `SELECT service, order_json, others, updated_at FROM dispatch_rules WHERE service = ?`, service);
  return row ? rowToRule(row) : undefined;
}

export function listRules(): DispatchRule[] {
  const rows = allRows<RuleRow>(getDb(), `SELECT service, order_json, others, updated_at FROM dispatch_rules ORDER BY service = '*' DESC, service`);
  return rows.map(rowToRule);
}

export function deleteRule(service: string): boolean {
  return getDb().prepare(`DELETE FROM dispatch_rules WHERE service = ?`).run(service).changes > 0;
}

/**
 * Registered providers sorted by trustLevel descending, registration order
 * for ties. This is what the old score produced when every provider was
 * healthy, so an upgrade with no saved rule keeps picking the same provider.
 */
export function computeDefaultOrder(): string[] {
  return registry.getAll()
    .map((p, index) => ({ name: p.meta.name, trust: p.meta.trustLevel, index }))
    .sort((a, b) => b.trust - a.trust || a.index - b.index)
    .map((entry) => entry.name);
}

/**
 * Names a rule may reference: registered now, or ever registered (every
 * provider gets a provider_config row on first registration and keeps it
 * while disabled or unregistered), or already in the rule being replaced.
 * Anything else is a typo.
 */
export function knownProviderNames(): Set<string> {
  const names = new Set(registry.getAll().map((p) => p.meta.name));
  for (const row of allRows<{ provider: string | null }>(getDb(), `SELECT provider FROM provider_config`)) {
    if (row.provider) names.add(row.provider);
  }
  return names;
}

export function normalizeService(raw: unknown): string {
  const service = typeof raw === 'string' ? raw.trim() : '';
  if (!service) throw new DispatchRuleError('service is required');
  if (service !== GLOBAL_RULE && EXAMPLE_SERVICE_RE.test(service)) {
    throw new DispatchRuleError(`'${service}' is an example domain, use a real target service`);
  }
  return service;
}

export function saveRule(serviceRaw: unknown, body: unknown): DispatchRule {
  const service = normalizeService(serviceRaw);
  const input = (body && typeof body === 'object' ? body : {}) as { order?: unknown; others?: unknown };

  if (!Array.isArray(input.order) || input.order.length === 0) {
    throw new DispatchRuleError('order must be a non-empty array of provider names');
  }
  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of input.order) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new DispatchRuleError('order entries must be non-empty provider names');
    }
    const name = item.trim();
    if (seen.has(name)) throw new DispatchRuleError(`duplicate provider in order: ${name}`);
    seen.add(name);
    order.push(name);
  }

  const known = knownProviderNames();
  for (const name of getRule(service)?.order ?? []) known.add(name);
  const unknown = order.filter((name) => !known.has(name));
  if (unknown.length) throw new DispatchRuleError(`unknown provider: ${unknown.join(', ')}`);

  let others: RuleOthers = 'append';
  if (input.others !== undefined) {
    if (input.others !== 'append' && input.others !== 'exclude') {
      throw new DispatchRuleError(`others must be 'append' or 'exclude'`);
    }
    others = input.others;
  }
  if (service === GLOBAL_RULE) others = 'append';

  getDb().prepare(`
    INSERT INTO dispatch_rules (service, order_json, others, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(service) DO UPDATE SET
      order_json = excluded.order_json,
      others = excluded.others,
      updated_at = datetime('now')
  `).run(service, JSON.stringify(order), others);

  return getRule(service)!;
}

/**
 * The order dispatch will walk for `service`. Base = the global rule's list
 * (or the computed default), with any registered provider it does not mention
 * appended in registration order so a provider added after the rule was saved
 * is still reachable. A service rule's own list goes first; the base follows
 * when `others = 'append'` and is dropped when `'exclude'`.
 */
export function resolveDispatchOrder(service?: string): ResolvedOrder {
  const global = getRule(GLOBAL_RULE);
  const base = global ? [...global.order] : computeDefaultOrder();
  const inBase = new Set(base);
  for (const p of registry.getAll()) {
    if (!inBase.has(p.meta.name)) { base.push(p.meta.name); inBase.add(p.meta.name); }
  }

  const serviceRule = service && service !== GLOBAL_RULE ? getRule(service) : undefined;
  if (!serviceRule) {
    return { source: global ? 'global' : 'default', others: 'append', order: base, namedByService: new Set() };
  }

  const listed = new Set(serviceRule.order);
  const order = serviceRule.others === 'exclude'
    ? [...serviceRule.order]
    : [...serviceRule.order, ...base.filter((name) => !listed.has(name))];
  return { source: 'service', others: serviceRule.others, order, namedByService: listed };
}

/**
 * Pure local evaluation of every candidate in resolved order: no upstream
 * call, no state change. Dispatch tries the eligible ones in sequence; the
 * preview endpoint shows the whole list with skip reasons.
 */
export function evaluateDispatch(opts: { service?: string; needPolling: boolean }): EvaluatedDispatch {
  const resolved = resolveDispatchOrder(opts.service);
  const configs = registry.getAllConfigs();

  const candidates = resolved.order.map((name): Candidate => {
    const provider = registry.get(name);
    if (!provider) return { provider: name, eligible: false, reason: 'unknown_provider' };

    const cfg = configs.get(name) ?? { enabled: true, autoDispatch: true };
    if (!cfg.enabled) return { provider: name, eligible: false, reason: 'disabled' };
    if (!cfg.autoDispatch && !resolved.namedByService.has(name)) {
      return { provider: name, eligible: false, reason: 'manual_only' };
    }
    if (opts.needPolling && !provider.meta.features.pollInbox) {
      return { provider: name, eligible: false, reason: 'no_polling' };
    }

    const rate = rateLimiter.getCreateStatus(name);
    if (!rate.available) {
      return {
        provider: name,
        eligible: false,
        reason: rate.cooldownReason ? 'cooldown' : 'rate_limited',
        cooldownReason: rate.cooldownReason ?? null,
        nextAvailableAt: rate.nextAvailableAt,
      };
    }
    return { provider: name, eligible: true };
  });

  return { source: resolved.source, others: resolved.others, candidates };
}

interface SeedEntry { name: string; trustLevel: number }

/**
 * Every provider a seed must rank: the registered ones, then templates that
 * are disabled right now (not registered, but their provider_config row and
 * trustLevel still exist). A template disabled during the upgrade would
 * otherwise lose its earned position and come back last.
 */
function seedCatalog(): SeedEntry[] {
  const entries: SeedEntry[] = registry.getAll().map((p) => ({ name: p.meta.name, trustLevel: p.meta.trustLevel }));
  const registered = new Set(entries.map((e) => e.name));
  const templates = allRows<{ name: string; config_json: string }>(
    getDb(),
    `SELECT name, config_json FROM template_providers ORDER BY rowid`,
  );
  for (const row of templates) {
    if (registered.has(row.name)) continue;
    let trustLevel = 1;
    try {
      const raw = JSON.parse(row.config_json);
      const cfg = (raw.config ?? raw) as { trustLevel?: unknown };
      if (typeof cfg.trustLevel === 'number' && Number.isFinite(cfg.trustLevel)) trustLevel = cfg.trustLevel;
    } catch (error) {
      log.warn('unreadable template config during dispatch seed', { name: row.name, error: error });
    }
    entries.push({ name: row.name, trustLevel });
  }
  return entries;
}

/**
 * One-shot upgrade step: if an operator ever set provider_config.priority, turn
 * it into a global rule ordered by the static part of the old score
 * (trustLevel * 10 + priority), ties by catalog position. Runs after providers
 * register because it needs trustLevel; the flag and the rule commit together
 * so a failure leaves neither and the next boot retries.
 */
export function seedDispatchRulesFromPriority(): boolean {
  const db = getDb();
  if (getSetting(SEEDED_FLAG) === '1') return false;

  return db.transaction((): boolean => {
    const hasGlobal = !!getRow(db, `SELECT service FROM dispatch_rules WHERE service = ?`, GLOBAL_RULE);
    const priorities = new Map(
      allRows<{ provider: string; priority: number }>(db, `SELECT provider, priority FROM provider_config WHERE provider IS NOT NULL`)
        .map((row) => [row.provider, row.priority || 0]),
    );
    const anyPriority = [...priorities.values()].some((value) => value !== 0);

    let seeded = false;
    if (!hasGlobal && anyPriority) {
      const order = seedCatalog()
        .map((entry, index) => ({ name: entry.name, score: entry.trustLevel * 10 + (priorities.get(entry.name) ?? 0), index }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.name);
      if (order.length) {
        db.prepare(`INSERT INTO dispatch_rules (service, order_json, others) VALUES (?, ?, 'append')`)
          .run(GLOBAL_RULE, JSON.stringify(order));
        log.info('seeded global dispatch order from legacy priority', { order });
        seeded = true;
      }
    }
    setSetting(SEEDED_FLAG, '1');
    return seeded;
  })();
}
