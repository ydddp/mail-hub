// js/core/util.js — shared helpers: escaping, debounce, empty/loading/error rows, toast, copy, time formatting, icons.
import { _lang, t } from './i18n.js';
const API = '/api';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getToken() { return localStorage.getItem('token') || ''; }

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
// Attribute values need quote encoding in addition to the text-node encoding
// provided by esc(); URL-bearing attributes still require scheme validation.
function escAttr(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
// A value interpolated into an inline handler passes through TWO decoders: the
// HTML attribute parser, then the JS parser. esc() is not enough here — it
// leaves quotes intact, and even an &#39; would be decoded back to ' before JS
// ever runs, letting a crafted service name / account name break out of the
// string and execute. JSON.stringify emits a complete quoted JS literal, so
// call sites must NOT wrap this in their own quotes.
function jsArg(v) {
  return JSON.stringify(String(v ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
async function withButtonLock(btn, fn) {
  if (!btn || btn.hasAttribute('data-loading')) return;
  btn.setAttribute('data-loading', '');
  try { return await fn(); }
  finally { btn.removeAttribute('data-loading'); }
}
// Empty, no-match, failure and loading each replace the
// table body (the header hides with it) by one block: a sentence, and the
// action that fixes it when there is one. Only loading animates.
function renderLoadError(tbodyId, colspan, err, retryAction) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const msg = (err && err.message) ? esc(err.message) : t('common.load_failed') || 'Load failed';
  tbody.innerHTML = `<tr><td class="empty-cell" colspan="${colspan}"><div class="empty is-error">
    <p>${msg}</p>
    <button class="btn btn-sm"${retryAction}>${t('common.retry') || '重试'}</button>
  </div></td></tr>`;
}
/** The empty-list row as markup, for renderers that build the whole tbody string. `ctaAction` comes from on(). */
function emptyStateRow(colspan, message, ctaText, ctaAction) {
  const cta = ctaText ? `<button class="btn btn-primary"${ctaAction}>${ctaText}</button>` : '';
  return `<tr><td class="empty-cell" colspan="${colspan}"><div class="empty">
    <p>${message}</p>
    ${cta}
  </div></td></tr>`;
}
function renderEmpty(tbodyId, colspan, message, ctaText, ctaAction) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = emptyStateRow(colspan, message, ctaText, ctaAction);
}
/** First load only: a list already on screen stays until the new rows replace it. */
function renderLoading(tbodyId, colspan) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody || tbody.rows.length) return;
  tbody.innerHTML = `<tr><td class="empty-cell" colspan="${colspan}"><div class="loading-blocks" aria-hidden="true"></div></td></tr>`;
}
let _toastTimer = null;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.className = 'toast', 2600);
}
/** Colour a status line by what it reports: 'ok', 'warn', 'bad', or 'muted' while in progress. */
function setTone(el, tone) {
  el.classList.remove('tone-ok', 'tone-warn', 'tone-bad', 'text-3');
  const cls = { ok: 'tone-ok', warn: 'tone-warn', bad: 'tone-bad', muted: 'text-3' }[tone];
  if (cls) el.classList.add(cls);
}
/** An inbox's state: a neutral badge either way, with a pulsing dot while it still receives. */
function inboxStatusBadge(status) {
  const active = status === 'active';
  return `<span class="badge"><span class="dot ${active ? 'dot-pulse' : 'dot-gray'}"></span> ${active ? t('common.active') : t('common.closed')}</span>`;
}
/**
 * A row's on/off switch (.toggle). The handler must
 * reload its list when the request fails, or the switch stays flipped.
 */
