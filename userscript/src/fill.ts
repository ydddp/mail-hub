/**
 * Fill the page's own email or code field, without the user first clicking
 * into it. Picking the field is a score over what the page tells us about each
 * input (type, autocomplete, name, label...). The scoring is pure so it can be
 * tested; the DOM walk and the write live below it.
 */

export type FillKind = 'email' | 'code';

/** What we read from one input. Strings are already lower-cased. */
export interface FieldInfo {
  type: string;
  autocomplete: string;
  /** name, id, placeholder, aria-label and label text, joined. */
  text: string;
  inputMode: string;
  /** -1 when the page set none. */
  maxLength: number;
  hasValue: boolean;
  /** The user's caret was in this field recently. */
  recent: boolean;
  /** One of four or more one-character boxes in a row (a split code widget). */
  splitRow: boolean;
}

const EMAIL_WORDS = /e-?mail|邮箱|郵箱|电子邮件|電子郵件|メール|이메일|correo/;
const ACCOUNT_WORDS = /user(name)?|login|account|identifier|账号|帐号|用户名/;
const CODE_WORDS = /code|otp|one.?time|verif|token|pin\b|passcode|验证码|校验码|驗證碼|動態|确认码|認証|인증/;
const NOT_CODE_WORDS = /promo|coupon|invite|referr|zip|postal|邀请|优惠|邮编|phone|tel|mobile|手机/;
const TEXTUAL = new Set(['', 'text', 'email', 'tel', 'number', 'search', 'url']);

/** Non-negative score; 0 means "never fill this". */
export function scoreField(kind: FillKind, field: FieldInfo): number {
  if (!TEXTUAL.has(field.type)) return 0;
  let score = 0;
  if (kind === 'email') {
    if (field.type === 'email') score += 10;
    if (field.autocomplete.includes('email')) score += 10;
    if (EMAIL_WORDS.test(field.text)) score += 7;
    if (field.autocomplete.includes('username') || ACCOUNT_WORDS.test(field.text)) score += 3;
    if (field.autocomplete.includes('one-time-code') || CODE_WORDS.test(field.text)) score -= 8;
    if (field.type === 'tel' || field.type === 'number') score -= 6;
  } else {
    if (field.autocomplete.includes('one-time-code')) score += 12;
    if (CODE_WORDS.test(field.text)) score += 7;
    if (NOT_CODE_WORDS.test(field.text)) score -= 8;
    if (field.inputMode === 'numeric' || field.type === 'number' || field.type === 'tel') score += 2;
    if (field.maxLength >= 4 && field.maxLength <= 10) score += 3;
    if (field.splitRow) score += 8;
    // "Enter the code from the e-mail" is a code field; only a field that is
    // about the address itself is excluded.
    const aboutEmail = field.type === 'email' || field.autocomplete.includes('email')
      || (EMAIL_WORDS.test(field.text) && !CODE_WORDS.test(field.text));
    if (aboutEmail) score -= 10;
  }
  if (score <= 0) return 0;
  if (field.recent) score += 3;
  if (!field.hasValue) score += 1;
  return score;
}

/** Below this, we would be guessing; copy instead of writing somewhere odd. */
export const MIN_SCORE = 6;

