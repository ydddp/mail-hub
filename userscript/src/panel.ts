import styles from './panel.css';
import { icon } from './icons.js';
import { clampPosition, dockPosition, snapToEdge } from './layout.js';
import type { Position } from './layout.js';
import type { ProviderSummary } from './api.js';
import type { ThemePreference } from './storage.js';
import type { Capsule, CapsuleAction, DrawerPlan, LinkInfo, Stage } from './view.js';
export type { Position };

export interface PanelCandidate {
  value: string;
  type: 'numeric' | 'alphanumeric' | 'link';
  context?: string;
}

export interface PanelResult {
  /** Non-link codes, in backend order. */
  candidates: PanelCandidate[];
  link: LinkInfo | null;
  subject: string | null;
  from: string | null;
  receivedAt: string | null;
  bodyText: string | null;
  messageId: string | null;
}

export interface ConnectForm {
  /** Profile being edited; null when adding a new one. */
  editingId: string | null;
  label: string;
  baseUrl: string;
  apiKey: string;
  insecure: boolean;
  error: string | null;
  busy: boolean;
}

export type Presence = 'hidden' | 'tab' | 'capsule';

export interface PanelView {
  mode: 'connect' | 'ready';
  connect: ConnectForm | null;
  stage: Stage;
  capsule: Capsule;
  plan: DrawerPlan;
  /** Service the next inbox is for (or the frozen one of the current inbox). */
  service: string | null;
  /** Set when the current inbox belongs to another site than this page. */
  foreignService: string | null;
  providers: ProviderSummary[];
  provider: string | null;
  inboxProvider: string | null;
  expiresAt: string | null;
  address: string | null;
  result: PanelResult | null;
  /** The result is the previous message; a new one is being waited for. */
  resultIsPrevious: boolean;
  waitingSince: number | null;
  presence: Presence;
  drawer: 'closed' | 'main' | 'settings';
  bodyVisible: boolean;
  confirmReplace: boolean;
  /** Full text of the current notice; the capsule only has room for its label. */
  noticeDetail: string | null;
  noticeTone: 'warn' | 'error' | null;
  /** A result arrived while only the edge tab was showing. */
  unseen: boolean;
  theme: ThemePreference;
  shortcut: string;
  connectionLabel: string | null;
  connections: Array<{ id: string; title: string; host: string; active: boolean }>;
  position: Position | null;
  tabPosition: Position | null;
}

export interface PanelCallbacks {
  primary(action: CapsuleAction): void;
  submitConnection(input: { label: string; baseUrl: string; apiKey: string }): void;
  cancelConnection(): void;
  addConnection(): void;
  editConnection(id: string): void;
  switchConnection(id: string): void;
  deleteConnection(id: string): void;
  fill(kind: 'email' | 'code', value: string): void;
  copy(value: string): void;
  openLink(url: string): void;
  continuePolling(): void;
  finish(): void;
  reportOnly(): void;
  endUse(): void;
  askReplace(): void;
  confirmReplace(): void;
  cancelReplace(): void;
  saveService(service: string): void;
  selectProvider(provider: string | null): void;
  toggleBody(): void;
  setDrawer(drawer: 'closed' | 'main' | 'settings'): void;
  setTheme(theme: ThemePreference): void;
  fold(): void;
  unfold(): void;
  hideForVisit(): void;
  hideSite(): void;
  movePanel(position: Position): void;
  moveTab(position: Position): void;
  recordShortcut(): void;
  resetSeen(): void;
}

export interface PanelHandle {
  host: HTMLDivElement;
  render(view: PanelView): void;
  /** Short confirmation under the capsule, e.g. "已复制". */
  flash(message: string): void;
  /** Ring the page element we just wrote into. */
  highlight(target: Element): void;
  reclamp(): void;
  destroy(): void;
}

