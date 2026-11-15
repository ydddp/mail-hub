import { ApiError } from './api.js';
import type { ApiClient, CodeResult, InboxStatus, MessageDetail, ProviderSummary, ReportResult } from './api.js';
import { normalizeService } from './service.js';
import {
  SESSION_VERSION,
  cloneSessionState,
  emptySessionState,
} from './storage.js';
import type { SessionPage, SessionState, SessionStore, StoredResult } from './storage.js';

export interface SessionDeps {
  client: ApiClient;
  store: SessionStore;
  ownerId: string;
  tabId: string | null;
  now?: () => number;
  initialState?: SessionState | null;
}

export interface CreateInboxRequest {
  /** Service resolved for the page the session was created on. */
  service: string;
  /** `null` = auto dispatch. Only affects this allocation. */
  provider: string | null;
}

export interface WaitForCodeResult extends CodeResult {
  /** True when a newer action superseded this poll, so nothing was recorded. */
  stale: boolean;
  /** A message exists even if the extractor found nothing usable in it. */
  arrived: boolean;
}

/**
 * Mail bodies are shown as text only. Tracking pixels and markup never reach the
 * panel, so nothing in a message can load or execute by being displayed.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*(p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const UNKNOWN_OUTCOME: ReadonlySet<string> = new Set(['timeout', 'network', 'protocol']);

function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ApiError && UNKNOWN_OUTCOME.has(error.kind);
}

/**
 * One mailbox run. Every value that ends up on a request is frozen when it is
 * decided — service at creation, provider per allocation — so a later
 * navigation, selector change or refresh cannot retarget an existing inbox.
 */
export class AssistantSession {
  private readonly client: ApiClient;
  private readonly store: SessionStore;
  private readonly now: () => number;
  private current: SessionState;
  /** Bumped by cancel/reset; a response from an older generation is discarded. */
  private generation = 0;
  /**
   * Which write is currently in flight. A second press of the same button must
   * be a no-op rather than a second non-idempotent request.
   */
  private busy: 'create' | 'report' | 'close' | null = null;

  constructor(deps: SessionDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    const initial = deps.initialState
      ?? {
        ...emptySessionState({ ownerId: deps.ownerId, tabId: deps.tabId, now: this.now() }),
      };
    this.current = {
      ...emptySessionState({ ownerId: deps.ownerId, tabId: deps.tabId, now: this.now() }),
      ...cloneSessionState({ ...initial, version: SESSION_VERSION }),
      ownerId: deps.ownerId,
      tabId: deps.tabId,
    };
  }

  get state(): SessionState {
    return cloneSessionState(this.current);
  }

  get inboxGeneration(): number {
    return this.generation;
  }

  /** Load the persisted run for this connection, if any. */
  static async restore(deps: SessionDeps): Promise<AssistantSession | null> {
    const stored = deps.initialState !== undefined ? deps.initialState : await deps.store.load();
    if (!stored) return null;
    return new AssistantSession({ ...deps, initialState: stored });
  }

