import { ApiError, createApiClient, normalizeBaseUrl } from './api.js';
import type { ApiClient, ProviderSummary } from './api.js';
import { fillPage, trackPageFocus } from './fill.js';
import { resolveLang, setLang, t } from './i18n.js';
import type { FillKind } from './fill.js';
import { createGmKeyValueStore, createGmTransport, detectGm, readTabState, writeTabState } from './gm.js';
import type { GmApi } from './gm.js';
import { createPanel } from './panel.js';
import type { ConnectForm, PanelCandidate, PanelHandle, PanelResult, Position, Presence } from './panel.js';
import { resolveService } from './service.js';
import { formatShortcut, matchesShortcut, parseShortcut, shortcutFromEvent } from './shortcut.js';
import { AssistantSession } from './session.js';
import {
  activeProfile,
  identityId,
  keyValueSessionStore,
  loadConnectionBook,
  loadSettings,
  profileTitle,
  removeProfile,
  saveConnectionBook,
  saveSettings,
  selectProfile,
  sessionKey,
  upsertProfile,
} from './storage.js';
import type { ConnectionBook, ConnectionProfile, LanguagePreference, Phase, StoredResult, ThemePreference } from './storage.js';
import { capsuleFor, drawerPlan, isLive, resultShape, stageOf } from './view.js';
import type { CapsuleAction } from './view.js';

const DEFAULT_SHORTCUT = 'Alt+Shift+M';
const POLL_TIMEOUT_SECONDS = 20;
const POLL_GAP_MS = 1000;
const ERROR_BACKOFF_MS = 5000;
/** Phases in which the run is actively waiting for mail. */
const POLLING_PHASES: ReadonlySet<Phase> = new Set(['polling', 'reported']);
/** Phases in which the last message is what the run is showing. */
const SHOWING_RESULT: ReadonlySet<Phase> = new Set([
  'result', 'reported', 'reporting', 'report-unknown', 'closing', 'close-failed', 'closed',
]);

interface UiState {
  mode: 'connect' | 'ready';
  connect: ConnectForm | null;
  providers: ProviderSummary[];
  /** Provider for the next allocation; null = auto. */
  provider: string | null;
  /** A poll loop is running. */
  waiting: boolean;
  waitingSince: number | null;
  /** Short label for the status line; the detail goes to the drawer. */
  notice: { text: string; tone: 'warn' | 'error'; detail: string | null } | null;
  /** A write is in flight but the session has not persisted its phase yet. */
  pending: 'reporting' | 'closing' | null;
  addressUsed: boolean;
  bodyVisible: boolean;
  bodies: Map<string, string>;
  drawer: 'closed' | 'main' | 'settings';
  presence: Presence;
  confirmReplace: boolean;
  unseen: boolean;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'unauthorized': return t('err.unauthorized');
      case 'forbidden': return t('err.forbidden');
      case 'not-found': return t('err.notFound');
      case 'quota': return error.retryAfter ? t('err.quotaAfter', { after: error.retryAfter }) : t('err.quota');
      case 'upstream': return t('err.upstream');
      case 'network': return t('err.network');
      case 'timeout': return t('err.timeout');
      case 'aborted': return t('err.aborted');
      case 'protocol': return t('err.protocol');
      default: return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ApiError && ['timeout', 'network', 'protocol'].includes(error.kind);
}