function toggleSwitch(checked, changeAction, label) {
  return `<label class="toggle" title="${escAttr(label)}"><input type="checkbox" aria-label="${escAttr(label)}"${checked ? ' checked' : ''}${changeAction}><span class="toggle-track"></span><span class="toggle-thumb"></span></label>`;
}
/** Select a read-only field's whole value on click, so it can be copied by hand. */
function selectText(el) { el.select(); return false; }
/** Click another control by id: an input's Enter key standing in for its dialog's confirm button. */
function clickById(id) { document.getElementById(id)?.click(); return false; }
function copyText(el) {
  navigator.clipboard.writeText(el.textContent.trim())
    .then(() => toast(t('toast.copied')))
    .catch((err) => {
      console.warn('Clipboard copy failed', err);
      toast(t('validate.copy_failed'), 'error');
    });
}
function copyValue(value) {
  navigator.clipboard.writeText(String(value ?? '')).then(() => toast(t('toast.copied'))).catch(() => toast(t('validate.copy_failed'), 'error'));
  return false;
}
function timeAgo(dt) {
  const d = parseDisplayTime(dt);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (!Number.isFinite(diff)) return '-';
  if (diff < 60) return t('time.just_now');
  if (diff < 3600) return t('time.minutes_ago', {n: Math.floor(diff / 60)});
  if (diff < 86400) return t('time.hours_ago', {n: Math.floor(diff / 3600)});
  return t('time.days_ago', {n: Math.floor(diff / 86400)});
}
function parseDisplayTime(dt) {
  if (typeof dt !== 'string' || !dt.trim()) return new Date(NaN);
  const value = dt.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  if (!match) return new Date(NaN);
  const [,year,month,day,hour,minute,second,fraction='',zone='Z'] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth()+1 !== Number(month)
    || calendar.getUTCDate() !== Number(day) || Number(hour)>23 || Number(minute)>59 || Number(second)>59) return new Date(NaN);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${zone.toUpperCase()}`);
}
function fmtTime(dt, mode) {
  if (!dt) return '-';
  const d = parseDisplayTime(dt);
  if (isNaN(d)) return '-';
  if (mode === 'short') return d.toLocaleTimeString(_lang==='zh'?'zh-CN':'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (mode === 'date') return d.toLocaleDateString(_lang==='zh'?'zh-CN':'en-US', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString(_lang==='zh'?'zh-CN':'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleString(_lang==='zh'?'zh-CN':'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function shortTime(dt) { return fmtTime(dt, 'short'); }
/** Mail keeps its exact instant; unknown arrivals are never replaced by now. */
function mailTime(dt) {
  const date = parseDisplayTime(dt);
  if (!Number.isFinite(date.getTime())) return { label: t('time.unknown'), iso: '', zone: '' };
  return {
    label: fmtTime(dt),
    iso: date.toISOString(),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
/** A display tie-break only: equal instants do not imply a delivery order. */
function compareMailReceived(a, b) {
  const first = parseDisplayTime(a.receivedAt).getTime();
  const second = parseDisplayTime(b.receivedAt).getTime();
  const firstKnown = Number.isFinite(first);
  const secondKnown = Number.isFinite(second);
  if (firstKnown !== secondKnown) return firstKnown ? -1 : 1;
  if (firstKnown && first !== second) return second - first;
  const firstId = String(a.id ?? '');
  const secondId = String(b.id ?? '');
  return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
}
/** Top-layer mail help follows its anchor while staying inside the viewport. */
function mailTooltipPosition(anchor, popup, width, height) {
  const margin = 12;
  const below = anchor.bottom + 6;
  const above = anchor.top - popup.height - 6;
  const top = below + popup.height > height - margin && above >= margin ? above : below;
  return {
    left: Math.max(margin, Math.min(anchor.right - popup.width, width - popup.width - margin)),
    top: Math.max(margin, Math.min(top, height - popup.height - margin)),
  };
}
function fmtBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1024 / 1024).toFixed(2) + ' MB';
}
function targetEl(service) {
  if (!service) return '-';
  return `<span class="target"><span class="target-icon">${esc(service[0].toUpperCase())}</span> ${esc(service)}</span>`;
}
const ICONS = {
  // A sign-in is a key, not a tick: 'check' means done, and using it for an
  // action that has not happened yet reads as "already signed in".
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  test: '<path d="M10 2v7.31"/><path d="M14 2v7.31"/><path d="M8.5 9h7"/><path d="M14.5 9 20 20a1.5 1.5 0 0 1-1.34 2H5.34A1.5 1.5 0 0 1 4 20L9.5 9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  code: '<path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/><path d="M14 8h.01"/><path d="M10 8h.01"/><path d="M12 21a9 9 0 1 0-9-9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V7"/><path d="M17 16v-3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18"/><path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58"/><path d="M9.88 5.24A9.52 9.52 0 0 1 12 5c6.5 0 10 7 10 7a18.16 18.16 0 0 1-2.35 3.31"/><path d="M6.61 6.61C3.68 8.6 2 12 2 12s3.5 7 10 7a9.62 9.62 0 0 0 5.39-1.61"/>',
};
function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
function iconBtn(icon, label, action, tone) {
  // Row icons share one colour; only a destructive one turns rose, on hover.
  const toneClass = tone === 'danger' ? ' btn-danger' : '';
  return `<button class="btn btn-sm btn-icon${toneClass}" title="${escAttr(label)}" aria-label="${escAttr(label)}"${action}>${iconSvg(icon)}</button>`;
}
export { API, clickById, compareMailReceived, copyText, copyValue, debounce, emptyStateRow, esc, escAttr, fmtBytes, fmtTime, getToken, iconBtn, iconSvg, inboxStatusBadge, mailTime, mailTooltipPosition, renderEmpty, renderLoadError, renderLoading, selectText, setTone, shortTime, sleep, targetEl, toast, toggleSwitch };
