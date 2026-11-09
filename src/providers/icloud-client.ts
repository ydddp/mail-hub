import { fetchWithTimeout } from '../utils.js';
import { UpstreamHttpError } from '../errors.js';

export const ICLOUD_REGIONS = {
  global: {
    setupUrl: 'https://setup.icloud.com/setup/ws/1',
    webOrigin: 'https://www.icloud.com',
    langCode: 'en-us',
  },
  china: {
    setupUrl: 'https://setup.icloud.com.cn/setup/ws/1',
    webOrigin: 'https://www.icloud.com.cn',
    langCode: 'zh-cn',
  },
} as const;

export type IcloudRegion = keyof typeof ICLOUD_REGIONS;

/**
 * Written into every address Mail Hub reserves.
 *
 * `GET /v2/hme/list` returns every alias on the Apple ID, including ones the
 * account owner made by hand for personal use. Adopting an unmarked address
 * would hand their private mail to a tenant, so ownership must be provable
 * rather than assumed.
 */
export const MAILHUB_HME_LABEL = 'mail-hub';
export const MAILHUB_HME_NOTE = 'Managed by Mail Hub. Do not edit this label.';

export interface HmeEntry {
  hme: string;
  anonymousId: string;
  label: string;
  note: string;
  isActive: boolean;
}

/** Carries Apple's own message; we do not yet know its failure taxonomy. */
export class IcloudApiError extends Error {}

/** A completed Apple response explicitly rejected the requested operation. */
export class IcloudDefinitiveRejection extends IcloudApiError {}

export interface HmeSnapshot {
  hmeEmails: HmeEntry[];
  selectedForwardTo: string;
  forwardToEmails: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A partial page is not evidence of an alias's delivery state. */
function requireCompleteSnapshot(value: Record<string, unknown>): void {
  const partial = ['partial', 'isPartial', 'incomplete', 'truncated', 'isTruncated', 'hasMore', 'more'];
  const continuation = ['continuation', 'continuationToken', 'nextToken', 'nextPageToken', 'nextPage', 'nextCursor'];
  if (partial.some(key => value[key] !== undefined && value[key] !== null && value[key] !== false && value[key] !== 0)
      || ['complete', 'isComplete'].some(key => value[key] === false)
      || continuation.some(key => value[key] !== undefined && value[key] !== null && value[key] !== '' && value[key] !== false)) {
    throw new IcloudApiError('iCloud returned an incomplete Hide My Email list');
  }
  if (isRecord(value.pagination)) requireCompleteSnapshot(value.pagination);
}

/** Shared with reconciliation so injected clients cannot bypass batch validation. */
export function validateHmeSnapshot(value: unknown): HmeSnapshot {
  if (!isRecord(value) || !Array.isArray(value.hmeEmails)) {
    throw new IcloudApiError('iCloud returned no valid Hide My Email list');
  }
  requireCompleteSnapshot(value);
  const byId = new Map<string, HmeEntry>();
  const byAddress = new Map<string, string>();
  for (const entry of value.hmeEmails) {
    if (!isRecord(entry) || typeof entry.anonymousId !== 'string' || !entry.anonymousId.trim()
        || typeof entry.hme !== 'string' || !entry.hme.trim() || typeof entry.isActive !== 'boolean') {
      throw new IcloudApiError('iCloud returned an invalid Hide My Email entry');
    }
    const alias: HmeEntry = {
      hme: entry.hme, anonymousId: entry.anonymousId, isActive: entry.isActive,
      label: typeof entry.label === 'string' ? entry.label : '',
      note: typeof entry.note === 'string' ? entry.note : '',
    };
    const previous = byId.get(alias.anonymousId);
    if ((previous && (previous.hme !== alias.hme || previous.isActive !== alias.isActive
        || previous.label !== alias.label || previous.note !== alias.note))
        || (byAddress.has(alias.hme) && byAddress.get(alias.hme) !== alias.anonymousId)) {
      throw new IcloudApiError('iCloud returned conflicting Hide My Email entries');
    }
    byId.set(alias.anonymousId, alias);
    byAddress.set(alias.hme, alias.anonymousId);
  }
  return {
    hmeEmails: [...byId.values()],
    selectedForwardTo: typeof value.selectedForwardTo === 'string' ? value.selectedForwardTo : '',
    forwardToEmails: Array.isArray(value.forwardToEmails) ? value.forwardToEmails : [],
  };
}

interface Envelope<T> {
  success?: boolean;
  result?: T;
  error?: { errorMessage?: string };
}

export class IcloudClient {
  private readonly cookies: string;
  private readonly region: IcloudRegion;
  private resolvedServiceUrl: string;

  constructor(opts: { cookies: string; region: string; serviceUrl?: string }) {
    this.cookies = opts.cookies.trim();
    this.region = opts.region === 'china' ? 'china' : 'global';
    this.resolvedServiceUrl = opts.serviceUrl ?? '';
  }

  private headers(): Record<string, string> {
    const cfg = ICLOUD_REGIONS[this.region];
    return {
      'Content-Type': 'text/json',
      Accept: '*/*',
      Origin: cfg.webOrigin,
      Referer: `${cfg.webOrigin}/`,
      Cookie: this.cookies,
    };
  }

  serviceUrl(): string {
    if (!this.resolvedServiceUrl) {
      throw new IcloudApiError('iCloud service url has not been resolved; call validate() first');
    }
    return this.resolvedServiceUrl;
  }

