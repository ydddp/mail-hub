// js/views/inboxes.js — inboxes and inbox detail view.
import { addActivity } from '../components/activity.js';
import { _syncAllCheckRows } from '../components/drag-select.js';
import { _pageState, paginateTable } from '../components/pagination.js';
import { resetScopeIndicator, syncScopeIndicator } from '../components/scope-tabs.js';
import { EL, on } from '../core/actions.js';
import { api, apiAllInboxes } from '../core/api.js';
import { codeSession } from '../core/code-session.js';
import { hideDialog, showDialog } from '../core/dialog.js';
import { t } from '../core/i18n.js';
import { motionDelay, prefersReducedMotion } from '../core/motion.js';
import { compareMailReceived, emptyStateRow, esc, escAttr, fmtTime, iconBtn, inboxStatusBadge, mailTime, mailTooltipPosition, renderLoading, targetEl, toast } from '../core/util.js';
import { loadDashboard } from './dashboard.js';
// ─── Inboxes ───
let _allInboxes = [];

function renderInboxTable(rows) {
  document.getElementById('inbox-list').innerHTML = rows.length ? rows.map(i => `
    <tr>
      <td><input type="checkbox" class="inbox-check" value="${escAttr(i.id)}" data-status="${escAttr(i.status)}"></td>
      <td class="mono fs-sm">${esc(i.address)}</td>
      <td class="text-2">${esc(i.provider)}</td>
      <td>${targetEl(i.target_service)}</td>
      <td>${inboxStatusBadge(i.status)}</td>
      <td class="time">${fmtTime(i.expires_at, 'date')}</td>
      <td>
        ${iconBtn('inbox', t('inbox.receive'), on('click', 'viewInbox', i.id), 'blue')}
        ${iconBtn('code', t('inbox.extract'), on('click', 'getCode', i.id), 'blue')}
        ${i.status==='active' ? `
          ${iconBtn('check', t('inbox.success'), on('click', 'reportInbox', i.id, true), 'blue')}
          ${iconBtn('x', t('inbox.fail'), on('click', 'reportInbox', i.id, false), 'amber')}
          ${iconBtn('trash', t('common.close'), on('click', 'closeInbox', i.id), 'danger')}
        ` : ''}
      </td>
    </tr>
  `).join('') : emptyStateRow(7, t('common.no_data'));
}

async function loadInboxes() {
  const status = document.getElementById('filter-status').value;
  const provider = document.getElementById('filter-provider').value;
  let url = '/inboxes?';
  if (status) url += `status=${status}&`;
  if (provider) url += `provider=${provider}&`;
  renderLoading('inbox-list', 7);
  try {
    const data = await apiAllInboxes(url);
    _allInboxes = data.inboxes || [];
    delete _pageState['inbox'];
    paginateTable('inbox', _allInboxes, renderInboxTable, 'inbox-pager');
  } catch (e) { toast(e.message, 'error'); }
}