/** Index of the field to fill, or -1. Ties keep document order. */
export function pickField(kind: FillKind, fields: FieldInfo[]): number {
  let best = -1;
  let bestScore = MIN_SCORE - 1;
  fields.forEach((field, index) => {
    const score = scoreField(kind, field);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

// ------------------------------------------------------------------ DOM side

type Editable = HTMLInputElement | HTMLTextAreaElement;

let lastFocused: WeakRef<Editable> | null = null;
let lastFocusedAt = 0;

/** Remember which page field the user was last in; a hint, never the decision. */
export function trackPageFocus(ownHost: Element): () => void {
  const onFocus = (event: FocusEvent) => {
    const target = event.composedPath()[0];
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (ownHost.contains(target) || target.getRootNode() === ownHost.shadowRoot) return;
    lastFocused = new WeakRef(target);
    lastFocusedAt = Date.now();
  };
  document.addEventListener('focusin', onFocus, true);
  return () => document.removeEventListener('focusin', onFocus, true);
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

function labelText(input: Editable): string {
  const parts: string[] = [];
  for (const label of Array.from(input.labels ?? [])) parts.push(label.textContent ?? '');
  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) parts.push(input.ownerDocument.getElementById(id)?.textContent ?? '');
  }
  if (!parts.join('').trim()) {
    // Unlabelled forms often put the caption in the element right before.
    const previous = input.previousElementSibling;
    if (previous && previous.textContent && previous.textContent.length < 60) parts.push(previous.textContent);
  }
  return parts.join(' ');
}

function collect(root: Document | ShadowRoot, out: Editable[], depth = 0): void {
  for (const element of Array.from(root.querySelectorAll('input, textarea'))) out.push(element as Editable);
  if (depth > 3) return;
  // Open shadow roots of web-component forms; closed ones are unreachable.
  for (const host of Array.from(root.querySelectorAll('*'))) {
    if (host.shadowRoot && !host.hasAttribute('data-mailhub-assistant')) collect(host.shadowRoot, out, depth + 1);
  }
}

function inSplitRow(input: Editable, pool: Editable[]): boolean {
  return splitGroup(input, pool) !== null;
}

function describe(input: Editable, recent: Editable | null, pool: Editable[]): FieldInfo {
  const text = [
    input.name, input.id, input.getAttribute('placeholder'), input.getAttribute('aria-label'),
    input.getAttribute('data-testid'), labelText(input),
  ].filter(Boolean).join(' ').toLowerCase();
  return {
    type: input instanceof HTMLTextAreaElement ? 'text' : (input.getAttribute('type') ?? '').toLowerCase(),
    autocomplete: (input.getAttribute('autocomplete') ?? '').toLowerCase(),
    text,
    inputMode: (input.getAttribute('inputmode') ?? '').toLowerCase(),
    maxLength: input.maxLength ?? -1,
    hasValue: Boolean(input.value),
    recent: input === recent,
    splitRow: inSplitRow(input, pool),
  };
}

/** The usable, visible, enabled inputs on the page, excluding our own panel. */
function candidates(): Editable[] {
  const all: Editable[] = [];
  collect(document, all);
  return all.filter((input) => !input.disabled && !input.readOnly && isVisible(input)
    && !input.closest('[data-mailhub-assistant]'));
}

/**
 * Split code widgets: several one-character boxes side by side. When the best
 * code field is one of them, the whole row is filled character by character.
 */
function splitGroup(field: Editable, pool: Editable[]): Editable[] | null {
  if (!(field instanceof HTMLInputElement) || field.maxLength !== 1) return null;
  for (let ancestor = field.parentElement, level = 0; ancestor && level < 3; ancestor = ancestor.parentElement, level++) {
    const row = pool.filter((input) => input instanceof HTMLInputElement && input.maxLength === 1 && ancestor!.contains(input));
    if (row.length >= 4) return row;
  }
  return null;
}

/** Write a value the way typing would: frameworks only listen to events. */
function writeValue(input: Editable, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  input.focus({ preventScroll: true });
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface FillOutcome {
  ok: boolean;
  /** The element that was written, for the highlight. */
  target: Element | null;
}

export function fillPage(kind: FillKind, value: string): FillOutcome {
  const pool = candidates();
  const recentRef = lastFocused?.deref() ?? null;
  // A stale caret from minutes ago is not a hint any more.
  const recent = recentRef && Date.now() - lastFocusedAt < 120_000 ? recentRef : null;
  const index = pickField(kind, pool.map((input) => describe(input, recent, pool)));
  if (index < 0) return { ok: false, target: null };
  const field = pool[index];

  const group = kind === 'code' ? splitGroup(field, pool) : null;
  if (group && group.length >= value.length) {
    Array.from(value).forEach((char, position) => writeValue(group[position], char));
    group[Math.min(value.length, group.length) - 1].blur();
    return { ok: true, target: group[0].parentElement ?? group[0] };
  }

  if (field.getBoundingClientRect().top < 0 || field.getBoundingClientRect().bottom > window.innerHeight) {
    field.scrollIntoView({ block: 'center' });
  }
  writeValue(field, value);
  return { ok: true, target: field };
}
