/**
 * What the panel shows is derived here, from persisted facts only. Keeping it a
 * pure function means there is exactly one place that decides "which stage are
 * we in" — the old panel kept a second copy of the phase in the UI and the two
 * drifted (a failed create rendered as the previous inbox's closed state with
 * no error, and "换邮箱" was forgotten on the next fold).
 */
import { t } from './i18n.js';
import type { Phase } from './storage.js';

export type Stage =
  | 'empty'
  | 'creating'
  | 'create-unknown'
  | 'waiting'
  | 'result'
  | 'reporting'
  | 'report-unknown'
  | 'reported'
  | 'closing'
  | 'close-failed'
  | 'closed';

export interface StageInput {
  phase: Phase;
  hasInbox: boolean;
  reported: boolean;
  hasResult: boolean;
}

export function stageOf(input: StageInput): Stage {
  const { phase, hasInbox, reported, hasResult } = input;
  if (phase === 'creating') return 'creating';
  if (phase === 'create-unknown') return 'create-unknown';
  if (!hasInbox) return 'empty';
  switch (phase) {
    case 'closing': return 'closing';
    case 'close-failed': return 'close-failed';
    case 'closed': return 'closed';
    case 'reporting': return 'reporting';
    case 'report-unknown': return 'report-unknown';
    default: break;
  }
  if (reported) return 'reported';
  return hasResult ? 'result' : 'waiting';
}

/** True while the inbox can still receive mail and be acted on. */
export function isLive(stage: Stage): boolean {
  return stage === 'waiting' || stage === 'result' || stage === 'reported'
    || stage === 'reporting' || stage === 'report-unknown' || stage === 'close-failed';
}

export interface LinkInfo {
  url: string;
  domain: string;
}

export interface ResultInput {
  /** Non-link candidates, in the order the backend ranked them. */
  candidates: Array<{ value: string }>;
  link: LinkInfo | null;
  subject: string | null;
}

export type ResultShape =
  | { kind: 'code'; value: string; link: LinkInfo | null }
  | { kind: 'link'; link: LinkInfo }
  /** Several codes: the user picks one; we never guess the "best" one. */
  | { kind: 'choose'; count: number }
  /** Mail arrived but nothing usable was extracted from it. */
  | { kind: 'message'; subject: string | null };

export function resultShape(result: ResultInput): ResultShape {
  if (result.candidates.length > 1) return { kind: 'choose', count: result.candidates.length };
  if (result.candidates.length === 1) return { kind: 'code', value: result.candidates[0].value, link: result.link };
  if (result.link) return { kind: 'link', link: result.link };
  return { kind: 'message', subject: result.subject };
}

export type CapsuleAction =
  | 'get'
  | 'fill-address'
  | 'fill-code'
  | 'open-link'
  | 'choose'
  | 'view-message'
  | 'finish'
  | 'end'
  | 'retry-close';

export type Tone = 'idle' | 'wait' | 'ok' | 'warn' | 'error';

export interface CapsuleValue {
  text: string;
  /** Drives the face: code is large mono, address mono, the rest UI text. */
  kind: 'code' | 'address' | 'domain' | 'text' | 'muted';
}

export interface Capsule {
  value: CapsuleValue;
  status: string;
  tone: Tone;
  /** Show the elapsed wait after the status. */
  ticking: boolean;
  primary: { action: CapsuleAction; label: string; busy: boolean; quiet: boolean } | null;
  /** A link that rode along with a code: offered as a small secondary button. */
  link: LinkInfo | null;
  /** The drawer holds something the user has to look at to continue. */
  needsDrawer: boolean;
}

export interface CapsuleInput {
  stage: Stage;
  address: string | null;
  service: string | null;
  result: ResultShape | null;
  /** The address was already filled into the page at least once. */
  addressUsed: boolean;
  /** The code was filled/copied or the link opened. */
  resultUsed: boolean;
  /** An action-level message that overrides the stage status. */
  notice: { text: string; tone: 'warn' | 'error' } | null;
  /** What the next allocation will use: a provider name or 自动分配. */
  providerLabel: string;
}

function action(actionId: CapsuleAction, label: string, extra: { busy?: boolean; quiet?: boolean } = {}) {
  return { action: actionId, label, busy: extra.busy ?? false, quiet: extra.quiet ?? false };
}

function resultFace(result: ResultShape): CapsuleValue {
  switch (result.kind) {
    case 'code': return { text: result.value, kind: 'code' };
    case 'link': return { text: result.link.domain, kind: 'domain' };
    case 'choose': return { text: t('cap.candidates', { n: result.count }), kind: 'text' };
    case 'message': return { text: result.subject || t('cap.noSubject'), kind: 'text' };
  }
}