const MARKUP = `
<section class="shell" aria-label="Mail Hub 邮箱助手" hidden>
  <div class="capsule" data-tone="idle">
    <span class="mark" aria-hidden="true">M</span>
    <div class="face">
      <span class="status"><i class="dot" aria-hidden="true"></i><span data-ref="status"></span><span class="tick" data-ref="tick"></span></span>
      <span class="value-slot"><button class="value" type="button" data-ref="value" title="点击复制"></button></span>
    </div>
    <button class="icon" type="button" data-action="capsule-link" aria-label="打开验证链接" title="打开验证链接" hidden>${icon('external')}</button>
    <button class="cta" type="button" data-action="primary"></button>
    <button class="icon" type="button" data-action="drawer" aria-expanded="false" aria-label="展开详情">${icon('chevron')}</button>
    <button class="icon" type="button" data-action="fold" aria-label="收起到边缘" title="收起到边缘">${icon('close')}</button>
  </div>

  <div class="drawer" data-open="false" inert>
    <div class="drawer-clip"><div class="drawer-body">

      <div class="pane" data-pane="connect" hidden>
        <p class="lead" data-ref="connect-lead">连接你自己的 Mail Hub。密钥只存在脚本管理器里，不会写进当前网页。</p>
        <label class="field"><span>名称（可选）</span><input data-ref="label" type="text" autocomplete="off" spellcheck="false" placeholder="比如 家里、VPS"></label>
        <label class="field"><span>服务地址</span><input data-ref="base" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="mail.example.com"></label>
        <label class="field"><span>API Key</span><input data-ref="key" type="password" autocomplete="off" spellcheck="false" placeholder="mk_..."></label>
        <p class="note warn" data-ref="insecure" hidden>这是 HTTP 连接，密钥会明文经过网络，只建议本机使用。</p>
        <p class="note error" data-ref="connect-error" role="alert" hidden></p>
        <div class="row end">
          <button class="btn" type="button" data-action="cancel-connect" data-ref="cancel-connect">取消</button>
          <button class="btn primary" type="button" data-action="connect" data-ref="connect-submit">连接</button>
        </div>
      </div>

      <div class="pane" data-pane="main" hidden>
        <p class="note banner" data-ref="notice" role="alert" hidden></p>
        <div class="line meta" data-ref="site-line">
          <span class="key">服务</span>
          <span class="val" data-ref="service"></span>
          <button class="icon sm" type="button" data-action="edit-service" aria-label="修改服务标识" title="修改服务标识">${icon('pencil', 14)}</button>
        </div>
        <div class="line edit meta" data-ref="service-edit" hidden>
          <input data-ref="service-input" type="text" aria-label="服务标识" autocomplete="off" spellcheck="false">
          <button class="btn" type="button" data-action="save-service">保存</button>
        </div>
        <p class="note meta" data-ref="foreign" hidden></p>

        <div class="line meta">
          <span class="key">提供商</span>
          <span class="val" data-ref="provider-text"></span>
          <select data-ref="provider" aria-label="邮箱提供商"></select>
        </div>

        <div class="block addr" data-ref="address-block">
          <div class="line">
            <span class="key">邮箱</span>
            <span class="val mono" data-ref="address"></span>
            <button class="btn sm" type="button" data-action="copy-address" data-ref="copy-inline">${icon('copy', 14)}复制</button>
          </div>
          <div class="row" data-ref="address-actions">
            <button class="btn" type="button" data-action="fill-address">填入</button>
            <button class="btn" type="button" data-action="copy-address">${icon('copy', 14)}复制</button>
            <button class="link" type="button" data-action="replace">换一个</button>
          </div>
          <div class="confirm" data-ref="replace-confirm" hidden>
            <p>当前邮箱会被关闭，不上报结果。</p>
            <div class="row end">
              <button class="btn" type="button" data-action="cancel-replace">取消</button>
              <button class="btn danger" type="button" data-action="confirm-replace">结束并换邮箱</button>
            </div>
          </div>
        </div>

        <div class="block res" data-ref="result-block">
          <div class="line head">
            <span class="key" data-ref="result-title">邮件</span>
            <span class="time" data-ref="result-time"></span>
          </div>
          <p class="subject" data-ref="subject"></p>
          <p class="from" data-ref="from"></p>
          <ul class="codes" data-ref="codes"></ul>
          <div class="linkrow" data-ref="link-row">
            <span class="val" data-ref="link-domain"></span>
            <button class="btn" type="button" data-action="open-link">${icon('external', 14)}打开</button>
            <button class="btn" type="button" data-action="copy-link">${icon('copy', 14)}复制</button>
          </div>
          <div class="row">
            <button class="link" type="button" data-action="toggle-body" data-ref="body-toggle">查看邮件</button>
            <button class="link" type="button" data-action="continue" data-ref="continue">${icon('refresh', 14)}继续收取</button>
          </div>
          <pre class="body" data-ref="body" hidden></pre>
        </div>

        <div class="block finish" data-ref="finish">
          <div class="row">
            <button class="btn primary grow" type="button" data-action="finish" data-ref="finish-btn">注册成功并结束</button>
            <button class="btn" type="button" data-action="end" data-ref="end-btn">结束使用</button>
          </div>
          <button class="link" type="button" data-action="report-only" data-ref="report-only">只上报成功，邮箱继续收件</button>
        </div>

        <div class="foot">
          <span class="conn-now" data-ref="conn-now"></span>
          <span class="key" data-ref="conn-key" hidden>连接</span>
          <select class="conn-pick" data-ref="conn-pick" aria-label="切换连接" hidden></select>
          <button class="icon sm" type="button" data-action="settings" aria-label="设置" title="设置">${icon('settings', 15)}</button>
        </div>
      </div>

      <div class="pane" data-pane="settings" hidden>
        <div class="line head">
          <button class="icon sm" type="button" data-action="back" aria-label="返回">${icon('back', 15)}</button>
          <span class="title">设置</span>
        </div>
        <div class="line">
          <span class="key">外观</span>
          <div class="seg" role="radiogroup" aria-label="外观">
            <button type="button" role="radio" data-theme-choice="system">跟随系统</button>
            <button type="button" role="radio" data-theme-choice="light">亮色</button>
            <button type="button" role="radio" data-theme-choice="dark">暗色</button>
          </div>
        </div>
        <div class="line">
          <span class="key">唤出</span>
          <span class="val mono" data-ref="shortcut"></span>
          <button class="btn" type="button" data-action="record-shortcut">修改</button>
        </div>
        <div class="conns">
          <div class="line head"><span class="key">连接</span><button class="link" type="button" data-action="add-connection">＋ 添加连接</button></div>
          <ul class="conn-list" data-ref="conn-list"></ul>
        </div>
        <div class="stack">
          <button class="link" type="button" data-action="reset-seen">重置收件记录</button>
          <button class="link" type="button" data-action="hide-visit">本次不显示（刷新或快捷键可唤回）</button>
          <button class="link" type="button" data-action="hide-site">不再在这个网站显示</button>
        </div>
      </div>

    </div></div>
  </div>
  <p class="sr" role="status" aria-live="polite" data-ref="announce"></p>
</section>

<button class="tab" type="button" data-action="unfold" aria-label="打开 Mail Hub 邮箱助手" hidden><span class="mark" aria-hidden="true">M</span></button>
<div class="ring" aria-hidden="true" hidden></div>
`;