function toPanelResult(stored: StoredResult, bodyText: string | null): PanelResult {
  const candidates: PanelCandidate[] = stored.codes
    .filter((code) => code.type !== 'link')
    .map((code) => ({ value: code.value, type: code.type, context: code.context }));
  let link: PanelResult['link'] = null;
  const linkCode = stored.codes.find((code) => code.type === 'link');
  if (linkCode) {
    try {
      const url = new URL(linkCode.value);
      if (url.protocol === 'http:' || url.protocol === 'https:') link = { url: url.toString(), domain: url.hostname };
    } catch { /* a malformed link is simply not offered */ }
  }
  return {
    candidates,
    link,
    subject: stored.subject,
    from: stored.from,
    receivedAt: stored.receivedAt,
    bodyText,
    messageId: stored.messageId,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function main(): Promise<void> {
  // The panel belongs to the page the user is on, never to a frame inside it.
  if (window.top !== window.self) return;
  const gm = detectGm();
  if (!gm) return;

  const store = createGmKeyValueStore(gm);
  const settings = await loadSettings(store);
  const browserLanguages = () => (navigator.languages?.length ? navigator.languages : [navigator.language ?? '']);
  setLang(resolveLang(settings.language, browserLanguages()));

  /** Switching language re-labels the open panel in place; no state is lost. */
  function applyLanguage(): void {
    setLang(resolveLang(settings.language, browserLanguages()));
    panel?.relabel();
    render();
  }
  let book: ConnectionBook = await loadConnectionBook(store);
  let connection: ConnectionProfile | null = activeProfile(book);
  let client: ApiClient | null = null;
  let session: AssistantSession | null = null;
  let panel: PanelHandle | null = null;
  let pollToken = 0;
  let getting = false;
  let capturingShortcut = false;

  const ui: UiState = {
    mode: connection ? 'ready' : 'connect',
    connect: null,
    providers: [],
    provider: connection ? settings.lastProvider[identityId(connection.baseUrl, connection.apiKey)] ?? null : null,
    waiting: false,
    waitingSince: null,
    notice: null,
    pending: null,
    addressUsed: false,
    bodyVisible: false,
    bodies: new Map(),
    drawer: 'closed',
    presence: 'hidden',
    confirmReplace: false,
    unseen: false,
  };

  const ownerId = () => (connection ? identityId(connection.baseUrl, connection.apiKey) : null);
  const pageService = () => {
    const resolved = resolveService(location.href, { mappings: settings.mappings });
    return resolved.ok ? resolved.service : null;
  };
  /** Main domain that owns positions and site preferences. */
  const siteKey = () => pageService() ?? session?.state.inbox?.service ?? 'unknown';
  const persistSettings = () => saveSettings(store, settings);

  // ----------------------------------------------------------------- render

  function render(): void {
    if (!panel) return;
    const state = session?.state ?? null;
    const inbox = state?.inbox ?? null;
    // Show "上报中/关闭中" from the click, not from when the session gets to persist it.
    const phase: Phase = inbox && ui.pending ? ui.pending : state?.phase ?? 'idle';
    const last = state?.lastResult ?? null;
    const hasResult = Boolean(last && inbox && SHOWING_RESULT.has(phase));
    const showPrevious = Boolean(last && inbox && !hasResult && phase !== 'creating' && phase !== 'create-unknown');
    const stage = stageOf({ phase, hasInbox: Boolean(inbox), reported: state?.reported ?? false, hasResult });
    const result = last && (hasResult || showPrevious)
      ? toPanelResult(last, last.messageId ? ui.bodies.get(last.messageId) ?? null : null)
      : null;
    const plan = drawerPlan(stage, Boolean(result), ui.waiting);
    const live = isLive(stage);
    const nextService = pageService();
    const service = live && inbox ? inbox.service : nextService;
    const capsule = capsuleFor({
      stage,
      address: inbox?.address ?? null,
      service,
      result: hasResult && result ? resultShape(result) : null,
      addressUsed: ui.addressUsed,
      resultUsed: last?.used ?? false,
      notice: ui.notice ? { text: ui.notice.text, tone: ui.notice.tone } : null,
      providerLabel: ui.provider
        ? ui.providers.find((provider) => provider.name === ui.provider)?.displayName ?? ui.provider
        : t('cap.auto'),
    });

    panel.render({
      mode: ui.mode,
      connect: ui.connect,
      stage,
      capsule,
      plan,
      service,
      foreignService: live && inbox && nextService !== inbox.service ? inbox.service : null,
      providers: ui.providers,
      provider: ui.provider,
      inboxProvider: inbox?.provider ?? null,
      expiresAt: inbox?.expiresAt ?? null,
      address: inbox?.address ?? null,
      result,
      resultIsPrevious: showPrevious,
      waitingSince: ui.waiting ? ui.waitingSince : null,
      presence: ui.presence,
      drawer: ui.drawer,
      bodyVisible: ui.bodyVisible,
      confirmReplace: ui.confirmReplace,
      noticeDetail: ui.notice?.detail ?? null,
      noticeTone: ui.notice?.tone ?? null,
      unseen: ui.unseen,
      theme: settings.theme,
      language: settings.language,
      shortcut: settings.shortcut || DEFAULT_SHORTCUT,
      connectionLabel: connection ? profileTitle(connection) : null,
      connections: book.profiles.map((profile) => ({
        id: profile.id,
        title: profileTitle(profile),
        host: (() => { try { return new URL(profile.baseUrl).host; } catch { return profile.baseUrl; } })(),
        active: profile.id === book.activeId,
      })),
      position: settings.panelPositions[siteKey()] ?? null,
      tabPosition: settings.fabPositions[siteKey()] ?? null,
    });
  }

  // ----------------------------------------------------------------- feedback

  async function copy(value: string, label = t('fb.copied')): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      panel?.flash(label);
      return;
    } catch { /* fall through to the legacy path */ }
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      panel?.flash(label);
    } catch {
      panel?.flash(t('fb.copyFailed'));
    }
  }

  function setNotice(text: string | null, tone: 'warn' | 'error' = 'error', detail: string | null = null): void {
    ui.notice = text ? { text, tone, detail } : null;
  }

  // ----------------------------------------------------------------- tab follow

  /**
   * A run follows its tab across navigations — including to another site, such
   * as an OAuth page — so the capsule comes back without the user re-summoning
   * it there. Other tabs are unaffected.
   */
  async function markTab(active: boolean): Promise<void> {
    const owner = ownerId();
    if (!owner) return;
    await writeTabState(gm as GmApi, active ? { mailhubRun: owner } : {});
  }

  // ----------------------------------------------------------------- polling

  function stopPolling(): void {
    pollToken += 1;
    ui.waiting = false;
  }

  function startPolling(since = Date.now()): void {
    pollToken += 1;
    const token = pollToken;
    ui.waiting = true;
    ui.waitingSince = since;
    void pollLoop(token);
  }

  async function pollLoop(token: number): Promise<void> {
    while (token === pollToken && session) {
      const state = session.state;
      if (!state.inbox || !POLLING_PHASES.has(state.phase)) break;
      try {
        const result = await session.pollOnce(POLL_TIMEOUT_SECONDS);
        if (token !== pollToken || result.stale) return;
        if (ui.notice?.tone === 'warn') setNotice(null);
        if (result.arrived) {
          ui.waiting = false;
          ui.bodyVisible = false;
          if (ui.presence === 'tab') ui.unseen = true;
          // Several candidates are a decision the user has to see.
          if (ui.presence === 'capsule' && result.codes.filter((code) => code.type !== 'link').length > 1) ui.drawer = 'main';
          render();
          return;
        }
        render();
        await sleep(POLL_GAP_MS);
      } catch (error) {
        if (token !== pollToken) return;
        if (error instanceof ApiError && error.kind === 'aborted') return;
        if (error instanceof ApiError && error.kind === 'not-found') {
          ui.waiting = false;
          setNotice(t('note.inboxGone'));
          render();
          return;
        }
        // Branch on the error's code, never on its (translated) message.
        if (error instanceof ApiError && error.code === 'exclusions-full') {
          ui.waiting = false;
          setNotice(t('note.seenFull'), 'warn', t('note.seenFullDetail'));
          render();
          return;
        }
        // Transient: say so, back off, keep the run alive.
        setNotice(t('note.pollError'), 'warn', describeError(error));
        render();
        await sleep(ERROR_BACKOFF_MS);
      }
    }
    if (token === pollToken) {
      ui.waiting = false;
      render();
    }
  }

  // ----------------------------------------------------------------- connection

  function ensureClient(): ApiClient | null {
    if (client) return client;
    if (!connection) return null;
    client = createApiClient({ baseUrl: connection.baseUrl, apiKey: connection.apiKey, send: createGmTransport(gm as GmApi) });
    return client;
  }

  async function ensureSession(): Promise<AssistantSession | null> {
    const api = ensureClient();
    const owner = ownerId();
    if (!api || !owner) return null;
    if (session) return session;
    const sessionStore = keyValueSessionStore(store, sessionKey(owner, null));
    session = await AssistantSession.restore({ client: api, store: sessionStore, ownerId: owner, tabId: null })
      ?? new AssistantSession({ client: api, store: sessionStore, ownerId: owner, tabId: null });
    return session;
  }

  async function refreshProviders(): Promise<void> {
    const api = ensureClient();
    if (!api) return;
    try {
      ui.providers = await api.listProviders();
      const remembered = ui.provider && ui.providers.find((provider) => provider.name === ui.provider);
      // A remembered provider that can no longer poll would fail every dispatch.
      if (ui.provider && (!remembered || !remembered.enabled || !remembered.features.pollInbox)) ui.provider = null;
    } catch (error) {
      setNotice(t('note.providersFailed'), 'error', describeError(error));
    }
    render();
  }

  /**
   * Bring the panel in line with what is persisted. Runs on every mount and
   * summon: a page navigation reloads this script, and the panel must return to
   * the run that already exists rather than offer to create one.
   */
  async function hydrate(): Promise<void> {
    if (!connection) {
      ui.mode = 'connect';
      ui.connect = ui.connect ?? blankConnectForm();
      render();
      return;
    }
    ui.mode = 'ready';
    const active = await ensureSession();
    render();
    if (ui.providers.length === 0) void refreshProviders();
    if (!active?.state.inbox) return;

    const phase = active.state.phase;
    // An action may have reached the server unanswered (restore already turned
    // a dead in-flight phase into its "unknown" outcome). Reloading must not
    // turn that into a retry.
    if (active.recoveredFrom === 'creating') { setNotice(t('note.createUnknown'), 'error', t('note.createUnknownDetail')); render(); return; }
    if (phase === 'report-unknown') { setNotice(t('note.reportUnknown'), 'error', t('note.reportUnknownDetail')); render(); return; }
    if (phase === 'closed') return;
    // Only this page's own live request can be in one of these now; let it answer.
    if (phase === 'creating' || phase === 'reporting' || phase === 'closing') return;

    try {
      // A close is idempotent, so an unanswered one is settled by asking.
      const status = await active.verify();
      if (status?.status === 'closed') {
        stopPolling();
        render();
        return;
      }
      if (active.recoveredFrom === 'closing') setNotice(t('note.closeUnknown'), 'error', t('note.closeUnknownDetail'));
      if (POLLING_PHASES.has(active.state.phase) && !ui.waiting) {
        startPolling(active.state.lastResult ? Date.now() : active.state.inbox.createdAt);
      }
      render();
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not-found') {
        stopPolling();
        setNotice(t('note.serverGone'));
      } else {
        setNotice(t('note.verifyFailed'), 'warn', describeError(error));
      }
      render();
    }
  }

  /** Warn about plaintext only for http that leaves this machine. */
  function plaintextWarning(baseUrl: string): boolean {
    if (!baseUrl) return false;
    const parsed = normalizeBaseUrl(baseUrl);
    return parsed.ok && parsed.insecure;
  }

  /**
   * Installed from a Mail Hub, the first connection defaults to that Mail Hub;
   * the user only adds a key. Later connections start blank.
   */
  function blankConnectForm(): ConnectForm {
    const servedFrom = __MAILHUB_SERVED_FROM__.startsWith('%%') ? '' : __MAILHUB_SERVED_FROM__;
    const baseUrl = book.profiles.length === 0 ? servedFrom : '';
    return {
      editingId: null, label: '', baseUrl, apiKey: '', insecure: plaintextWarning(baseUrl), error: null, busy: false,
    };
  }

  /** Everything in memory belongs to one identity; a switch starts clean. */
  function leaveIdentity(): void {
    stopPolling();
    session = null;
    client = null;
    ui.providers = [];
    ui.addressUsed = false;
    ui.bodies.clear();
    ui.bodyVisible = false;
    ui.confirmReplace = false;
    setNotice(null);
  }

  async function useProfile(profile: ConnectionProfile | null): Promise<void> {
    const changed = (connection?.baseUrl !== profile?.baseUrl) || (connection?.apiKey !== profile?.apiKey);
    if (changed) leaveIdentity();
    connection = profile;
    const owner = ownerId();
    ui.provider = owner ? settings.lastProvider[owner] ?? null : null;
    await saveConnectionBook(store, book);
    await hydrate();
  }

  /**
   * Switching is instant: each connection keeps its own run in the script
   * manager, so the other one's inbox is still there when switching back.
   */
  async function switchConnection(id: string): Promise<void> {
    if (id === book.activeId) return;
    book = selectProfile(book, id);
    await useProfile(activeProfile(book));
    panel?.flash(t('fb.switched', { name: connection ? profileTitle(connection) : '—' }));
  }

  async function deleteConnection(id: string): Promise<void> {
    const wasActive = id === book.activeId;
    book = removeProfile(book, id);
    if (wasActive) {
      await useProfile(activeProfile(book));
      if (!connection) { ui.mode = 'connect'; ui.connect = blankConnectForm(); }
    } else {
      await saveConnectionBook(store, book);
    }
    panel?.flash(t('fb.deleted'));
    render();
  }

  async function submitConnection(input: { label: string; baseUrl: string; apiKey: string }): Promise<void> {
    const editingId = ui.connect?.editingId ?? null;
    const base = normalizeBaseUrl(input.baseUrl);
    const apiKey = input.apiKey.trim();
    const fail = (message: string, insecure = false) => {
      ui.connect = { editingId, label: input.label, baseUrl: input.baseUrl, apiKey, insecure, error: message, busy: false };
      render();
    };
    if (!base.ok) { fail(base.message); return; }
    if (!apiKey) { fail(t('connect.needKey'), base.insecure); return; }
    ui.connect = { editingId, label: input.label, baseUrl: base.baseUrl, apiKey, insecure: base.insecure, error: null, busy: true };
    render();

    // Prove the key works before storing it, so a typo does not look like a
    // broken assistant on the next summon. A regular key is enough.
    const candidate = createApiClient({ baseUrl: base.baseUrl, apiKey, send: createGmTransport(gm as GmApi) });
    try {
      await candidate.listProviders();
    } catch (error) {
      fail(describeError(error), base.insecure);
      return;
    }
    const saved = upsertProfile(book, {
      editingId, label: input.label, baseUrl: base.baseUrl, apiKey, insecure: base.insecure,
    });
    book = saved.book;
    ui.mode = 'ready';
    ui.connect = null;
    ui.drawer = 'closed';
    // Another identity is another partition: useProfile drops the old run's traces.
    // Editing a connection that is not in use does not switch to it.
    await useProfile(activeProfile(book));
    client = client ?? candidate;
  }

  // ----------------------------------------------------------------- actions

  async function getInbox(): Promise<void> {
    // A second press while the first allocation is unanswered would spend a
    // second provider slot for one click.
    if (getting) return;
    const service = pageService();
    if (!service) {
      setNotice(t('note.needService'), 'warn', t('note.needServiceDetail'));
      ui.drawer = 'main';
      render();
      return;
    }
    const active = await ensureSession();
    if (!active) { ui.mode = 'connect'; render(); return; }
    getting = true;
    setNotice(null);
    ui.confirmReplace = false;
    const creating = active.createInbox({ service, provider: ui.provider });
    render(); // the session is already in `creating`
    try {
      await creating;
      ui.addressUsed = false;
      ui.bodyVisible = false;
      await markTab(true);
      startPolling(Date.now());
    } catch (error) {
      if (isUnknownOutcome(error)) setNotice(t('note.createUnknown'), 'error', t('note.createUnknownAfter', { error: describeError(error) }));
      else setNotice(t('note.createFailed'), 'error', describeError(error));
    } finally {
      getting = false;
      render();
    }
  }

  async function reportAndClose(): Promise<void> {
    const active = session;
    if (!active?.state.inbox) return;
    // A retry starts clean: the previous failure's label must not sit next to 上报中.
    setNotice(null);
    if (!active.state.reported) {
      ui.pending = 'reporting';
      const reporting = active.reportSuccess();
      render();
      try {
        await reporting;
      } catch (error) {
        // Clear the in-flight marker before rendering, or the capsule stays on 上报中.
        ui.pending = null;
        // Never pretend a success, and never continue into closing as if it had counted.
        if (isUnknownOutcome(error)) setNotice(t('note.reportUnknown'), 'error', t('note.reportUnknownAfter', { error: describeError(error) }));
        else setNotice(t('note.reportFailed'), 'error', t('note.reportFailedAfter', { error: describeError(error) }));
        render();
        return;
      } finally {
        ui.pending = null;
      }
    }
    await endUse();
  }

  async function reportOnly(): Promise<void> {
    const active = session;
    if (!active?.state.inbox) return;
    setNotice(null);
    ui.pending = 'reporting';
    const reporting = active.reportSuccess();
    render();
    try {
      await reporting;
      panel?.flash(t('fb.reportedKeep'));
      if (!ui.waiting) startPolling(Date.now());
    } catch (error) {
      if (isUnknownOutcome(error)) setNotice(t('note.reportUnknown'), 'error', t('note.reportUnknownKeep', { error: describeError(error) }));
      else setNotice(t('note.reportFailed'), 'error', describeError(error));
    } finally {
      ui.pending = null;
    }
    render();
  }

  async function endUse(): Promise<boolean> {
    const active = session;
    if (!active?.state.inbox || active.state.phase === 'closed') return true;
    stopPolling();
    setNotice(null);
    ui.pending = 'closing';
    const closing = active.closeInbox();
    render();
    try {
      await closing;
      ui.pending = null;
      setNotice(null);
      ui.drawer = 'closed';
      ui.confirmReplace = false;
      await markTab(false);
      render();
      return true;
    } catch (error) {
      ui.pending = null;
      setNotice(t('note.closeFailed'), 'error', t('note.closeFailedAfter', { error: describeError(error) }));
      render();
      return false;
    }
  }

  async function replaceInbox(): Promise<void> {
    ui.confirmReplace = false;
    if (await endUse()) await getInbox();
  }

  async function continuePolling(): Promise<void> {
    if (!session?.state.inbox) return;
    await session.continuePolling();
    ui.bodyVisible = false;
    setNotice(null);
    startPolling(Date.now());
    render();
  }

  async function loadBody(): Promise<void> {
    const messageId = session?.state.lastResult?.messageId;
    if (!messageId || ui.bodies.has(messageId)) return;
    try {
      const detail = await session?.fetchMessage(messageId);
      if (detail) ui.bodies.set(messageId, detail.bodyText);
    } catch (error) {
      ui.bodies.set(messageId, t('note.readFailed', { error: describeError(error) }));
    }
    render();
  }

  async function markUsed(): Promise<void> {
    await session?.markResultUsed();
  }

  /**
   * "填入": find the page's own field and type into it. When no field is a
   * confident match, copy instead of writing somewhere surprising.
   */
  async function fill(kind: FillKind, value: string): Promise<void> {
    const outcome = fillPage(kind, value);
    if (outcome.ok) {
      if (outcome.target) panel?.highlight(outcome.target);
      if (kind === 'email') ui.addressUsed = true;
      else await markUsed();
      panel?.flash(kind === 'email' ? t('fb.filledEmail') : t('fb.filledCode'));
      // Give the page its room back; the capsule stays for the next step.
      ui.drawer = 'closed';
      render();
      return;
    }
    await copy(value, kind === 'email' ? t('fb.noEmailField') : t('fb.noCodeField'));
    if (kind === 'code') await markUsed();
    render();
  }

  function openLink(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch { panel?.flash(t('fb.badLink')); return; }
    // One-time links are opened deliberately, as a plain web navigation only.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { panel?.flash(t('fb.httpOnly')); return; }
    window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    void markUsed().then(render);
  }

  function primary(action: CapsuleAction): void {
    const last = session?.state.lastResult ?? null;
    const inbox = session?.state.inbox ?? null;
    switch (action) {
      case 'get': void getInbox(); return;
      case 'fill-address': if (inbox) void fill('email', inbox.address); return;
      case 'fill-code': {
        const code = last?.codes.find((entry) => entry.type !== 'link');
        if (code) void fill('code', code.value);
        return;
      }
      case 'open-link': {
        const link = last?.codes.find((entry) => entry.type === 'link');
        if (link) openLink(link.value);
        return;
      }
      case 'choose': ui.drawer = 'main'; render(); return;
      case 'view-message': ui.drawer = 'main'; ui.bodyVisible = true; render(); void loadBody(); return;
      case 'finish': void reportAndClose(); return;
      case 'end':
      case 'retry-close': void endUse(); return;
    }
  }

  // ----------------------------------------------------------------- presence

  function setPresence(next: Presence): void {
    ui.presence = next;
    if (next === 'capsule') ui.unseen = false;
    if (next !== 'capsule') ui.drawer = 'closed';
    render();
  }

  async function mount(): Promise<void> {
    if (panel) return;
    panel = createPanel({
      primary,
      submitConnection: (input) => { void submitConnection(input); },
      cancelConnection: () => { ui.mode = 'ready'; ui.connect = null; ui.drawer = 'settings'; render(); },
      addConnection: () => { ui.mode = 'connect'; ui.connect = blankConnectForm(); render(); },
      editConnection: (id) => {
        const profile = book.profiles.find((entry) => entry.id === id);
        if (!profile) return;
        ui.mode = 'connect';
        ui.connect = {
          editingId: profile.id, label: profile.label ?? '', baseUrl: profile.baseUrl, apiKey: profile.apiKey,
          insecure: profile.insecure, error: null, busy: false,
        };
        render();
      },
      switchConnection: (id) => { void switchConnection(id); },
      deleteConnection: (id) => { void deleteConnection(id); },
      fill: (kind, value) => { void fill(kind, value); },
      copy: (value) => {
        void copy(value);
        const last = session?.state.lastResult;
        if (last?.codes.some((code) => code.value === value)) void markUsed().then(render);
      },
      openLink,
      continuePolling: () => { void continuePolling(); },
      finish: () => { void reportAndClose(); },
      reportOnly: () => { void reportOnly(); },
      endUse: () => { void endUse(); },
      askReplace: () => { ui.confirmReplace = true; render(); },
      confirmReplace: () => { void replaceInbox(); },
      cancelReplace: () => { ui.confirmReplace = false; render(); },
      saveService: (value) => {
        const page = resolveService(location.href);
        const resolved = resolveService(location.href, { mappings: settings.mappings, override: value });
        if (!resolved.ok) { panel?.flash(t('fb.badService')); return; }
        // Remembered under the page's host so its subdomains inherit it.
        if (page.ok) settings.mappings[page.host] = resolved.service;
        else settings.mappings[location.hostname] = resolved.service;
        void persistSettings();
        setNotice(null);
        panel?.flash(t('fb.serviceSet', { service: resolved.service }));
        render();
      },
      selectProvider: (provider) => {
        ui.provider = provider;
        session?.selectProvider(provider);
        const owner = ownerId();
        if (owner) { settings.lastProvider[owner] = provider; void persistSettings(); }
        render();
      },
      toggleBody: () => { ui.bodyVisible = !ui.bodyVisible; render(); if (ui.bodyVisible) void loadBody(); },
      setDrawer: (drawer) => { ui.drawer = drawer; render(); },
      setTheme: (theme: ThemePreference) => { settings.theme = theme; void persistSettings(); render(); },
      fold: () => setPresence('tab'),
      unfold: () => { setPresence('capsule'); void hydrate(); },
      hideForVisit: () => setPresence('hidden'),
      hideSite: () => {
        const site = pageService();
        if (site && !settings.hiddenSites.includes(site)) { settings.hiddenSites.push(site); void persistSettings(); }
        setPresence('hidden');
      },
      movePanel: (position: Position) => { settings.panelPositions[siteKey()] = position; void persistSettings(); },
      moveTab: (position: Position) => { settings.fabPositions[siteKey()] = position; void persistSettings(); },
      recordShortcut: () => { capturingShortcut = true; panel?.flash(t('fb.recordShortcut')); },
      setLanguage: (language: LanguagePreference) => {
        settings.language = language;
        void persistSettings();
        applyLanguage();
        panel?.flash(t('fb.language'));
      },
      resetSeen: () => {
        void session?.resetSeen().then(() => {
          setNotice(null);
          panel?.flash(t('fb.seenReset'));
          if (session && POLLING_PHASES.has(session.state.phase) && !ui.waiting) startPolling(Date.now());
          render();
        });
      },
    });
    document.documentElement.appendChild(panel.host);
    trackPageFocus(panel.host);
  }

  /** Shortcut, script-manager menu: always the capsule with its drawer open. */
  function summon(): void {
    void (async () => {
      await mount();
      const site = pageService();
      // Summoning is how a site gets enabled; elsewhere the assistant stays out of the way.
      if (site && !settings.enabledSites.includes(site)) { settings.enabledSites.push(site); void persistSettings(); }
      if (site) settings.hiddenSites = settings.hiddenSites.filter((entry) => entry !== site);
      ui.presence = 'capsule';
      ui.unseen = false;
      ui.drawer = 'main';
      await hydrate();
    })();
  }

  window.addEventListener('keydown', (event) => {
    if (capturingShortcut) {
      if (event.key === 'Escape') { capturingShortcut = false; panel?.flash(t('fb.cancelled')); return; }
      const spec = shortcutFromEvent(event);
      if (!spec) { panel?.flash(t('fb.needModifier')); return; }
      event.preventDefault();
      event.stopPropagation();
      capturingShortcut = false;
      settings.shortcut = formatShortcut(spec);
      void persistSettings().then(render);
      panel?.flash(t('fb.shortcutSet', { shortcut: settings.shortcut }));
      return;
    }
    // Matched on event.code, so a non-Latin layout works; never mid-composition.
    if (event.isComposing || event.repeat) return;
    const spec = parseShortcut(settings.shortcut || DEFAULT_SHORTCUT);
    if (spec && matchesShortcut(event, spec)) { event.preventDefault(); summon(); }
  }, true);

  window.addEventListener('resize', () => { panel?.reclamp(); }, true);

  gm.registerMenuCommand?.(t('menu.open'), summon);
  gm.registerMenuCommand?.(t('menu.deleteConnection'), () => {
    void (async () => {
      if (book.activeId) await deleteConnection(book.activeId);
      summon();
    })();
  });

  // ----------------------------------------------------------------- start

  const site = pageService();
  const hiddenHere = site !== null && settings.hiddenSites.includes(site);
  const tabState = await readTabState(gm);
  // The run this tab is following may belong to another saved connection.
  const runOwner = book.profiles.find((profile) => identityId(profile.baseUrl, profile.apiKey) === tabState.mailhubRun);
  if (runOwner && runOwner.id !== book.activeId) {
    book = selectProfile(book, runOwner.id);
    connection = runOwner;
    ui.provider = settings.lastProvider[identityId(runOwner.baseUrl, runOwner.apiKey)] ?? null;
    await saveConnectionBook(store, book);
  }
  const followsRun = Boolean(connection && tabState.mailhubRun === ownerId());
  const enabledHere = site !== null && settings.enabledSites.includes(site);
  if (connection && !hiddenHere && (enabledHere || followsRun)) {
    await mount();
    const active = await ensureSession();
    const live = Boolean(active?.state.inbox) && active?.state.phase !== 'closed';
    // A live run comes back as the capsule; otherwise only the edge tab.
    ui.presence = live ? 'capsule' : 'tab';
    await hydrate();
  }
}

void main();