  private async patch(changes: Partial<SessionState>): Promise<void> {
    this.current = {
      ...this.current,
      ...changes,
      version: SESSION_VERSION,
      updatedAt: this.now(),
    };
    await this.store.save(this.current);
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw new ApiError('aborted', '请求已取消');
    }
  }

  /**
   * Cancel whatever is in flight and stop accepting its response. Used when the
   * user closes the session, changes connection, or replaces the inbox.
   */
  cancel(): void {
    this.generation += 1;
  }

  /** Record the page the panel is currently on without touching the inbox. */
  notePage(page: SessionPage): void {
    this.current = { ...this.current, page: { ...page }, updatedAt: this.now() };
  }

  /** Provider choice for the *next* allocation only. */
  selectProvider(provider: string | null): void {
    this.current = { ...this.current, nextProvider: provider, updatedAt: this.now() };
  }

  async setProviders(_providers: ProviderSummary[]): Promise<void> {
    // Kept as an explicit hook so callers cannot mistake a refreshed provider
    // list for a reason to rewrite the current inbox's provider.
  }

  async createInbox(request: CreateInboxRequest): Promise<SessionState> {
    if (this.busy === 'create') return this.state;
    const service = normalizeService(request.service);
    if (!service) throw new Error('服务标识不可用');

    const generation = ++this.generation;
    this.busy = 'create';
    const previousPhase = this.current.phase;
    // The previous inbox stays in place until a new one actually exists: a
    // failed replacement must not cost the user their current address.
    await this.patch({
      phase: 'creating',
      requestStartedAt: this.now(),
      page: { url: this.current.page?.url ?? '', service },
      ...(request.provider ? { nextProvider: request.provider } : {}),
    });

    try {
      const created = await this.client.createInbox({ service, provider: request.provider });
      this.assertCurrent(generation);
      await this.patch({
        phase: 'polling',
        requestStartedAt: null,
        inbox: {
          id: created.id,
          address: created.address,
          provider: created.provider,
          // The service is taken from what we asked for, not from anything the
          // page did afterwards.
          service,
          expiresAt: created.expiresAt,
          createdAt: this.now(),
        },
        reported: false,
        reportedAt: null,
        seenMessageIds: [],
        lastResult: null,
      });
      return this.state;
    } catch (error) {
      this.assertCurrent(generation);
      // An unanswered create may still have produced a mailbox server-side.
      // Say so instead of inviting a blind retry that would allocate a second.
      await this.patch({
        phase: isUnknownOutcome(error) ? 'create-unknown' : previousPhase,
        requestStartedAt: isUnknownOutcome(error) ? this.current.requestStartedAt : null,
        page: { url: this.current.page?.url ?? '', service },
      });
      throw error;
    } finally {
      this.busy = null;
    }
  }

  async reportSuccess(): Promise<ReportResult> {
    const inbox = this.current.inbox;
    if (!inbox) throw new Error('还没有可上报的邮箱');
    // report is not idempotent upstream: two calls count as two successes.
    if (this.busy === 'report') return { ok: this.current.reported, action: 'in_flight' };
    if (this.current.reported || this.current.phase === 'report-unknown') {
      return { ok: this.current.reported, action: 'already_reported' };
    }

    // Another tab of the same connection may have reported while this one sat
    // open. `report` is not idempotent, so re-read the persisted flag before
    // spending a second call.
    const persisted = await this.store.load();
    if (persisted?.reported || persisted?.phase === 'report-unknown') {
      this.current = {
        ...this.current,
        reported: persisted.reported,
        reportedAt: persisted.reportedAt,
        phase: persisted.reported ? 'reported' : 'report-unknown',
      };
      return { ok: persisted.reported, action: 'already_reported' };
    }

    const generation = ++this.generation;
    this.busy = 'report';
    const previousPhase = this.current.phase;
    await this.patch({ phase: 'reporting', requestStartedAt: this.now() });

    try {
      const result = await this.client.reportSuccess(inbox.id, inbox.service);
      this.assertCurrent(generation);
      await this.patch({ phase: 'reported', reported: true, reportedAt: this.now(), requestStartedAt: null });
      return result;
    } catch (error) {
      this.assertCurrent(generation);
      // A timeout may mean the server already counted it. Never replay.
      await this.patch({
        phase: isUnknownOutcome(error) ? 'report-unknown' : previousPhase,
        requestStartedAt: isUnknownOutcome(error) ? this.current.requestStartedAt : null,
      });
      throw error;
    } finally {
      this.busy = null;
    }
  }

  async closeInbox(): Promise<ReportResult | null> {
    const inbox = this.current.inbox;
    if (!inbox) return null;
    if (this.busy === 'close') return { ok: false, action: 'in_flight' };
    if (this.current.phase === 'closed') return { ok: true, action: 'already_closed' };

    const generation = ++this.generation;
    this.busy = 'close';
    await this.patch({ phase: 'closing', requestStartedAt: this.now() });

    try {
      const result = await this.client.closeInbox(inbox.id);
      this.assertCurrent(generation);
      await this.patch({ phase: 'closed', requestStartedAt: null });
      return result;
    } catch (error) {
      this.assertCurrent(generation);
      await this.patch({ phase: 'close-failed', requestStartedAt: null });
      throw error;
    } finally {
      this.busy = null;
    }
  }

  /** Report, and only then close. A failed report never falls through to close. */
  async finishSuccessfully(): Promise<{ reported: boolean; closed: boolean }> {
    // One combined action must not be started twice from a double click.
    if (this.busy) return { reported: this.current.reported, closed: this.current.phase === 'closed' };
    await this.reportSuccess();
    await this.closeInbox();
    return { reported: true, closed: true };
  }

  async pollOnce(timeoutSeconds: number): Promise<WaitForCodeResult> {
    const inbox = this.current.inbox;
    if (!inbox) throw new Error('还没有可收件的邮箱');
    const generation = this.generation;

    const result = await this.client.waitForCode({
      inboxId: inbox.id,
      timeoutSeconds,
      exclude: [...this.current.seenMessageIds],
    });

    if (generation !== this.generation) {
      return { ...result, stale: true, arrived: result.messageId !== null };
    }

    if (result.messageId && !this.current.seenMessageIds.includes(result.messageId)) {
      // A message that produced no code still counts as arrived: it must be shown
      // to the user, and it is excluded from later polls so we do not spin on it.
      const lastResult: StoredResult = {
        messageId: result.messageId,
        receivedAt: result.receivedAt,
        codes: result.codes.map((code) => ({
          type: code.type,
          value: code.value,
          ...(code.context ? { context: code.context } : {}),
        })),
        subject: result.email?.subject ?? null,
        from: result.email?.from ?? null,
        used: false,
      };
      await this.patch({
        seenMessageIds: [...this.current.seenMessageIds, result.messageId],
        // Reporting is not undone by a later message; keep the stage it reached.
        phase: this.current.phase === 'reported' ? 'reported' : 'result',
        lastResult,
      });
    }
    return { ...result, stale: false, arrived: result.messageId !== null };
  }

  /**
   * Wait for the next message. The previous result stays on record (still
   * copyable) but is no longer what the run is showing.
   */
  async continuePolling(): Promise<void> {
    const phase = this.current.phase;
    if (!this.current.inbox || phase === 'closed' || phase === 'closing') return;
    if (phase === 'reported' || this.current.reported) {
      await this.patch({ phase: 'reported' });
      return;
    }
    await this.patch({ phase: 'polling' });
  }

  /** The user acted on the result; the next step is finishing the run. */
  async markResultUsed(): Promise<void> {
    if (!this.current.lastResult || this.current.lastResult.used) return;
    await this.patch({ lastResult: { ...this.current.lastResult, used: true } });
  }

  /** Fetch one message and reduce it to plain text for display. */
  async fetchMessage(messageId: string): Promise<MessageDetail & { bodyText: string }> {
    const inbox = this.current.inbox;
    if (!inbox) throw new Error('还没有可收件的邮箱');
    const detail = await this.client.getMessage(inbox.id, messageId);
    const text = detail.text && detail.text.trim() ? detail.text : htmlToText(detail.html ?? '');
    const bodyText = text.trim() || detail.excerpt.trim();
    return { ...detail, bodyText };
  }

  /**
   * Forget the exclusion list. Message-id exclusion is what stops a re-seen
   * message from being reported as new, but the server caps the list; dropping
   * it is therefore an explicit user action, never a silent truncation.
   */
  async resetSeen(): Promise<void> {
    if (this.current.seenMessageIds.length === 0) return;
    await this.patch({ seenMessageIds: [] });
  }

  /** Verify a persisted inbox still exists for this identity before trusting it. */
  async verify(): Promise<InboxStatus | null> {
    const inbox = this.current.inbox;
    if (!inbox) return null;
    const status = await this.client.getInbox(inbox.id);
    if (status.status === 'closed') {
      await this.patch({ phase: 'closed' });
    }
    return status;
  }
}