const SPRING = 'linear(0, 0.07, 0.208, 0.362, 0.501, 0.618, 0.715, 0.788, 0.846, 0.887, 0.918, 0.942, 0.958, 0.97, 0.979, 0.985, 0.989, 0.992, 0.995, 0.996, 1)';
const SPRING_MS = 374;
/** Shell width (panel.css), narrowed on small windows by placeShell. */
const SHELL_MAX = 388;
/** Capsule and edge tab heights; the tab hangs centred on where the capsule was. */
const CAPSULE_H = 60;
const TAB_H = 44;
/** Capsule sliding into / out of the screen edge, and the tab's own slide. */
const SLIDE_MS = 340;
const TAB_SLIDE_MS = 220;
/** Smaller sizes (and tracking) tried in order until the capsule value fits. */
const VALUE_STEPS: Record<string, Array<[number, string | null]>> = {
  code: [[22, '.1em'], [20, '.08em'], [18, '.05em'], [16, '.03em'], [15, '0']],
  address: [[12, null]],
  domain: [[15, null], [14, null], [13, null]],
  text: [[14, null], [13, null]],
};
/** The value roll: both cards move together on the snappy spring. */
const ROLL_MS = 374;
/**
 * Pixels of the edge tab (its inner padding) that sit past the window edge.
 * Must exceed the hover slide-out (10px in panel.css), or the tab comes loose
 * from the edge when it peeks out.
 */
const TAB_TUCK = 16;

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Run one animation and resolve when it is done — or when it should have been.
 * Nothing that hides an element may wait on `finished` alone: a frozen clock or
 * a disabled-animation environment would leave it stuck half way.
 */
function play(element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
  const duration = Number(options.duration ?? 0);
  if (reducedMotion() || duration === 0 || typeof element.animate !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      element.animate(keyframes, { fill: 'none', ...options }).finished.then(finish, finish);
    } catch {
      finish();
    }
    setTimeout(finish, duration + 120);
  });
}

/** kestrel.74e99xyz@outlook.com -> kestrel.74…@outlook.com: keep the domain. */
function shortenAddress(address: string, budget = 20): string {
  if (address.length <= budget) return address;
  const at = address.lastIndexOf('@');
  if (at <= 0) return `${address.slice(0, budget - 1)}…`;
  const domain = address.slice(at);
  const keep = Math.max(4, budget - domain.length - 1);
  return `${address.slice(0, keep)}…${domain}`;
}

function relative(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function expiresIn(expiresAt: string | null): string {
  if (!expiresAt) return '';
  const left = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(left)) return '';
  if (left <= 0) return '已过期';
  const hours = Math.floor(left / 3_600_000);
  return hours >= 1 ? `${hours} 小时后过期` : `${Math.max(1, Math.round(left / 60_000))} 分钟后过期`;
}

function providerLabel(provider: ProviderSummary): string {
  const suffix = !provider.enabled ? '（已停用）'
    : !provider.features.pollInbox ? '（不支持收件）'
      : !provider.rateStatus.available ? `（${provider.rateStatus.cooldownReason ?? '限流中'}）`
        : '';
  return `${provider.displayName}${suffix}`;
}

function providerSelectable(provider: ProviderSummary): boolean {
  return provider.enabled && provider.features.pollInbox && provider.rateStatus.available;
}

