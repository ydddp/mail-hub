import { getDomain, parse } from 'tldts';

/**
 * The `for` value is the only thing tying an inbox to a service: it selects the
 * dispatch rule, the domain-block check and the service_stats bucket. It is
 * derived here and nowhere else so a page cannot influence it after the summon.
 */
export const MAX_SERVICE_LENGTH = 100;

export type ServiceSource = 'manual' | 'mapping' | 'public-suffix';

export interface ServiceResolved {
  ok: true;
  /** Canonical identifier sent as `for`. */
  service: string;
  /** Lowercased page hostname, without port or trailing dot. */
  host: string;
  source: ServiceSource;
}

export interface ServiceUnresolved {
  ok: false;
  /** `not-http`: the panel must stay inert. `unresolvable`: ask the user. */
  reason: 'not-http' | 'unresolvable';
  /** Hostname when one could be read, `null` when the URL was not a web URL. */
  host: string | null;
}

export type ServiceResult = ServiceResolved | ServiceUnresolved;

export interface ResolveOptions {
  /** Remembered "current site → service" corrections, keyed by host or main domain. */
  mappings?: Record<string, string>;
  /** Value the user typed for this run; beats every remembered mapping. */
  override?: string;
}

/** Lowercase, strip trailing root dots, and reject values that cannot be a `for`. */
export function normalizeService(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed) return null;
  if (trimmed.length > MAX_SERVICE_LENGTH) return null;
  // Whitespace, control characters and URL punctuation would either split the
  // identifier in logs or mean the caller pasted a URL instead of a name.
  if (/[\s\u0000-\u001f\u007f/?#]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Main domain of `host` using the public suffix list *including private
 * suffixes*, so `a.github.io` and `b.github.io` stay separate tenants instead of
 * collapsing into `github.io`. Returns null for IP literals, `localhost` and any
 * host with no registrable domain.
 */
export function registrableDomain(host: string): string | null {
  const cleaned = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!cleaned) return null;
  if (parse(cleaned).isIp) return null;
  return getDomain(cleaned, { allowPrivateDomains: true }) ?? null;
}

function normalizedMappings(mappings: Record<string, string> | undefined): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(mappings ?? {})) {
    const normalizedKey = normalizeService(key);
    if (!normalizedKey || normalized.has(normalizedKey)) continue;
    const normalizedValue = normalizeService(value);
    // An unusable remembered value must not shadow the public suffix result.
    if (normalizedValue) normalized.set(normalizedKey, normalizedValue);
  }
  return normalized;
}

/**
 * Resolve the service for the page that is active at summon time. The URL is
 * read once per call and never re-read later, so navigating to a third-party
 * login page cannot change which service an existing inbox reports against.
 */
export function resolveService(rawUrl: string, options: ResolveOptions = {}): ServiceResult {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return { ok: false, reason: 'not-http', host: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'not-http', host: null };
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return { ok: false, reason: 'not-http', host: null };

  const domain = registrableDomain(host);

  const override = normalizeService(options.override ?? '');
  if (override) return { ok: true, service: override, host, source: 'manual' };

  const mappings = normalizedMappings(options.mappings);
  // Most specific first: an exact-host correction is a deliberate statement
  // about this one page, a main-domain entry is a statement about the tenant.
  const mapped = mappings.get(host) ?? (domain ? mappings.get(domain) : undefined);
  if (mapped) return { ok: true, service: mapped, host, source: 'mapping' };

  if (domain) return { ok: true, service: domain, host, source: 'public-suffix' };
  return { ok: false, reason: 'unresolvable', host };
}
