import { ApiError, createApiClient, normalizeBaseUrl } from './api.js';
import type { ApiClient, ProviderSummary } from './api.js';
import { fillPage, trackPageFocus } from './fill.js';
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
import type { ConnectionBook, ConnectionProfile, Phase, StoredResult, ThemePreference } from './storage.js';
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
      case 'unauthorized': return 'API Key 无效或已停用';
      case 'forbidden': return '这个 Key 没有该操作的权限';
      case 'not-found': return '邮箱不存在或已被删除';
      case 'quota': return error.retryAfter ? `触发限流，${error.retryAfter} 后再试` : '触发 Mail Hub 限流，稍后再试';
      case 'upstream': return 'Mail Hub 或上游出错（5xx），稍后再试';
      case 'network': return '连不上 Mail Hub（这不代表网站拒绝了注册）';
      case 'timeout': return '请求超时，结果待确认';
      case 'aborted': return '请求已取消';
      case 'protocol': return '响应格式不对，已丢弃';
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
        : '自动分配',
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

  async function copy(value: string, label = '已复制'): Promise<void> {
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
      panel?.flash('无法自动复制，请手动选中');
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
          setNotice('邮箱已被关闭或删除');
          render();
          return;
        }
        if (error instanceof ApiError && error.kind === 'invalid' && error.message.includes('排除')) {
          ui.waiting = false;
          setNotice('收件记录已满', 'warn', '已排除的邮件到了上限。到设置里点「重置收件记录」后继续收件。');
          render();
          return;
        }
        // Transient: say so, back off, keep the run alive.
        setNotice('收件出错，稍后自动重试', 'warn', describeError(error));
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
      setNotice('读取提供商失败', 'error', describeError(error));
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
    // These phases mean an action may have reached the server unanswered.
    // Reloading must not turn that into a retry.
    if (phase === 'creating') { setNotice('上次获取结果未知', 'error', '请求发出后没收到回应，邮箱可能已经创建。确认后再获取。'); render(); return; }
    if (phase === 'reporting' || phase === 'report-unknown') { setNotice('上报结果待确认', 'error', '没收到服务端确认，可能已经计数，所以不会自动重发。'); render(); return; }
    if (phase === 'closing') { setNotice('关闭结果待确认', 'error', '可以再点「结束使用」重试。'); render(); return; }
    if (phase === 'closed') return;

    try {
      const status = await active.verify();
      if (status?.status === 'closed') {
        stopPolling();
        render();
        return;
      }
      if (POLLING_PHASES.has(active.state.phase) && !ui.waiting) {
        startPolling(active.state.lastResult ? Date.now() : active.state.inbox.createdAt);
      }
      render();
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not-found') {
        stopPolling();
        setNotice('这个邮箱在服务端已不存在');
      } else {
        setNotice('核对邮箱状态失败', 'warn', describeError(error));
      }
      render();
    }
  }

  /**
   * Installed from a Mail Hub, the first connection defaults to that Mail Hub;
   * the user only adds a key. Later connections start blank.
   */
  function blankConnectForm(): ConnectForm {
    const servedFrom = __MAILHUB_SERVED_FROM__.startsWith('%%') ? '' : __MAILHUB_SERVED_FROM__;
    const baseUrl = book.profiles.length === 0 ? servedFrom : '';
    return {
      editingId: null, label: '', baseUrl, apiKey: '', insecure: baseUrl.startsWith('http:'), error: null, busy: false,
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
    panel?.flash(`已切换到 ${connection ? profileTitle(connection) : '—'}`);
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
    panel?.flash('已删除这套连接');
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
    if (!apiKey) { fail('请填写 API Key', base.insecure); return; }
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
      setNotice('先填写服务标识', 'warn', '认不出当前网站的主域名（例如本机地址或 IP），填一个服务标识后再获取。');
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
      if (isUnknownOutcome(error)) setNotice('获取结果未知', 'error', `${describeError(error)}。邮箱可能已经创建，确认后再重试。`);
      else setNotice('获取失败', 'error', describeError(error));
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
        if (isUnknownOutcome(error)) setNotice('上报结果待确认', 'error', `${describeError(error)}。不会自动重发，也不会自动关闭。`);
        else setNotice('上报失败', 'error', `${describeError(error)}。邮箱没有关闭。`);
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
      panel?.flash('已上报成功，邮箱继续收件');
      if (!ui.waiting) startPolling(Date.now());
    } catch (error) {
      if (isUnknownOutcome(error)) setNotice('上报结果待确认', 'error', `${describeError(error)}。不会自动重发。`);
      else setNotice('上报失败', 'error', describeError(error));
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
      setNotice('关闭失败', 'error', `${describeError(error)}。可以重试。`);
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
      ui.bodies.set(messageId, `读取失败：${describeError(error)}`);
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
      panel?.flash(kind === 'email' ? '已填入邮箱' : '已填入验证码');
      // Give the page its room back; the capsule stays for the next step.
      ui.drawer = 'closed';
      render();
      return;
    }
    await copy(value, kind === 'email' ? '没找到邮箱输入框，已复制' : '没找到验证码输入框，已复制');
    if (kind === 'code') await markUsed();
    render();
  }

  function openLink(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch { panel?.flash('链接不可用'); return; }
    // One-time links are opened deliberately, as a plain web navigation only.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { panel?.flash('只支持 http(s) 链接'); return; }
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
        if (!resolved.ok) { panel?.flash('服务标识不可用'); return; }
        // Remembered under the page's host so its subdomains inherit it.
        if (page.ok) settings.mappings[page.host] = resolved.service;
        else settings.mappings[location.hostname] = resolved.service;
        void persistSettings();
        setNotice(null);
        panel?.flash(`服务标识：${resolved.service}`);
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
      recordShortcut: () => { capturingShortcut = true; panel?.flash('按下新的组合键（要含 Ctrl / Alt / Shift），Esc 取消'); },
      resetSeen: () => {
        void session?.resetSeen().then(() => {
          setNotice(null);
          panel?.flash('已重置收件记录');
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
      if (event.key === 'Escape') { capturingShortcut = false; panel?.flash('已取消'); return; }
      const spec = shortcutFromEvent(event);
      if (!spec) { panel?.flash('要同时按 Ctrl / Alt / Shift 中的至少一个'); return; }
      event.preventDefault();
      event.stopPropagation();
      capturingShortcut = false;
      settings.shortcut = formatShortcut(spec);
      void persistSettings().then(render);
      panel?.flash(`唤出快捷键：${settings.shortcut}`);
      return;
    }
    // Matched on event.code, so a non-Latin layout works; never mid-composition.
    if (event.isComposing || event.repeat) return;
    const spec = parseShortcut(settings.shortcut || DEFAULT_SHORTCUT);
    if (spec && matchesShortcut(event, spec)) { event.preventDefault(); summon(); }
  }, true);

  window.addEventListener('resize', () => { panel?.reclamp(); }, true);

  gm.registerMenuCommand?.('打开 Mail Hub 邮箱助手', summon);
  gm.registerMenuCommand?.('删除当前 Mail Hub 连接', () => {
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