async function createInbox(prefix) {
  const body = {};
  const f = document.getElementById(prefix + 'inbox-for').value.trim();
  const p = document.getElementById(prefix + 'inbox-provider').value;
  const d = document.getElementById(prefix + 'inbox-domain').value.trim();
  const durEl = document.getElementById(prefix + 'inbox-duration');
  const dur = durEl ? durEl.value : '';
  if (f) body.for = f;
  if (p) body.provider = p;
  if (d) body.domain = d;
  if (dur) body.duration = parseInt(dur) * 60; // UI 输入分钟，API 接口单位为秒
  const aliasEl = document.getElementById(prefix + 'inbox-alias');
  if (aliasEl?.checked) body.alias = true;
  try {
    const result = await api('/inbox', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById(prefix + 'inbox-result').innerHTML = `
      <div class="code-box create-result">
        <div class="code-meta">Provider: <strong>${esc(result.provider)}</strong></div>
        <div class="code-value"${on('click', 'copyText', EL)} title="${escAttr(t('inbox.click_copy'))}">${esc(result.address)}</div>
        <div class="code-meta">ID: ${esc(result.id)} ${result.expiresAt ? '· Expires: ' + fmtTime(result.expiresAt) : ''}</div>
      </div>
    `;
    toast(t('toast.inbox_created'));
    addActivity('green', `Created inbox <span class="activity-hl">${esc(result.address)}</span>`, true);
    if (prefix === 'i-') loadInboxes(); else loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * The inbox list and whatever you opened from it are two modes of one page, not
 * two stacked panels. Stacking meant every click ended in a scroll: the create
 * form plus a 20-row table pushed the messages past the fold. The list's scroll
 * position is kept so going back lands where you left.
 */
let _inboxListScroll = 0;

function inboxScroller() { return document.querySelector('.main'); }

/**
 * Fade the outgoing side, then swap. Callers must await this before writing to
 * the detail area, or the panel renders while its container is still hidden and
 * its entrance animation is thrown away.
 */
async function enterInboxDetail() {
  const view = document.getElementById('v-inboxes');
  if (!view || view.classList.contains('detail-mode')) return;
  _inboxListScroll = inboxScroller()?.scrollTop || 0;
  resetScopeIndicator();
  view.classList.add('leaving');
  await motionDelay(120);
  view.classList.remove('leaving');
  view.classList.add('detail-mode');
  if (inboxScroller()) inboxScroller().scrollTop = 0;
}

async function exitInboxDetail(restoreScroll = true, animate = true) {
  invalidateCodeView();
  const view = document.getElementById('v-inboxes');
  if (!view || !view.classList.contains('detail-mode')) return;
  resetScopeIndicator();
  if (animate) {
    view.classList.add('leaving');
    await motionDelay(120);
    view.classList.remove('leaving');
  }
  view.classList.remove('detail-mode');
  document.getElementById('inbox-detail-area').innerHTML = '';
  if (inboxScroller()) inboxScroller().scrollTop = restoreScroll ? _inboxListScroll : 0;
}

/**
 * Fades whatever panel is already showing before the caller overwrites it.
 * No-ops on the first render into an empty area — the mode transition covers
 * that one — so this only costs a beat when one panel really replaces another.
 */
async function fadeOutDetail(area) {
  const current = area.querySelector('.detail-panel');
  if (!current || prefersReducedMotion()) return;
  current.classList.add('panel-leaving');
  await motionDelay(120);
}

/**
 * The placeholder only appears if the wait is real. Showing it unconditionally
 * meant a local fetch inserted a panel and replaced it 7ms later, so the
 * entrance animation restarted from zero and the whole thing read as a flicker.
 */
function deferredLoading(area, text, current = () => true) {
  const timer = setTimeout(() => {
    if (!current()) return;
    area.innerHTML = `<div class="detail-panel"><p class="text-3">${text}</p></div>`;
  }, 150);
  return () => clearTimeout(timer);
}

/**
 * A failed load replaces whatever the area shows — the deferred placeholder,
 * or the panel of the previous inbox — with the error and a retry, so stale
 * content never reads as the answer to this request.
 */
function renderDetailError(area, err, retryAction) {
  const msg = esc((err && err.message) || t('common.load_failed') || 'Load failed');
  area.innerHTML = `<div class="detail-panel"><div class="empty is-error">
    <p>${msg}</p>
    <button class="btn btn-sm"${retryAction}>${t('common.retry') || '重试'}</button>
  </div></div>`;
}

/** A mail body frame has loaded: size its row to the content. */
function fitMsgFrame(frame) { fitMsgBody(frame.closest('.msg-body')); }

function msgTableHead() {
  return `<thead><tr><th>${t('inbox.from')}</th><th>${t('inbox.subject')}</th><th data-i18n="common.time">${t('common.time')}</th><th>${t('common.actions')}</th></tr></thead>`;
}

let _mailTimeHelpReady = false;
let _mailTimeHelp = null;

function initMailTimeHelp() {
  if (_mailTimeHelpReady) return;
  _mailTimeHelpReady = true;
  const close = () => {
    if (_mailTimeHelp?.tip.isConnected && _mailTimeHelp.tip.matches(':popover-open')) _mailTimeHelp.tip.hidePopover();
    _mailTimeHelp = null;
  };
  const show = anchor => {
    if (!anchor || _mailTimeHelp?.anchor === anchor) return;
    close();
    const tip = anchor.querySelector('.mail-time-tip');
    if (!tip) return;
    // A native popover escapes .panel/.table-wrap overflow and transformed
    // detail panels. Its viewport coordinates cannot widen the scroll area.
    tip.showPopover();
    const position = mailTooltipPosition(anchor.getBoundingClientRect(), tip.getBoundingClientRect(), window.innerWidth, window.innerHeight);
    tip.style.left = position.left + 'px';
    tip.style.top = position.top + 'px';
    _mailTimeHelp = { anchor, tip };
  };
  document.addEventListener('pointerover', event => show(event.target.closest?.('.mail-time')));
  document.addEventListener('focusin', event => show(event.target.closest?.('.mail-time')));
  document.addEventListener('pointerout', event => {
    const anchor = event.target.closest?.('.mail-time');
    if (anchor && !anchor.contains(event.relatedTarget) && !anchor.contains(document.activeElement)) close();
  });
  document.addEventListener('focusout', event => {
    const anchor = event.target.closest?.('.mail-time');
    if (anchor && !anchor.contains(event.relatedTarget) && !anchor.matches(':hover')) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
}

function mailTimeLabel(value) {
  const time = mailTime(value);
  if (!time.iso) return esc(time.label);
  initMailTimeHelp();
  const description = `${time.iso} · ${t('time.zone', { zone: time.zone })}`;
  return `<span class="mail-time" tabindex="0" aria-label="${escAttr(time.label + ' · ' + description)}"><time datetime="${escAttr(time.iso)}">${esc(time.label)}</time><span class="mail-time-tip" role="tooltip" popover="manual">${esc(description)}</span></span>`;
}

function mailArrivalLabel(m, leaseById) {
  const lease = leaseById[m.leaseId];
  if (m.leaseState === 'lease') return lease ? t(lease.status === 'active' ? 'mailbox.lease_current' : 'mailbox.lease_past') : t('mailbox.no_records');
  if (!Object.keys(leaseById).length && m.leaseState !== 'undated') return t('mailbox.no_records');
  return t('mailbox.state_' + m.leaseState);
}

function mailRecipientLabel(m, leaseById) {
  if (!m.recipientMatch) return '';
  let recipient = t(m.recipientMatch === 'multiple' ? 'mailbox.recipient_multiple' : 'mailbox.recipient_unknown');
  if (m.recipientMatch === 'exact' && m.recipientAddress) {
    const fold = value => value.replace(/[A-Z]/g, char => char.toLowerCase());
    const retained = Object.values(leaseById).some(lease => fold(lease.address || '') === fold(m.recipientAddress));
    recipient = m.recipientAddress + (retained ? '' : `（${t('mailbox.no_records')}）`);
  }
  return `${esc(t('mailbox.recipient'))}${esc(recipient)}；${esc(t('mailbox.arrival'))}${esc(mailArrivalLabel(m, leaseById))}`;
}

function msgRow(m, readAction, leaseById) {
  return `<tr data-message-id="${escAttr(m.id)}">
    <td class="fs-base">${esc(m.from)}</td>
    <td>${esc(m.subject)}${leaseById ? `<div class="cell-sub mail-attribution">${mailRecipientLabel(m, leaseById)}</div>` : ''}</td>
    <td class="time">${mailTimeLabel(m.receivedAt)}</td>
    <td>${iconBtn('mail', t('inbox.read'), readAction, 'blue')}</td>
  </tr>`;
}

async function viewInbox(id) {
  invalidateCodeView();
  const request = _codeRequest;
  const area = document.getElementById('inbox-detail-area');
  await enterInboxDetail();
  if (request !== _codeRequest) return;
  await fadeOutDetail(area);
  if (request !== _codeRequest) return;
  const stopLoading = deferredLoading(area, t('common.loading') || 'Loading...', () => request === _codeRequest);
  try {
    const data = await api(`/inbox/${id}/messages`);
    stopLoading();
    if (request !== _codeRequest) return;
    const msgs = (data.messages || []).slice().sort(compareMailReceived);
    // An inbox is a lease over a mailbox and this list stays clipped to the
    // lease. The tab is the way out to the mailbox itself — offered only when
    // the server names an account, i.e. only for Outlook, where one mailbox
    // serves one lease at a time and the rest of it is this caller's own
    // history rather than someone else's.
    const scopeTabs = data.accountEmail ? `
      <div class="scope-tabs">
        <span class="scope-ind"></span>
        <button class="scope-tab active">${t('mailbox.scope_lease')} (${msgs.length})</button>
        <button class="scope-tab"${on('click', 'scopeSwitch', EL, 'mailbox', data.accountEmail, id)}>${t('mailbox.scope_all')}</button>
      </div>` : '';
    const inboxHeader = `<div class="detail-head">
      <span class="mono fs-md fw-semibold">${esc(data.address||'')}</span>
      <span class="text-2">${esc(data.provider||'')}</span>
      ${inboxStatusBadge(data.status)}
      ${scopeTabs}
    </div>`;
    if (!msgs.length) {
      area.innerHTML = `<div class="detail-panel">${inboxHeader}<p class="text-3">${t('inbox.no_mail')}</p><div class="detail-actions">${iconBtn('refresh', t('nav.refresh'), on('click', 'viewInbox', id), 'blue')}</div></div>`;
      return;
    }
    area.innerHTML = `
      <div class="detail-panel">
        ${inboxHeader}
        <div class="detail-bar">
          <h3>${t('inbox.messages_title', {n: msgs.length})}</h3>
          ${iconBtn('refresh', t('nav.refresh'), on('click', 'viewInbox', id), 'blue')}
        </div>
        <div class="panel"><div class="table-wrap"><table>${msgTableHead()}<tbody>${msgs.map(m =>
          msgRow(m, on('click', 'readMessage', id, m.id, EL))
        ).join('')}</tbody></table></div></div>
      </div>
    `;
    syncScopeIndicator(area.querySelector('.scope-tabs'));
  } catch (e) { stopLoading(); if (request === _codeRequest) renderDetailError(area, e, on('click', 'viewInbox', id)); }
}

/**
 * The account's whole mailbox, with every message filed under the lease that
 * held the mailbox when it arrived. The lease view above is the default because
 * it answers "did MY signup mail arrive"; this one answers "what else is in
 * here", which the lease view cannot and should not.
 */
async function viewMailbox(email, backInboxId) {
  invalidateCodeView();
  const request = _codeRequest;
  const area = document.getElementById('inbox-detail-area');
  await enterInboxDetail();
  await fadeOutDetail(area);
  if (request !== _codeRequest) return;
  const stopLoading = deferredLoading(area, t('common.loading') || 'Loading...', () => request === _codeRequest);
  try {
    const data = await api(`/outlook/accounts/${encodeURIComponent(email)}/mailbox`);
    stopLoading();
    if (request !== _codeRequest) return;
    const msgs = (data.messages || []).slice().sort(compareMailReceived);
    const leases = data.leases || [];
    const leaseById = {};
    leases.forEach(l => { leaseById[l.id] = l; });

    const scopeTabs = backInboxId ? `
      <div class="scope-tabs">
        <span class="scope-ind"></span>
        <button class="scope-tab"${on('click', 'scopeSwitch', EL, 'lease', email, backInboxId)}>${t('mailbox.scope_lease')}</button>
        <button class="scope-tab active">${t('mailbox.scope_all')}</button>
      </div>` : '';

    const header = `<div class="detail-head">
      <span class="mono fs-md fw-semibold">${esc(email)}</span>
      <span class="text-2">outlook · ${t('mailbox.lease_count', {n: leases.length})}</span>
      ${scopeTabs}
    </div>`;
    const refresh = iconBtn('refresh', t('nav.refresh'), on('click', 'viewMailbox', email, backInboxId || ''), 'blue');

    area.innerHTML = `
      <div class="detail-panel">
        ${header}
        <div class="detail-bar">
          <h3 id="mailbox-loaded-count">${t('mailbox.loaded', {n: msgs.length})}</h3>
          ${refresh}
        </div>
        <div class="panel"><div class="table-wrap"><table>${msgTableHead()}<tbody id="mailbox-list"></tbody></table></div></div>
        <div id="mailbox-pager"></div>
        <div id="mailbox-history-controls"></div>
      </div>
    `;
    // A full mailbox is 50 rows — long enough that the pager beats scrolling.
    _mailboxCtx = { email, leaseById, messages: msgs, nextPageToken: data.nextPageToken, loading: false };
    delete _pageState['mailbox'];
    paginateTable('mailbox', msgs, renderMailboxRows, 'mailbox-pager');
    renderMailboxHistoryControls();
    syncScopeIndicator(area.querySelector('.scope-tabs'));
  } catch (e) { stopLoading(); if (request === _codeRequest) renderDetailError(area, e, on('click', 'viewMailbox', email, ...(backInboxId ? [backInboxId] : []))); }
}

let _mailboxCtx = null;

function renderMailboxHistoryControls(error = '') {
  const ctx = _mailboxCtx;
  const area = document.getElementById('mailbox-history-controls');
  if (!ctx || !area) return;
  const count = document.getElementById('mailbox-loaded-count');
  if (count) count.textContent = t('mailbox.loaded', { n: ctx.messages.length });
  area.innerHTML = `<p class="detail-note">${t('mailbox.history_note')}</p>
    <p class="text-3" role="status">${esc(error)}</p>
    ${ctx.nextPageToken ? `<button class="btn btn-sm"${ctx.loading ? ' disabled' : ''}${on('click', 'loadEarlierMailbox')}>${t(ctx.loading ? 'common.loading' : error ? 'common.retry' : 'mailbox.load_earlier')}</button>` : ''}`;
}

async function loadEarlierMailbox() {
  const ctx = _mailboxCtx;
  if (!ctx || ctx.loading || !ctx.nextPageToken) return;
  ctx.loading = true;
  renderMailboxHistoryControls();
  try {
    const query = new URLSearchParams({ pageToken: ctx.nextPageToken });
    const data = await api(`/outlook/accounts/${encodeURIComponent(ctx.email)}/mailbox?${query}`);
    if (_mailboxCtx !== ctx) return;
    const known = new Set(ctx.messages.map(message => message.id));
    for (const message of data.messages || []) if (!known.has(message.id)) { known.add(message.id); ctx.messages.push(message); }
    for (const lease of data.leases || []) ctx.leaseById[lease.id] = lease;
    ctx.nextPageToken = data.nextPageToken;
    paginateTable('mailbox', ctx.messages, renderMailboxRows, 'mailbox-pager');
  } catch (error) {
    if (_mailboxCtx === ctx) { ctx.loading = false; renderMailboxHistoryControls(error.message); }
    return;
  }
  if (_mailboxCtx === ctx) { ctx.loading = false; renderMailboxHistoryControls(); }
}

function renderMailboxRows(rows) {
  if (!_mailboxCtx) return;
  const { email, leaseById } = _mailboxCtx;
  const list = document.getElementById('mailbox-list');
  if (!list) return;
  const expanded = list.querySelector('.msg-expand');
  const expandedId = expanded?.previousElementSibling?.dataset.messageId;
  // Dividers are recomputed per page, so page 2 opens with the lease its first
  // row belongs to rather than inheriting a heading the reader cannot see.
  let bucket;
  list.innerHTML = rows.map(m => {
    const key = m.leaseState === 'lease' ? m.leaseId : m.leaseState;
    let sep = '';
    if (key !== bucket) {
      bucket = key;
      sep = `<tr class="lease-sep"><td colspan="4">${leaseSepLabel(m, leaseById)}</td></tr>`;
    }
    return sep + msgRow(m, on('click', 'readMailboxMessage', email, m.id, EL), leaseById);
  }).join('') || emptyStateRow(4, t('mailbox.empty'));
  if (expandedId) [...list.querySelectorAll('tr[data-message-id]')].find(row => row.dataset.messageId === expandedId)?.after(expanded);
}

function leaseSepLabel(m, leaseById) {
  const arrival = `<span class="lease-name">${esc(t('mailbox.arrival') + mailArrivalLabel(m, leaseById))}</span>`;
  if (m.leaseState !== 'lease') return arrival;
  const l = leaseById[m.leaseId];
  if (!l) return arrival;
  const parts = [
    // Newest ≠ running: an account whose last lease was closed and not yet
    // re-leased still has that lease on top, and calling it "current" would say
    // the mailbox is in use when it is idle. Status is the only honest source.
    arrival,
    `<span class="mono">${esc(l.id)}</span>`,
  ];
  if (l.targetService) parts.push(esc(l.targetService));
  parts.push(`${fmtTime(l.createdAt, 'date')} → ${l.endedAt ? fmtTime(l.endedAt, 'date') : t('mailbox.lease_open')}`);
  return parts.join(' · ');
}

/**
 * The body opens as a row directly under the message it belongs to, so it
 * appears where the eye already is. Rendering it below the whole table meant a
 * second scroll for every message read.
 */
function renderMessage(m, btn, leaseById) {
  const row = btn?.closest('tr');
  if (!row) return;
  // allow-same-origin (still WITHOUT allow-scripts, so nothing in the mail can
  // run) is what lets fitMsgBody read the rendered height and size the frame to
  // its content instead of leaving mail squeezed through a fixed slot.
  const bodyHtml = m.html
    ? `<iframe srcdoc="${escAttr(m.html)}" sandbox="allow-same-origin"${on('load', 'fitMsgFrame', EL)}></iframe>`
    : `<pre class="msg-text">${esc(m.text || t('inbox.no_content'))}</pre>`;

  // Only one body at a time. A sibling closes instantly rather than animating,
  // so switching messages never leaves two rows fighting over the layout.
  row.parentElement.querySelectorAll('.msg-expand').forEach(el => el.remove());

  const tr = document.createElement('tr');
  tr.className = 'msg-expand';
  tr.innerHTML = `<td colspan="4"><div class="msg-expand-wrap"><div>
    <div class="msg-viewer">
      <div class="msg-header"><h3>${esc(m.subject)}</h3><p>From: ${esc(m.from)} · ${mailTimeLabel(m.receivedAt)}</p>${leaseById ? `<p class="mail-attribution">${mailRecipientLabel(m, leaseById)}</p>` : ''}</div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  </div></div></td>`;
  row.after(tr);
  if (!m.html) fitMsgBody(tr.querySelector('.msg-body'));
  requestAnimationFrame(() => tr.classList.add('open'));
}

/** Reading the same message again closes it. Returns true when it did. */
function collapseOwnMessage(btn) {
  const open = btn?.closest('tr')?.nextElementSibling;
  if (!open || !open.classList.contains('msg-expand')) return false;
  open.classList.remove('open');
  setTimeout(() => open.remove(), 240);
  return true;
}

/**
 * Size the reader to its content, capped at ~65vh so a newsletter cannot push
 * the page furniture off screen. The cap is a starting height, not a limit —
 * .msg-body carries resize:vertical and no max-height, so dragging goes past it.
 */
function fitMsgBody(box, retried) {
  if (!box) return;
  const cap = Math.min(window.innerHeight * 0.65, 760);
  const frame = box.querySelector('iframe');
  let content;
  if (frame) {
    let inner = 0;
    try { inner = frame.contentDocument.documentElement.scrollHeight; } catch (e) { inner = 0; }
    if (inner) frame.style.height = inner + 'px';
    content = inner || 320;
    // Images finish after load and change the height under us; re-measure once.
    if (!retried) setTimeout(() => fitMsgBody(box, true), 400);
  } else {
    box.style.height = 'auto';
    content = box.scrollHeight;
  }
  box.style.height = Math.max(120, Math.min(content + 4, cap)) + 'px';
}

async function readMessage(inboxId, msgId, btn) {
  if (collapseOwnMessage(btn)) return;
  try {
    renderMessage(await api(`/inbox/${inboxId}/messages/${msgId}`), btn);
  } catch (e) { toast(e.message, 'error'); }
}

async function readMailboxMessage(email, msgId, btn) {
  if (collapseOwnMessage(btn)) return;
  const ctx = _mailboxCtx;
  try {
    const message = await api(`/outlook/accounts/${encodeURIComponent(email)}/mailbox/${encodeURIComponent(msgId)}`);
    if (_mailboxCtx !== ctx || !ctx || ctx.email !== email) return;
    renderMessage(message, btn, ctx.leaseById);
  } catch (e) { toast(e.message, 'error'); }
}

let _codeRequest = 0;
let _codeResultInbox = null;
function invalidateCodeView() { _codeRequest++; _codeResultInbox = null; _mailboxCtx = null; }
function clearCodeSession() {
  codeSession.clear();
  invalidateCodeView();
  _allInboxes = [];
  const area = document.getElementById('inbox-detail-area');
  if (area) area.innerHTML = '';
}
function codeSessionControls(id, message = '') {
  const full = codeSession.ids(id).length >= 20;
  return `<div class="code-session-controls"><p class="text-3" role="status">${esc(message || (full ? t('inbox.code_session_full') : ''))}</p>
    <p class="code-meta">${esc(t('inbox.code_session_hint'))}</p>
    <button class="btn btn-primary btn-sm"${full ? ' disabled' : ''}${on('click', 'getCode', id, true, true)}>${t('inbox.continue_code')}</button>
    <button class="btn btn-sm"${on('click', 'resetCodeSession', id)}>${t('inbox.reset_code_session')}</button></div>`;
}
function updateCodeSessionControls(area, id, message) {
  const controls = area.querySelector('.code-session-controls');
  if (controls) controls.outerHTML = codeSessionControls(id, message);
  else area.innerHTML += codeSessionControls(id, message);
}
function resetCodeSession(id) {
  codeSession.reset(id);
  _codeRequest++;
  updateCodeSessionControls(document.getElementById('inbox-detail-area'), id, t('inbox.code_session_reset'));
}

async function getCode(id, wait = false, keepResult = false) {
  wait = wait === true || wait === 'true';
  keepResult = (keepResult === true || keepResult === 'true') && _codeResultInbox === id;
  const ticket = codeSession.capture(id);
  const request = ++_codeRequest;
  const current = () => codeSession.current(ticket) && request === _codeRequest;
  const area = document.getElementById('inbox-detail-area');
  await enterInboxDetail();
  if (!current()) return;
  if (!keepResult) await fadeOutDetail(area);
  if (!current()) return;
  if (!keepResult) { area.innerHTML = ''; _codeResultInbox = null; }
  let matching = _allInboxes.find(inbox => inbox.id === id)?.provider === 'outlook';
  const stopLoading = keepResult ? () => {} : deferredLoading(area, wait && matching ? t('inbox.match_wait') : wait ? t('inbox.extracting_wait') : t('inbox.extracting'), current);
  try {
    const inbox = _allInboxes.find(inbox => inbox.id === id) || await api(`/inbox/${id}`);
    if (!current()) return;
    matching = inbox.provider === 'outlook';
    if (matching && codeSession.ids(id).length >= 20) {
      stopLoading();
      updateCodeSessionControls(area, id, t('inbox.code_session_full'));
      return;
    }
    if (matching && keepResult) updateCodeSessionControls(area, id, t('inbox.match_wait'));
    const exclusions = matching ? codeSession.ids(id).map(messageId => `&excludeMessageId=${encodeURIComponent(messageId)}`).join('') : '';
    const data = await api(`/inbox/${id}/code?wait=${wait}&timeout=30${matching ? '&selection=matching' : ''}${exclusions}`);
    stopLoading();
    if (!current()) return;
    if (!data.codes?.length) {
      const state = matching ? data.scan?.reason === 'scan_limit' ? 'inbox.match_limit'
        : data.scan?.reason === 'timeout' ? 'inbox.match_timeout' : 'inbox.match_empty' : 'inbox.no_code';
      if (matching && keepResult) updateCodeSessionControls(area, id, t(state));
      else area.innerHTML = `<div class="detail-panel"><p class="text-3">${t(state)}</p>${matching ? codeSessionControls(id) : `<button class="btn btn-primary btn-sm detail-actions"${on('click', 'getCode', id, true)}>${t('inbox.wait_retry')}</button>`}</div>`;
      return;
    }
    if (matching) codeSession.remember(ticket, data.messageId);
    _codeResultInbox = id;
    addActivity('green', t('inbox.extract') + (matching ? ' · matching' : ' · latest'));
    area.innerHTML = `
      <div class="detail-panel">
        <h3>${t('inbox.extract')}</h3>
        ${data.email ? `<p class="code-from">${t('inbox.from')}: ${esc(data.email.from)} · ${esc(data.email.subject)}</p>` : ''}
        ${matching ? `<p class="code-meta">${mailTimeLabel(data.receivedAt)} · ${esc(t('inbox.requested_address'))}: ${esc(inbox.address)} · ${esc(t('mailbox.recipient'))}${esc(data.email?.recipientAddress || t('mailbox.recipient_unknown'))}</p>` : ''}
        ${matching && (data.scan?.truncated || data.scan?.complete === false) ? `<p class="text-3">${esc(t('inbox.match_range'))}</p>` : ''}
        ${data.codes.map(c => `
          <div class="code-box">
            <div class="code-meta"><span class="text-2">${esc(c.type)}</span> · ${t('inbox.confidence')}: ${(c.confidence*100).toFixed(0)}%</div>
            <div class="${c.type==='link'?'code-link':'code-value'}"${on('click', 'copyText', EL)} title="${t('inbox.click_copy')}">${esc(c.value)}</div>
            <div class="code-meta">${esc(c.context)}</div>
          </div>
        `).join('')}
        ${matching ? codeSessionControls(id) : ''}
      </div>
    `;
  } catch (e) {
    stopLoading();
    if (!current()) return;
    const error = matching && (e.status === 429 || e.status >= 500)
      ? new Error(t(e.status === 429 ? 'inbox.match_rate_limit' : 'inbox.match_upstream') + ' · ' + e.message) : e;
    if (matching && keepResult) updateCodeSessionControls(area, id, error.message);
    else renderDetailError(area, error, on('click', 'getCode', id, wait));
  }
}

async function reportInbox(id, success) {
  try {
    const result = await api(`/inbox/${id}/report`, { method: 'POST', body: JSON.stringify({ success }) });
    if (success) {
      toast(t('toast.reported_success'));
      addActivity('green', t('activity.reported_success'));
    } else {
      const info = result.blocked?.length ? ` → blocked ${result.blocked.map(b => b.domain).join(', ')}` : '';
      toast(t('toast.reported_fail') + info);
      addActivity('rose', t('activity.reported_fail') + info);
    }
    loadInboxes();
  } catch (e) { toast(e.message, 'error'); }
}

async function closeInbox(id) {
  showDialog(t('inbox.close'), `<p>${t('dialog.confirm_close')}?</p>`, `
    <button class="btn" data-no-loading${on('click', 'hideDialog')}>${t('common.cancel')}</button>
    <button class="btn btn-danger"${on('click', 'doClose', id)}>${t('dialog.confirm_close')}</button>
  `);
}
async function doClose(id) {
  hideDialog();
  try {
    await api(`/inbox/${id}`, { method: 'DELETE' });
    codeSession.reset(id);
    toast(t('toast.inbox_closed'));
    addActivity('rose', t('activity.closed_inbox'));
    loadInboxes();
  } catch (e) { toast(e.message, 'error'); }
}

function toggleAllInbox(checked) {
  document.querySelectorAll('.inbox-check').forEach(cb => cb.checked = checked);
  _syncAllCheckRows('inbox-check');
}

function getSelectedInboxIds(activeOnly = false) {
  return Array.from(document.querySelectorAll('.inbox-check:checked'))
    .filter(cb => !activeOnly || cb.dataset.status === 'active')
    .map(cb => cb.value);
}

async function batchCloseInbox() {
  const ids = getSelectedInboxIds();
  if (!ids.length) return toast(t('common.select_first') || '请先选择', 'error');
  if (!confirm(t('inbox.confirm_batch_close') || '批量关闭所选邮箱?')) return;
  let ok = 0, fail = 0;
  for (const id of ids) {
    try { await api(`/inbox/${id}`, { method: 'DELETE' }); codeSession.reset(id); ok++; }
    catch (e) { fail++; console.error('batchClose', id, e); }
  }
  const msg = fail
    ? (t('common.batch_partial') || `成功 {ok} / 失败 {fail}`).replace('{ok}', ok).replace('{fail}', fail)
    : (t('common.batch_done') || `成功关闭 {ok} 个`).replace('{ok}', ok);
  toast(msg, fail ? 'warn' : 'success');
  loadInboxes();
}

async function batchReportInbox(success) {
  const ids = getSelectedInboxIds();
  if (!ids.length) return toast(t('common.select_first') || '请先选择', 'error');
  let ok = 0, fail = 0;
  for (const id of ids) {
    try { await api(`/inbox/${id}/report`, { method: 'POST', body: JSON.stringify({ success }) }); ok++; }
    catch (e) { fail++; console.error('batchReport', id, e); }
  }
  const msg = fail
    ? (t('common.batch_partial') || `成功 {ok} / 失败 {fail}`).replace('{ok}', ok).replace('{fail}', fail)
    : (t('common.batch_done') || `成功 {ok} 个`).replace('{ok}', ok);
  toast(msg, fail ? 'warn' : 'success');
  loadInboxes();
}
export { batchCloseInbox, batchReportInbox, clearCodeSession, closeInbox, collapseOwnMessage, createInbox, deferredLoading, doClose, enterInboxDetail, exitInboxDetail, fadeOutDetail, fitMsgFrame, getCode, invalidateCodeView, loadEarlierMailbox, loadInboxes, msgRow, msgTableHead, readMailboxMessage, readMessage, renderDetailError, renderMessage, reportInbox, resetCodeSession, toggleAllInbox, viewInbox, viewMailbox };