  /**
   * Read a response body that is only *probably* JSON.
   *
   * An expired session gets an HTML sign-in page or a bare 401, and a raw
   * res.json() turns that into `Unexpected token '<'` — which sends the
   * operator looking for a parser bug instead of re-copying their cookie.
   */
  private async readJson<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      // Apple sometimes puts the same `{ success: false }` operation result
      // behind a non-2xx status. Only these explicit business rejections are
      // safe to classify as definitive; auth/not-found/server statuses remain
      // ambiguous because the request may have reached the service boundary.
      if ([400, 409].includes(res.status)) {
        try {
          const body = JSON.parse(text) as Envelope<unknown>;
          if (body.success === false) {
            throw new IcloudDefinitiveRejection(body.error?.errorMessage || `iCloud rejected ${what}`);
          }
        } catch (e) {
          if (e instanceof IcloudDefinitiveRejection) throw e;
        }
      }
      // 421 is what Apple actually answers a stale or wrong-partition cookie
      // with — it arrives far more often than a plain 401, and its body is a
      // JSON blob pointing at the sign-in widget. Saying "HTTP 421" and
      // dumping that blob tells the operator nothing they can act on.
      const expired = res.status === 401 || res.status === 403 || res.status === 421;
      const hint = expired
        ? 'the iCloud session is not valid — sign in at icloud.com and copy a fresh Cookie header (it must include X-APPLE-WEBAUTH-TOKEN and X-APPLE-WEBAUTH-USER)'
        : text.slice(0, 200).replace(/\s+/g, ' ').trim();
      throw new UpstreamHttpError(
        `iCloud ${what} failed with HTTP ${res.status}${hint ? `: ${hint}` : ''}`,
        res.status,
        res.headers.get('Retry-After'),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IcloudApiError(
        `iCloud ${what} returned a non-JSON body, which usually means the session is no longer signed in: ${text.slice(0, 200).replace(/\s+/g, ' ').trim()}`,
      );
    }
  }

  /**
   * Ask Apple which partition host serves this account.
   *
   * The host is per-account (p68…, p217…), so hardcoding one works until it
   * silently does not.
   */
  async validate(): Promise<string> {
    const res = await fetchWithTimeout(`${ICLOUD_REGIONS[this.region].setupUrl}/validate`, {
      method: 'POST',
      headers: this.headers(),
    });
    const body = await this.readJson<{ webservices?: { premiummailsettings?: { url?: string } } }>(res, 'sign-in check');
    const url = body.webservices?.premiummailsettings?.url;
    if (!url) {
      throw new IcloudApiError(
        'iCloud is signed in but exposes no Hide My Email service, which means this Apple ID has no active iCloud+ subscription',
      );
    }
    this.resolvedServiceUrl = url;
    return url;
  }

  /**
   * Resolve the partition host on first use.
   *
   * Without this a freshly added account fails every call until someone thinks
   * to press "test connection" first — an ordering nobody can guess, and the
   * error it produced ("call validate() first") described our internals rather
   * than anything the operator could act on.
   */
  private async ensureService(): Promise<void> {
    if (!this.resolvedServiceUrl) await this.validate();
  }

  private async call<T>(method: 'GET' | 'POST', path: string, data?: unknown, requireCompleteList = false, assertAuthority?: () => void): Promise<T> {
    await this.ensureService();
    // Service discovery can await a slow validate. Authority must be checked
    // after it, immediately before the non-retryable upstream write.
    assertAuthority?.();
    const res = await fetchWithTimeout(`${this.serviceUrl()}${path}`, {
      method,
      headers: this.headers(),
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assertAuthority?.();
    const body = await this.readJson<Envelope<T>>(res, `${method} ${path}`);
    assertAuthority?.();
    if (requireCompleteList) {
      const envelope: unknown = body;
      if (!isRecord(envelope) || envelope.success !== true) {
        throw new IcloudApiError('iCloud did not confirm a successful Hide My Email list');
      }
      requireCompleteSnapshot(envelope);
    }
    if (body.success === false) {
      throw new IcloudDefinitiveRejection(body.error?.errorMessage || `iCloud rejected ${method} ${path}`);
    }
    if (body.result === undefined) {
      throw new IcloudApiError(`iCloud returned no result for ${method} ${path}`);
    }
    return body.result;
  }

  async generate(): Promise<string> {
    const result = await this.call<{ hme: string }>('POST', '/v1/hme/generate', {
      langCode: ICLOUD_REGIONS[this.region].langCode,
    });
    return result.hme;
  }

  async reserve(hme: string, label: string, note: string): Promise<{ hme: string; anonymousId: string }> {
    const result = await this.call<{ hme: HmeEntry }>('POST', '/v1/hme/reserve', { hme, label, note });
    return { hme: result.hme.hme, anonymousId: result.hme.anonymousId };
  }

  async list(): Promise<HmeEntry[]> {
    return (await this.listWithForwarding()).hmeEmails;
  }

  /**
   * The list endpoint also names where the aliases forward to, which is the
   * only thing that says which mailbox to read.
   *
   * Assuming the Apple ID's own address is wrong: Hide My Email forwards to a
   * verified address the account owner chose, and when the Apple ID is some
   * other provider's address that destination is usually not an Apple mailbox
   * at all. Reading it off the account beats making the operator guess.
   */
  async listWithForwarding(assertAuthority?: () => void): Promise<HmeSnapshot> {
    return validateHmeSnapshot(await this.call<unknown>('GET', '/v2/hme/list', undefined, true, assertAuthority));
  }

  async deactivate(anonymousId: string, assertAuthority?: () => void): Promise<void> {
    await this.call<unknown>('POST', '/v1/hme/deactivate', { anonymousId }, false, assertAuthority);
  }
}