export function createPanel(callbacks: PanelCallbacks): PanelHandle {
  const host = document.createElement('div');
  host.setAttribute('data-mailhub-assistant', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  shadow.appendChild(style);
  const template = document.createElement('template');
  template.innerHTML = MARKUP.trim();
  shadow.appendChild(template.content.cloneNode(true));

  const $ = <T extends Element = HTMLElement>(selector: string): T => {
    const node = shadow.querySelector(selector);
    if (!node) throw new Error(`panel node missing: ${selector}`);
    return node as T;
  };
  const ref = <T extends Element = HTMLElement>(name: string) => $<T>(`[data-ref="${name}"]`);

  const shell = $('.shell');
  const capsuleNode = $('.capsule');
  const valueSlot = $('.value-slot');
  const cta = $<HTMLButtonElement>('[data-action="primary"]');
  const drawerToggle = $<HTMLButtonElement>('[data-action="drawer"]');
  const drawer = $('.drawer');
  const tab = $<HTMLButtonElement>('.tab');
  const ring = $('.ring');
  const panes = {
    connect: $('[data-pane="connect"]'),
    main: $('[data-pane="main"]'),
    settings: $('[data-pane="settings"]'),
  };
  const baseInput = ref<HTMLInputElement>('base');
  const keyInput = ref<HTMLInputElement>('key');
  const serviceInput = ref<HTMLInputElement>('service-input');
  const providerSelect = ref<HTMLSelectElement>('provider');
  const labelInput = ref<HTMLInputElement>('label');
  const connPick = ref<HTMLSelectElement>('conn-pick');
  /** Delete needs a second click within a few seconds. */
  let armedDelete: { id: string; at: number } | null = null;

  let view: PanelView | null = null;
  let shownValue = '';
  /** The full value behind a shortened display (copy uses this). */
  let fullValue = '';
  let flashText: string | null = null;
  let flipToken = 0;
  let lastProviderSignature = '';
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let presence: Presence = 'hidden';
  let presenceToken = 0;
  /** While capsule ⇄ tab is animating, nothing may move the host. */
  let transitioning = false;
  let everShown = false;
  /** Latest positions this panel set or the user dragged to. */
  let panelPos: Position | null = null;
  let tabPos: Position | null = null;
  /** A primary that just changed meaning ignores clicks for a moment. */
  let ctaArmedAt = 0;
  let lastCtaAction: CapsuleAction | null = null;

  // ------------------------------------------------------------- position

  function viewportSize() {
    const root = document.documentElement;
    return { width: root?.clientWidth || window.innerWidth, height: root?.clientHeight || window.innerHeight };
  }

  function placeShell(position: Position | null): void {
    const viewport = viewportSize();
    // CSS 100vw counts the page scrollbar; size against the area actually visible.
    shell.style.width = viewport.width < SHELL_MAX + 16 ? `${viewport.width - 16}px` : '';
    const rect = shell.getBoundingClientRect();
    const size = { width: rect.width || SHELL_MAX, height: rect.height || 64 };
    // Stored positions come from other window sizes; they are always re-bounded
    // here, but only a drag writes them back.
    const wanted = position ?? { x: viewport.width - size.width - 16, y: 16 };
    const next = clampPosition(wanted, size, viewport);
    host.style.left = `${next.x}px`;
    host.style.top = `${next.y}px`;
    delete host.dataset.dock;
  }

  /**
   * The tab hangs on an edge with only its inner padding tucked past it, so the
   * whole mark stays visible — the old half-hidden tab was too easy to lose.
   */
  function tabPlacement(position: Position | null): { position: Position; side: 'left' | 'right' } {
    const size = { width: tab.offsetWidth || 36, height: tab.offsetHeight || 44 };
    const viewport = viewportSize();
    const wanted = position ?? { x: viewport.width, y: 96 };
    const docked = dockPosition(wanted, size, viewport);
    const x = docked.side === 'right' ? viewport.width - size.width + TAB_TUCK : -TAB_TUCK;
    return { position: { x, y: docked.position.y }, side: docked.side };
  }

  function placeTab(position: Position | null): void {
    const placed = tabPlacement(position);
    host.style.left = `${placed.position.x}px`;
    host.style.top = `${placed.position.y}px`;
    host.dataset.dock = placed.side;
  }

  function place(): void {
    // Moving the host mid-animation is what made the capsule look flung across
    // the screen: it jumped to the tab's spot and faded out there.
    if (!view || transitioning) return;
    if (presence === 'capsule') {
      placeShell(panelPos ?? view.position);
      fitValue(ref<HTMLElement>('value'));
    }
    else if (presence === 'tab') placeTab(tabPos ?? view.tabPosition);
  }

  function enableDrag(handle: HTMLElement, kind: 'shell' | 'tab'): void {
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const start = event.target as Element | null;
      if (kind === 'shell' && start?.closest?.('button, input, select, a')) return;
      const rect = host.getBoundingClientRect();
      const box = kind === 'shell' ? shell.getBoundingClientRect() : tab.getBoundingClientRect();
      const origin = { x: rect.left, y: rect.top };
      const pointer = { x: event.clientX, y: event.clientY };
      let position = origin;
      let moved = false;

      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - pointer.x;
        const dy = moveEvent.clientY - pointer.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        handle.classList.add('dragging');
        position = clampPosition({ x: origin.x + dx, y: origin.y + dy }, { width: box.width, height: box.height }, viewportSize());
        host.style.left = `${position.x}px`;
        host.style.top = `${position.y}px`;
        delete host.dataset.dock;
      };
      const finish = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.classList.remove('dragging');
        if (!moved) return;
        // Swallow the click that ends a drag.
        handle.addEventListener('click', (click) => { click.stopPropagation(); click.preventDefault(); }, { capture: true, once: true });
        if (kind === 'shell') {
          const snapped = snapToEdge(position, { width: box.width, height: box.height }, viewportSize());
          host.style.left = `${snapped.x}px`;
          panelPos = snapped;
          callbacks.movePanel(snapped);
        } else {
          const placed = tabPlacement(position);
          tabPos = placed.position;
          callbacks.moveTab(placed.position);
          placeTab(placed.position);
        }
      };
      try { handle.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });
  }

  // ------------------------------------------------------------- presence

  /**
   * capsule ⇄ tab is one motion played in both directions: the capsule slides
   * toward its edge and fades while the tab slides in, and the reverse on the
   * way back. Each side is hidden only after its exit has finished.
   */
  /**
   * Capsule and edge tab are one object in two states. Folding slides the whole
   * capsule (drawer included) straight into the nearer screen edge, then the
   * tab comes out of that edge at the same height; unfolding is the same
   * motion played backwards. Nothing fades or flies across the page.
   */
  async function setPresence(next: Presence): Promise<void> {
    if (next === presence) return;
    const token = ++presenceToken;
    const previous = presence;
    presence = next;
    // The first appearance on page load is not an action; it just shows.
    const animate = everShown || previous !== 'hidden';
    transitioning = true;
    const viewportWidth = viewportSize().width;
    const slide = (dx: number): Keyframe[] => [{ transform: `translateX(${dx}px)` }, { transform: 'none' }];
    const edgeOf = (rect: DOMRect): 'left' | 'right' => (rect.left + rect.width / 2 < viewportWidth / 2 ? 'left' : 'right');
    const offEdge = (rect: DOMRect) => (edgeOf(rect) === 'right' ? viewportWidth - rect.left + 12 : -(rect.right + 12));

    try {
      if (previous === 'capsule') {
        const rect = shell.getBoundingClientRect();
        if (next === 'tab') {
          tabPos = { x: edgeOf(rect) === 'right' ? viewportWidth : 0, y: Math.round(rect.top + (CAPSULE_H - TAB_H) / 2) };
          callbacks.moveTab(tabPos);
        }
        await play(shell, slide(offEdge(rect)), { duration: SLIDE_MS, easing: SPRING, direction: 'reverse' });
      } else if (previous === 'tab') {
        const rect = tab.getBoundingClientRect();
        if (next === 'capsule') {
          const x = (panelPos ?? view?.position)?.x ?? viewportWidth - (shell.offsetWidth || 388) - 16;
          panelPos = { x, y: Math.round(rect.top - (CAPSULE_H - TAB_H) / 2) };
          callbacks.movePanel(panelPos);
        }
        // Opening goes straight out: the tab just gives way to the capsule
        // (a retract first reads as a hesitation). Only other exits tuck it back.
        if (next !== 'capsule') {
          const dx = host.dataset.dock === 'left' ? -rect.width : rect.width;
          await play(tab, slide(dx), { duration: TAB_SLIDE_MS, easing: SPRING, direction: 'reverse' });
        }
      }
      if (token !== presenceToken) return;

      shell.hidden = next !== 'capsule';
      tab.hidden = next !== 'tab';
      host.hidden = next === 'hidden';
      // Collapsed while hidden, so it never animates on its own during the slide.
      if (next !== 'capsule') setDrawerOpen(false);
      transitioning = false;
      place();
      if (next !== 'hidden') everShown = true;
      if (!animate) return;

      if (next === 'capsule') {
        await play(shell, slide(offEdge(shell.getBoundingClientRect())), { duration: SLIDE_MS, easing: SPRING });
      } else if (next === 'tab') {
        const width = tab.getBoundingClientRect().width;
        await play(tab, slide(host.dataset.dock === 'left' ? -width : width), { duration: TAB_SLIDE_MS, easing: SPRING });
      }
    } finally {
      if (token === presenceToken) {
        transitioning = false;
        // A resize that landed mid-transition was skipped by place(); catch up.
        place();
      }
    }
  }

  // ------------------------------------------------------------- drawer

  /** Height is a CSS grid-row transition, so closing is the opening reversed. */
  function setDrawerOpen(open: boolean): void {
    if ((drawer.dataset.open === 'true') === open) return;
    drawer.dataset.open = String(open);
    drawerToggle.setAttribute('aria-expanded', String(open));
    drawerToggle.setAttribute('aria-label', open ? '收起详情' : '展开详情');
    if (open) drawer.removeAttribute('inert');
    else drawer.setAttribute('inert', '');
    // The panel grows downward; keep its bottom inside the window.
    requestAnimationFrame(() => { if (presence === 'capsule') place(); });
    setTimeout(() => { if (presence === 'capsule') place(); }, SPRING_MS + 40);
  }

  // ------------------------------------------------------------- capsule value

  /**
   * Shrink the capsule value until it fits. A code is never cut: it steps down
   * to a floor size with tighter tracking. Other kinds shrink a little and only
   * then fall back to the ellipsis.
   */
  function fitValue(element: HTMLElement): void {
    element.style.fontSize = '';
    element.style.letterSpacing = '';
    if (!element.clientWidth) return; // not laid out (tucked away); refit on show
    const steps = VALUE_STEPS[element.dataset.kind ?? ''] ?? [];
    for (const [size, tracking] of steps) {
      if (element.scrollWidth <= element.clientWidth) return;
      element.style.fontSize = `${size}px`;
      if (tracking !== null) element.style.letterSpacing = tracking;
    }
  }

  /**
   * A flat roll, like a station board or a drum counter: the old value is
   * pushed straight up out of the slot while the new one rises in right below
   * it. They move together and never overlap — no fades, no 3D turn.
   */
  function setValue(full: string, kind: string): void {
    const current = ref<HTMLButtonElement>('value');
    // The outgoing card keeps its own face; set the new kind after cloning it.
    const previousKind = current.dataset.kind;
    current.dataset.kind = kind;
    fullValue = full;
    // A closed inbox's address is shown muted but still needs its domain.
    const text = kind === 'address' || (kind === 'muted' && full.includes('@')) ? shortenAddress(full) : full;
    current.setAttribute('aria-label', full);
    if (text === shownValue) return;
    const hadValue = shownValue !== '';
    shownValue = text;
    if (!hadValue || reducedMotion()) {
      flipToken += 1;
      for (const stale of Array.from(valueSlot.querySelectorAll('.leaving'))) stale.remove();
      valueSlot.classList.remove('rolling');
      current.textContent = text;
      current.title = kind === 'code' || kind === 'address' ? '点击复制' : '';
      fitValue(current);
      return;
    }
    // A swap that lands mid-flip replaces the one in progress.
    const token = ++flipToken;
    for (const stale of Array.from(valueSlot.querySelectorAll('.leaving'))) stale.remove();
    const leaving = current.cloneNode(true) as HTMLElement;
    if (previousKind) leaving.dataset.kind = previousKind;
    leaving.removeAttribute('data-ref');
    leaving.classList.add('leaving');
    leaving.setAttribute('aria-hidden', 'true');
    leaving.tabIndex = -1;
    valueSlot.appendChild(leaving);
    current.textContent = text;
    current.title = kind === 'code' || kind === 'address' ? '点击复制' : '';
    fitValue(current);
    // Clip only while rolling, so the focus ring is not cut off at rest.
    valueSlot.classList.add('rolling');
    const options: KeyframeAnimationOptions = { duration: ROLL_MS, easing: SPRING };
    void Promise.all([
      play(leaving, [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], options),
      play(current, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], options),
    ]).then(() => {
      leaving.remove();
      if (token === flipToken) valueSlot.classList.remove('rolling');
    });
  }

  // ------------------------------------------------------------- render

  function renderProviders(next: PanelView): void {
    const signature = next.providers.map((provider) => `${provider.name}:${providerSelectable(provider)}`).join('|');
    if (signature !== lastProviderSignature) {
      lastProviderSignature = signature;
      providerSelect.replaceChildren();
      const auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = '自动分配 · 按服务顺序';
      providerSelect.appendChild(auto);
      for (const provider of next.providers) {
        const option = document.createElement('option');
        option.value = provider.name;
        option.textContent = providerLabel(provider);
        option.disabled = !providerSelectable(provider);
        providerSelect.appendChild(option);
      }
    }
    providerSelect.value = next.provider ?? 'auto';
    const editable = next.plan.providerEditable;
    providerSelect.hidden = !editable;
    const text = ref('provider-text');
    text.hidden = editable;
    if (!editable) {
      const name = next.providers.find((provider) => provider.name === next.inboxProvider)?.displayName ?? next.inboxProvider ?? '—';
      const expiry = expiresIn(next.expiresAt);
      text.textContent = expiry ? `${name} · ${expiry}` : name;
    }
  }

  function renderResult(next: PanelView): void {
    const block = ref('result-block');
    const result = next.result;
    block.hidden = !result;
    if (!result) return;
    ref('result-title').textContent = next.resultIsPrevious ? '上一封邮件' : '邮件';
    ref('result-time').dataset.at = result.receivedAt ?? '';
    ref('subject').textContent = result.subject ?? '（无标题）';
    ref('from').textContent = result.from ?? '';

    const codes = ref<HTMLUListElement>('codes');
    codes.replaceChildren();
    const live = next.plan.addressFill;
    for (const candidate of result.candidates) {
      const item = document.createElement('li');
      const value = document.createElement('span');
      value.className = 'code';
      value.textContent = candidate.value;
      item.appendChild(value);
      if (candidate.context && result.candidates.length > 1) {
        const context = document.createElement('span');
        context.className = 'context';
        context.textContent = candidate.context;
        item.appendChild(context);
      }
      const actions = document.createElement('span');
      actions.className = 'acts';
      if (live) {
        const fill = document.createElement('button');
        fill.type = 'button';
        fill.className = 'btn';
        fill.textContent = '填入';
        fill.addEventListener('click', () => callbacks.fill('code', candidate.value));
        actions.appendChild(fill);
      }
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn';
      copy.innerHTML = `${icon('copy', 14)}复制`;
      copy.addEventListener('click', () => callbacks.copy(candidate.value));
      actions.appendChild(copy);
      item.appendChild(actions);
      codes.appendChild(item);
    }
    codes.hidden = result.candidates.length === 0;

    const linkRow = ref('link-row');
    linkRow.hidden = !result.link;
    if (result.link) {
      ref('link-domain').textContent = result.link.domain;
      ref('link-domain').title = result.link.url;
    }

    const bodyToggle = ref<HTMLButtonElement>('body-toggle');
    // The body is fetched on demand; the toggle exists whenever a message does.
    bodyToggle.hidden = !result.messageId;
    bodyToggle.textContent = next.bodyVisible ? '收起邮件' : '查看邮件';
    const body = ref<HTMLPreElement>('body');
    body.hidden = !next.bodyVisible;
    body.textContent = next.bodyVisible ? (result.bodyText ?? '正在读取…') : '';
    ref('continue').hidden = !next.plan.canContinue;
  }

  function renderMain(next: PanelView): void {
    // While a run is live, what just arrived leads and the meta rows sink.
    panes.main.dataset.live = String(next.plan.addressFill);
    const notice = ref('notice');
    notice.hidden = !next.noticeDetail;
    notice.textContent = next.noticeDetail ?? '';
    notice.dataset.tone = next.noticeTone ?? '';
    ref('service').textContent = next.service ?? '认不出，需要填写';
    ref('service').classList.toggle('missing', !next.service);
    const foreign = ref('foreign');
    foreign.hidden = !next.foreignService;
    foreign.textContent = next.foreignService ? `这个邮箱属于 ${next.foreignService}，上报也算在它名下。` : '';
    if (ref('service-edit').hidden) serviceInput.value = next.service ?? '';
    // An existing inbox's service is frozen; editing only makes sense before one exists.
    $<HTMLButtonElement>('[data-action="edit-service"]').hidden = !next.plan.providerEditable;
    if (!next.service && next.plan.providerEditable) ref('service-edit').hidden = false;

    renderProviders(next);

    ref('address-block').hidden = !next.plan.showAddress || !next.address;
    ref('address').textContent = next.address ?? '';
    ref('address').classList.toggle('muted', !next.plan.addressFill);
    // A closed inbox can only be copied: that one button sits on the address
    // line instead of taking a row of its own.
    ref('address-actions').hidden = !next.plan.addressFill;
    ref('copy-inline').hidden = next.plan.addressFill;
    $<HTMLButtonElement>('[data-action="replace"]').hidden = !next.plan.canReplace || next.confirmReplace;
    ref('replace-confirm').hidden = !next.confirmReplace;

    renderResult(next);

    const finish = ref('finish');
    finish.hidden = next.plan.finish === 'none';
    ref<HTMLButtonElement>('finish-btn').hidden = next.plan.finish !== 'full';
    ref<HTMLButtonElement>('report-only').hidden = next.plan.finish !== 'full';
    ref<HTMLButtonElement>('end-btn').classList.toggle('primary', next.plan.finish === 'end-only');
    ref<HTMLButtonElement>('end-btn').classList.toggle('grow', next.plan.finish === 'end-only');
    // One connection: just say which. Several: switch right here.
    const many = next.connections.length > 1;
    ref('conn-now').hidden = many;
    ref('conn-now').textContent = next.connectionLabel ? `连接：${next.connectionLabel}` : '';
    connPick.hidden = !many;
    ref('conn-key').hidden = !many;
    if (many) {
      const signature = next.connections.map((entry) => `${entry.id}:${entry.title}`).join('|');
      if (connPick.dataset.signature !== signature) {
        connPick.dataset.signature = signature;
        connPick.replaceChildren(...next.connections.map((entry) => {
          const option = document.createElement('option');
          option.value = entry.id;
          option.textContent = entry.title === entry.host ? entry.title : `${entry.title} · ${entry.host}`;
          return option;
        }));
      }
      connPick.value = next.connections.find((entry) => entry.active)?.id ?? '';
    }
  }

  function renderSettings(next: PanelView): void {
    for (const button of Array.from(shadow.querySelectorAll<HTMLButtonElement>('[data-theme-choice]'))) {
      button.setAttribute('aria-checked', String(button.dataset.themeChoice === next.theme));
    }
    ref('shortcut').textContent = next.shortcut;
    const list = ref<HTMLUListElement>('conn-list');
    list.replaceChildren(...next.connections.map((entry) => {
      const item = document.createElement('li');
      item.classList.toggle('active', entry.active);
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'conn-pick-row';
      pick.setAttribute('aria-pressed', String(entry.active));
      pick.title = entry.active ? '当前连接' : '切换到这套连接';
      const name = document.createElement('span');
      name.className = 'conn-name';
      name.textContent = entry.title;
      const host = document.createElement('span');
      host.className = 'conn-host';
      host.textContent = entry.title === entry.host ? (entry.active ? '当前' : '') : entry.host;
      pick.append(name, host);
      pick.addEventListener('click', () => callbacks.switchConnection(entry.id));
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'icon sm';
      editButton.setAttribute('aria-label', `编辑 ${entry.title}`);
      editButton.title = '编辑';
      editButton.innerHTML = icon('pencil', 14);
      editButton.addEventListener('click', () => callbacks.editConnection(entry.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      const armed = armedDelete?.id === entry.id && Date.now() - armedDelete.at < 4000;
      remove.className = armed ? 'btn danger sm' : 'icon sm';
      remove.setAttribute('aria-label', armed ? `确认删除 ${entry.title}` : `删除 ${entry.title}`);
      remove.title = armed ? '再点一次删除' : '删除';
      if (armed) remove.textContent = '确认删除';
      else remove.innerHTML = icon('trash', 14);
      remove.addEventListener('click', () => {
        if (armedDelete?.id === entry.id && Date.now() - armedDelete.at < 4000) {
          armedDelete = null;
          callbacks.deleteConnection(entry.id);
          return;
        }
        armedDelete = { id: entry.id, at: Date.now() };
        renderSettings(next);
        setTimeout(() => { if (armedDelete?.id === entry.id && view) { armedDelete = null; renderSettings(view); } }, 4100);
      });
      item.append(pick, editButton, remove);
      return item;
    }));
  }

  function renderConnect(next: PanelView): void {
    const form = next.connect;
    if (!form) return;
    // Never overwrite what the user is typing.
    if (shadow.activeElement !== labelInput) labelInput.value = form.label;
    if (shadow.activeElement !== baseInput) baseInput.value = form.baseUrl;
    ref('connect-lead').textContent = form.editingId
      ? '编辑这套连接。地址和 Key 一起保存，切换时一起生效。'
      : next.connections.length
        ? '添加一套连接。地址和 Key 一起保存，之后在抽屉底部就能切换。'
        : '连接你自己的 Mail Hub。密钥只存在脚本管理器里，不会写进当前网页。';
    ref('connect-submit').textContent = form.editingId ? '保存' : next.connections.length ? '添加并切换' : '连接';
    if (shadow.activeElement !== keyInput) keyInput.value = form.apiKey;
    ref('insecure').hidden = !form.insecure;
    const error = ref('connect-error');
    error.hidden = !form.error;
    error.textContent = form.error ?? '';
    const submit = $<HTMLButtonElement>('[data-action="connect"]');
    submit.disabled = form.busy;
    submit.toggleAttribute('data-loading', form.busy);
    ref('cancel-connect').hidden = next.connections.length === 0;
  }

  function renderCapsule(next: PanelView): void {
    const capsule = next.capsule;
    capsuleNode.dataset.tone = capsule.tone;
    if (next.mode === 'connect') {
      ref('status').textContent = '还没连接';
      setValue('连接你的 Mail Hub', 'muted');
      cta.hidden = true;
      return;
    }
    ref('status').textContent = flashText ?? capsule.status;
    capsuleNode.toggleAttribute('data-flash', flashText !== null);
    ref('tick').dataset.since = !flashText && capsule.ticking && next.waitingSince ? String(next.waitingSince) : '';
    setValue(capsule.value.text, capsule.value.kind);
    const linkButton = $<HTMLButtonElement>('[data-action="capsule-link"]');
    linkButton.hidden = !capsule.link;
    linkButton.title = capsule.link ? `打开验证链接：${capsule.link.domain}` : '';
    const primary = capsule.primary;
    cta.hidden = !primary;
    if (!primary) return;
    if (primary.action !== lastCtaAction) {
      // The button under the cursor just changed meaning (填入 → 结束). A second
      // click meant for the old action must not trigger the new one.
      if (lastCtaAction !== null) ctaArmedAt = Date.now() + 700;
      lastCtaAction = primary.action;
    }
    cta.textContent = primary.label;
    cta.dataset.action = 'primary';
    cta.dataset.intent = primary.action;
    cta.classList.toggle('quiet', primary.quiet);
    cta.toggleAttribute('data-loading', primary.busy);
    cta.disabled = primary.busy;
  }

  function render(next: PanelView): void {
    view = next;
    host.dataset.theme = next.theme;
    host.style.colorScheme = next.theme === 'system' ? 'light dark' : next.theme;
    tab.classList.toggle('unseen', next.unseen);

    renderCapsule(next);
    const pane = next.mode === 'connect' ? 'connect' : next.drawer === 'settings' ? 'settings' : 'main';
    panes.connect.hidden = pane !== 'connect';
    panes.main.hidden = pane !== 'main';
    panes.settings.hidden = pane !== 'settings';
    if (pane === 'connect') renderConnect(next);
    if (pane === 'main') renderMain(next);
    if (pane === 'settings') renderSettings(next);
    // Leaving the capsule: the drawer rides along and is closed once hidden.
    const leavingCapsule = presence === 'capsule' && next.presence !== 'capsule';
    if (!leavingCapsule) setDrawerOpen(next.mode === 'connect' || next.drawer !== 'closed');

    void setPresence(next.presence);
    if (next.presence !== 'hidden') place();
    tick();
  }

  // ------------------------------------------------------------- ticking text

  function tick(): void {
    const now = Date.now();
    const tickNode = ref('tick');
    const since = Number(tickNode.dataset.since || 0);
    tickNode.textContent = since ? ` · ${elapsed(now - since)}` : '';
    const timeNode = ref('result-time');
    const at = Date.parse(timeNode.dataset.at || '');
    timeNode.textContent = Number.isFinite(at) ? relative(now - at) : '';
  }
  const ticker = setInterval(() => { if (presence === 'capsule') tick(); }, 1000);

  // ------------------------------------------------------------- feedback

  /**
   * Feedback takes the status line for a moment instead of floating over the
   * page or the drawer, where it covered the very rows it was about.
   */
  function flash(message: string): void {
    flashText = message;
    ref('announce').textContent = message;
    if (view) { renderCapsule(view); tick(); }
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = null;
      if (view) { renderCapsule(view); tick(); }
    }, 2200);
  }

  /** A ring over the field we filled: in, hold, then the same curve reversed. */
  function highlight(target: Element): void {
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    ring.style.left = `${rect.left - 4}px`;
    ring.style.top = `${rect.top - 4}px`;
    ring.style.width = `${rect.width + 8}px`;
    ring.style.height = `${rect.height + 8}px`;
    ring.hidden = false;
    const frames: Keyframe[] = [{ opacity: 0, transform: 'scale(1.04)' }, { opacity: 1, transform: 'none' }];
    void (async () => {
      await play(ring, frames, { duration: 220, easing: 'cubic-bezier(.23,1,.32,1)' });
      await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 900 : 700));
      await play(ring, frames, { duration: 220, easing: 'cubic-bezier(.23,1,.32,1)', direction: 'reverse' });
      ring.hidden = true;
    })();
  }

  // ------------------------------------------------------------- events

  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const themeChoice = target?.closest?.('[data-theme-choice]') as HTMLElement | null;
    if (themeChoice) { callbacks.setTheme(themeChoice.dataset.themeChoice as ThemePreference); return; }
    if (target?.closest?.('[data-ref="value"]') && view) {
      const kind = view.capsule.value.kind;
      if (kind === 'code' || kind === 'address' || kind === 'muted') callbacks.copy(fullValue);
      return;
    }
    const button = target?.closest?.('button[data-action]') as HTMLButtonElement | null;
    if (!button || !view) return;
    const result = view.result;
    switch (button.dataset.action) {
      case 'primary': {
        const intent = button.dataset.intent as CapsuleAction | undefined;
        if (!intent || Date.now() < ctaArmedAt) return;
        callbacks.primary(intent);
        return;
      }
      case 'drawer': callbacks.setDrawer(view.drawer === 'closed' ? 'main' : 'closed'); return;
      case 'fold': callbacks.fold(); return;
      case 'unfold': callbacks.unfold(); return;
      case 'connect': callbacks.submitConnection({ label: labelInput.value, baseUrl: baseInput.value, apiKey: keyInput.value }); return;
      case 'add-connection': callbacks.addConnection(); return;
      case 'cancel-connect': callbacks.cancelConnection(); return;
      case 'edit-service': {
        const edit = ref('service-edit');
        edit.hidden = !edit.hidden;
        if (!edit.hidden) { serviceInput.value = view.service ?? ''; serviceInput.focus(); serviceInput.select(); }
        return;
      }
      case 'save-service': saveService(); return;
      case 'fill-address': if (view.address) callbacks.fill('email', view.address); return;
      case 'copy-address': if (view.address) callbacks.copy(view.address); return;
      case 'replace': callbacks.askReplace(); return;
      case 'cancel-replace': callbacks.cancelReplace(); return;
      case 'confirm-replace': callbacks.confirmReplace(); return;
      case 'open-link': if (result?.link) callbacks.openLink(result.link.url); return;
      case 'capsule-link': if (view.capsule.link) callbacks.openLink(view.capsule.link.url); return;
      case 'copy-link': if (result?.link) callbacks.copy(result.link.url); return;
      case 'toggle-body': callbacks.toggleBody(); return;
      case 'continue': callbacks.continuePolling(); return;
      case 'finish': callbacks.finish(); return;
      case 'end': callbacks.endUse(); return;
      case 'report-only': callbacks.reportOnly(); return;
      case 'settings': callbacks.setDrawer('settings'); return;
      case 'back': callbacks.setDrawer('main'); return;
      case 'record-shortcut': callbacks.recordShortcut(); return;
      case 'reset-seen': callbacks.resetSeen(); return;
      case 'hide-visit': callbacks.hideForVisit(); return;
      case 'hide-site': callbacks.hideSite(); return;
      default: return;
    }
  };

  function saveService(): void {
    const value = serviceInput.value.trim();
    if (!value) return;
    ref('service-edit').hidden = true;
    callbacks.saveService(value);
  }

  const onChange = (event: Event) => {
    if (event.target === providerSelect) callbacks.selectProvider(providerSelect.value === 'auto' ? null : providerSelect.value);
    if (event.target === connPick) callbacks.switchConnection(connPick.value);
  };

  const onKeyDown = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape' && view && view.drawer !== 'closed' && view.mode !== 'connect') {
      keyboard.stopPropagation();
      callbacks.setDrawer(view.drawer === 'settings' ? 'main' : 'closed');
      cta.focus();
      return;
    }
    if (keyboard.key !== 'Enter') return;
    const target = keyboard.target;
    if (target === baseInput || target === keyInput || target === labelInput) {
      keyboard.preventDefault();
      callbacks.submitConnection({ label: labelInput.value, baseUrl: baseInput.value, apiKey: keyInput.value });
    } else if (target === serviceInput) {
      keyboard.preventDefault();
      saveService();
    }
  };

  shadow.addEventListener('click', onClick);
  shadow.addEventListener('change', onChange);
  shadow.addEventListener('keydown', onKeyDown);
  enableDrag(capsuleNode, 'shell');
  enableDrag(tab, 'tab');

  return {
    host,
    render,
    flash,
    highlight,
    reclamp: place,
    destroy() {
      clearInterval(ticker);
      shadow.removeEventListener('click', onClick);
      shadow.removeEventListener('change', onChange);
      shadow.removeEventListener('keydown', onKeyDown);
      if (flashTimer) clearTimeout(flashTimer);
      host.remove();
    },
  };
}