function base(input: CapsuleInput): Capsule {
  const { stage, address, service, result, addressUsed, resultUsed, providerLabel } = input;
  const addressFace: CapsuleValue = address ? { text: address, kind: 'address' } : { text: t('cap.noInbox'), kind: 'muted' };
  const capsule = (value: CapsuleValue, status: string, tone: Tone, primary: Capsule['primary'], extra: Partial<Capsule> = {}): Capsule => ({
    value, status, tone, primary, ticking: false, needsDrawer: false, link: null, ...extra,
  });

  switch (stage) {
    case 'empty':
      // "Which provider, for which site" is exactly what the get button will do.
      return service
        ? capsule({ text: service, kind: 'domain' }, providerLabel, 'idle', action('get', t('act.get')))
        : capsule({ text: t('cap.unknownSite'), kind: 'muted' }, t('cap.needService'), 'warn', null, { needsDrawer: true });
    case 'creating':
      return capsule(addressFace.kind === 'address' ? { ...addressFace, kind: 'muted' } : addressFace,
        t('cap.getting'), 'wait', action('get', t('act.getting'), { busy: true }));
    case 'create-unknown':
      return capsule(addressFace, t('cap.createUnknown'), 'error', action('get', t('act.retryGet')));
    case 'waiting':
      return capsule(addressFace, t('cap.waiting'), 'wait',
        action('fill-address', addressUsed ? t('act.fillAgain') : t('act.fill'), { quiet: addressUsed }), { ticking: true });
    case 'result': {
      if (!result) return capsule(addressFace, t('cap.waiting'), 'wait', action('fill-address', t('act.fill')), { ticking: true });
      const face = resultFace(result);
      if (result.kind === 'choose') {
        return capsule(face, t('cap.choose'), 'ok', action('choose', t('act.choose')), { needsDrawer: true });
      }
      if (result.kind === 'message') {
        return capsule(face, t('cap.noCode'), 'warn', action('view-message', t('act.viewMessage')));
      }
      if (resultUsed) return capsule(face, result.kind === 'link' ? t('cap.linkOpened') : t('cap.codeFilled'), 'ok', action('finish', t('act.finish')));
      return result.kind === 'code'
        ? capsule(face, result.link ? t('cap.codeAndLink') : t('cap.codeArrived'), 'ok', action('fill-code', t('act.fill')), { link: result.link })
        : capsule(face, t('cap.linkArrived'), 'ok', action('open-link', t('act.open')));
    }
    case 'reporting':
      return capsule(result ? resultFace(result) : addressFace, t('cap.reporting'), 'wait', action('finish', t('act.reportingBusy'), { busy: true }));
    case 'report-unknown':
      return capsule(result ? resultFace(result) : addressFace, t('cap.reportUnknown'), 'error', action('end', t('act.end')));
    case 'reported':
      return capsule(result ? resultFace(result) : addressFace, t('cap.reported'), 'ok', action('end', t('act.end')));
    case 'closing':
      return capsule(result ? resultFace(result) : addressFace, t('cap.closing'), 'wait', action('end', t('act.closingBusy'), { busy: true }));
    case 'close-failed':
      return capsule(addressFace, t('cap.closeFailed'), 'error', action('retry-close', t('act.retryClose')));
    case 'closed':
      return capsule({ text: address ?? '—', kind: 'muted' }, t('cap.closed', { provider: providerLabel }), 'idle', action('get', t('act.getNew')));
  }
}

export function capsuleFor(input: CapsuleInput): Capsule {
  const capsule = base(input);
  if (!input.notice) return capsule;
  return { ...capsule, status: input.notice.text, tone: input.notice.tone, ticking: false };
}

/** Rows the drawer shows for a stage. Order is the reading order. */
export interface DrawerPlan {
  providerEditable: boolean;
  showAddress: boolean;
  /** Fill/copy next to the address: only while the inbox can still receive. */
  addressFill: boolean;
  showResult: boolean;
  /** "继续收取" — wait for the next message, keeping this one copyable. */
  canContinue: boolean;
  /** Finish row: report-and-close, end without reporting, report only. */
  finish: 'full' | 'end-only' | 'none';
  canReplace: boolean;
}

export function drawerPlan(stage: Stage, hasResult: boolean, waiting: boolean): DrawerPlan {
  const live = isLive(stage);
  const busy = stage === 'reporting' || stage === 'closing' || stage === 'creating';
  return {
    providerEditable: stage === 'empty' || stage === 'closed' || stage === 'create-unknown',
    showAddress: stage !== 'empty' && stage !== 'create-unknown',
    addressFill: live && !busy,
    showResult: hasResult,
    canContinue: hasResult && live && !busy && !waiting,
    finish: stage === 'waiting' || stage === 'result' ? 'full'
      : stage === 'reported' || stage === 'report-unknown' || stage === 'close-failed' ? 'end-only'
        : 'none',
    canReplace: live && !busy,
  };
}
