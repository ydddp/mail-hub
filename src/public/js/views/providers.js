// js/views/providers.js — providers and dispatch order view.
import { addActivity } from '../components/activity.js';
import { attachSortable } from '../components/sortable.js';
import { CHECKED, VALUE, on } from '../core/actions.js';
import { api } from '../core/api.js';
import { t } from '../core/i18n.js';
import { esc, escAttr, fmtTime, iconBtn, targetEl, toast } from '../core/util.js';
import { _isAdmin } from '../shell/session.js';
// ─── Providers ───
async function loadProviders() {
  try {
    const data = await api('/providers');
    const grid = document.getElementById('provider-grid');
    const providers = (data.providers || []).filter(p => p.name && p.displayName);
    _providerMeta = new Map(providers.map(p => [p.name, p]));
    const poolNames = new Set(['outlook', 'yyds', 'imap']);
    const groups = [
      { title: t('provider.group_pool'), items: providers.filter(p => poolNames.has(p.name)) },
      { title: t('provider.group_paid'), items: providers.filter(p => !poolNames.has(p.name) && (p.tier === 'paid' || p.type === 'alias')) },
      { title: t('provider.group_free'), items: providers.filter(p => !poolNames.has(p.name) && p.tier !== 'paid' && p.type !== 'alias') },
    ].filter(g => g.items.length);
    const renderCard = (p) => {
      const trustPips = Array.from({length:5}, (_, i) =>
        `<span class="trust-pip ${i < p.trustLevel ? 'filled' : ''}"></span>`
      ).join('');
      const tierText = tierLabel(p);
      const features = Object.entries(p.features).filter(([,v]) => v).map(([k]) => {
        const names = { customUsername: t('tpl.feat_username'), pollInbox: t('tpl.feat_poll'), realtime: t('provider.feat_realtime'), attachments: t('tpl.feat_attach'), alias: t('inbox.alias') };
        return names[k] || k;
      }).join('、');
      const successRate = (p.stats?.success_count || 0) + (p.stats?.fail_count || 0) > 0
        ? Math.round((p.stats?.success_count || 0) / ((p.stats?.success_count || 0) + (p.stats?.fail_count || 0)) * 100)
        : '-';
      return `
        <div class="provider-card ${p.enabled ? '' : 'disabled'}">
          <div class="provider-top">
            <div class="provider-name">${esc(p.displayName)}</div>
            <div class="provider-top-end">
              <span class="text-2 fs-sm">${tierText}</span>
              <label class="toggle">
                <input type="checkbox" ${p.enabled ? 'checked' : ''}${on('change', 'toggleProvider', p.name, CHECKED)}>
                <div class="toggle-track"></div>
                <div class="toggle-thumb"></div>
              </label>
            </div>
          </div>
          <div class="provider-metrics">
            <div class="provider-stat"><span>${t('provider.trust')}</span><span class="trust-bar">${trustPips}</span></div>
            <div class="provider-stat"><span>${t('provider.success_rate')}</span><strong class="${typeof successRate==='number'?(successRate>=80?'tone-ok':'tone-bad'):'text-3'}">${typeof successRate==='number'?successRate+'%':successRate}</strong></div>
            <div class="provider-stat"><span>${t('provider.create_limit')}</span><strong>${p.rateLimit.createPerMinute ? p.rateLimit.createPerMinute + '/min' : `<span class="text-3">${t('provider.no_limit')}</span>`}</strong></div>
            <div class="provider-stat"><span>${t('provider.poll_limit')}</span><strong>${p.rateLimit.pollPerMinute ? p.rateLimit.pollPerMinute + '/min' : `<span class="text-3">${t('provider.no_limit')}</span>`}</strong></div>
            <div class="provider-stat"><span>${t('provider.retention')}</span><strong>${esc(p.retention)}</strong></div>
            <div class="provider-stat"><span>${t('provider.rate_usage')}</span><strong>${p.rateLimit.createPerMinute ? (p.rateStatus?.currentCount || 0) + ' / ' + p.rateStatus?.maxPerWindow : '<span class="text-3">—</span>'}</strong></div>
          </div>
          ${features ? `<div class="provider-feature-line">${t('provider.features')}: ${features}</div>` : ''}
          <div class="provider-actions-row">
            ${iconBtn('globe', t('provider.domains'), on('click', 'showDomains', p.name), 'blue')}
            ${iconBtn('chart', t('provider.stats'), on('click', 'showProviderDetail', p.name), 'blue')}
            <div class="provider-config-row">
              <label class="provider-inline-check">
                <input type="checkbox" ${p.autoDispatch ? 'checked' : ''}${on('change', 'setAutoDispatch', p.name, CHECKED)}> ${t('provider.auto_dispatch')}
              </label>
            </div>
          </div>
          <div id="pex-${escAttr(p.name)}"></div>
        </div>`;
    };
    grid.innerHTML = groups.map(group => `
      <section class="provider-section">
        <div class="provider-section-title">${group.title}</div>
        <div class="provider-section-grid">${group.items.map(renderCard).join('')}</div>
      </section>
    `).join('');
    loadDispatchOrder();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleProvider(name, enabled) {
  try {
    await api(`/providers/${name}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    toast(enabled ? t('provider.toggled_on', {name}) : t('provider.toggled_off', {name}));
    addActivity(enabled ? 'blue' : 'amber', `${esc(enabled ? t('common.enable') : t('common.disable'))} <span class="activity-hl">${esc(name)}</span>`, true);
    loadProviders();
  } catch (e) { toast(e.message, 'error'); loadProviders(); }
}

// ─── Dispatch order ───
// The global list is edited in place; a row's eligibility comes from the
// preview endpoint, which is a pure read (no upstream calls).
let _dispatchOrder = [];
let _dispatchCandidates = new Map();
let _providerMeta = new Map();

function dispatchReasonChip(c) {
  if (!c) return '';
  if (c.eligible) return `<span class="badge"><span class="dot dot-ok"></span>${t('dispatch.eligible')}</span>`;
  let label = t('dispatch.reason.' + c.reason) || c.reason;
  if (c.reason === 'cooldown' && c.nextAvailableAt) label += ' ' + fmtTime(c.nextAvailableAt, 'short');
  return `<span class="dispatch-skip">${esc(label)}</span>`;
}

function tierLabel(p) {
  return t(p.tier === 'paid' ? 'provider.tier_paid' : p.type === 'alias' ? 'provider.tier_alias' : 'provider.tier_free');
}

function dispatchRowLabel(name, c) {
  const meta = _providerMeta.get(name);
  // Tier and manual-only are facts about the channel, not states: plain text.
  // A row skipped as manual-only already says so in its skip reason.
  const manual = meta && meta.autoDispatch === false && c?.reason !== 'manual_only' ? `<span class="text-3 fs-sm">${t('dispatch.manual_badge')}</span>` : '';
  const tier = meta ? `<span class="text-3 fs-sm">${tierLabel(meta)}</span>` : '';
  return `<span>${esc(meta?.displayName || name)}</span><span class="cell-sub mono">${esc(name)}</span>${tier}${manual}`;
}

function renderOrderRows(order, candidates, actions) {
  if (!order.length) return `<div class="empty"><p>${t('common.no_data')}</p></div>`;
  const grip = actions
    ? `<span class="dispatch-grip" title="${escAttr(t('dispatch.drag'))}" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="5" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/><circle cx="5" cy="8" r="1.5"/><circle cx="11" cy="8" r="1.5"/><circle cx="5" cy="13" r="1.5"/><circle cx="11" cy="13" r="1.5"/></svg></span>`
    : '';
  return order.map((name, i) => {
    const c = candidates.get(name);
    return `<div class="dispatch-row ${c && !c.eligible ? 'ineligible' : ''}">
      ${grip}<span class="dispatch-rank">${i + 1}</span>
      <span class="dispatch-name">${dispatchRowLabel(name, c)}${dispatchReasonChip(c)}</span>
      ${actions ? `<span class="dispatch-actions">${actions(name, i, order.length)}</span>` : ''}
    </div>`;
  }).join('');
}

function moveInList(list, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

function moveItem(list, from, to) {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

async function loadDispatchOrder() {
  if (!_isAdmin) { document.getElementById('dispatch-panel').hidden = true; return; }
  try {
    const preview = await api('/dispatch/preview');
    _dispatchOrder = preview.candidates.map(c => c.provider);
    _dispatchCandidates = new Map(preview.candidates.map(c => [c.provider, c]));
    document.getElementById('dispatch-source').textContent = t('dispatch.source_' + preview.rule.source);
    renderDispatchOrder();
  } catch (e) { toast(e.message, 'error'); }
}

function renderDispatchOrder() {
  const el = document.getElementById('dispatch-list');
  el.innerHTML = renderOrderRows(_dispatchOrder, _dispatchCandidates, (name, i, n) =>
    `<button class="btn btn-sm btn-icon" title="${escAttr(t('dispatch.up'))}" ${i === 0 ? 'disabled' : ''}${on('click', 'moveDispatch', i, -1)}>↑</button>
     <button class="btn btn-sm btn-icon" title="${escAttr(t('dispatch.down'))}" ${i === n - 1 ? 'disabled' : ''}${on('click', 'moveDispatch', i, 1)}>↓</button>`);
  attachSortable(el, (from, to) => { moveItem(_dispatchOrder, from, to); renderDispatchOrder(); });
}

async function saveDispatchOrder() {
  try {
    await api('/dispatch/rules/*', { method: 'PUT', body: JSON.stringify({ order: _dispatchOrder }) });
    toast(t('dispatch.saved'));
    addActivity('blue', t('dispatch.saved'));
    loadDispatchOrder();
  } catch (e) { toast(e.message, 'error'); }
}

async function resetDispatchOrder() {
  try {
    await api('/dispatch/rules/*', { method: 'DELETE' });
    toast(t('dispatch.reset_done'));
    loadDispatchOrder();
  } catch (e) { toast(e.message, 'error'); }
}

async function runDispatchPreview() {
  const svc = document.getElementById('dispatch-preview-for').value.trim();
  const el = document.getElementById('dispatch-preview-result');
  if (!svc) { el.innerHTML = ''; return; }
  try {
    const preview = await api(`/dispatch/preview?for=${encodeURIComponent(svc)}`);
    const cands = new Map(preview.candidates.map(c => [c.provider, c]));
    el.innerHTML = `<div class="dispatch-sub">${targetEl(svc)} · ${esc(t('dispatch.source_' + preview.rule.source))}${preview.rule.others === 'exclude' ? ' · ' + esc(t('dispatch.others_exclude')) : ''}</div>
      <div class="dispatch-list">${renderOrderRows(preview.candidates.map(c => c.provider), cands, null)}</div>
      <div class="dispatch-note">${esc(t('dispatch.preview_note'))}</div>`;
  } catch (e) { el.innerHTML = `<div class="dispatch-note tone-bad">${esc(e.message)}</div>`; }
}

// Per-service rule editor, rendered inside the service detail panel.
let _svcRule = null;

async function loadServiceDispatch(name) {
  const el = document.getElementById('svc-dispatch');
  if (!el) return;
  try {
    if (!_providerMeta.size) {
      const data = await api('/providers');
      _providerMeta = new Map((data.providers || []).filter(p => p.name).map(p => [p.name, p]));
    }
    const [rules, preview] = await Promise.all([api('/dispatch/rules'), api(`/dispatch/preview?for=${encodeURIComponent(name)}`)]);
    const own = (rules.rules || []).find(r => r.service === name);
    _svcRule = {
      service: name,
      custom: !!own,
      order: own ? [...own.order] : [],
      others: own ? own.others : 'append',
      candidates: new Map(preview.candidates.map(c => [c.provider, c])),
      effective: preview.candidates.map(c => c.provider),
      source: preview.rule.source,
    };
    renderServiceDispatch();
  } catch (e) { el.innerHTML = `<div class="dispatch-note tone-bad">${esc(e.message)}</div>`; }
}

// The dispatch editors' row controls: move, remove, add, and what happens to the unlisted.
function moveDispatch(i, by) { moveInList(_dispatchOrder, i, by); renderDispatchOrder(); }
function moveSvcRule(i, by) { moveInList(_svcRule.order, i, by); renderServiceDispatch(); }
function removeSvcRule(i) { _svcRule.order.splice(i, 1); renderServiceDispatch(); }
function addSvcRule(name) { if (name) { _svcRule.order.push(name); renderServiceDispatch(); } }
function setSvcRuleOthers(mode) { _svcRule.others = mode; }

function renderServiceDispatch() {
  const r = _svcRule;
  const el = document.getElementById('svc-dispatch');
  if (!r || !el) return;
  const listed = new Set(r.order);
  const addable = [..._providerMeta.keys()].filter(n => !listed.has(n));
  const editor = r.custom ? `
    <div class="dispatch-list" id="svc-dispatch-list">${renderOrderRows(r.order, r.candidates, (name, i, n) =>
      `<button class="btn btn-sm btn-icon" title="${escAttr(t('dispatch.up'))}" ${i === 0 ? 'disabled' : ''}${on('click', 'moveSvcRule', i, -1)}>↑</button>
       <button class="btn btn-sm btn-icon" title="${escAttr(t('dispatch.down'))}" ${i === n - 1 ? 'disabled' : ''}${on('click', 'moveSvcRule', i, 1)}>↓</button>
       ${iconBtn('x', t('dispatch.remove'), on('click', 'removeSvcRule', i), 'amber')}`)}</div>
    <div class="dispatch-toolbar">
      <select id="svc-dispatch-add"${on('change', 'addSvcRule', VALUE)}>
        <option value="">${esc(t('dispatch.add_provider'))}</option>
        ${addable.map(n => `<option value="${escAttr(n)}">${esc(_providerMeta.get(n)?.displayName || n)} (${esc(n)})</option>`).join('')}
      </select>
      <span class="cell-sub">${esc(t('dispatch.others'))}:</span>
      <label class="dispatch-radio"><input type="radio" name="svc-others" value="append" ${r.others === 'append' ? 'checked' : ''}${on('change', 'setSvcRuleOthers', 'append')}> ${esc(t('dispatch.others_append'))}</label>
      <label class="dispatch-radio"><input type="radio" name="svc-others" value="exclude" ${r.others === 'exclude' ? 'checked' : ''}${on('change', 'setSvcRuleOthers', 'exclude')}> ${esc(t('dispatch.others_exclude'))}</label>
      <button class="btn btn-primary btn-sm dispatch-save"${on('click', 'saveServiceDispatch')}>${esc(t('dispatch.save'))}</button>
    </div>` : `
    <div class="dispatch-list">${renderOrderRows(r.effective, r.candidates, null)}</div>`;
  el.innerHTML = `
    <div class="dispatch-sub">
      <span class="dispatch-mode">
        <button class="${r.custom ? '' : 'active'}"${on('click', 'setServiceDispatchMode', false)}>${esc(t('dispatch.follow_global'))}</button>
        <button class="${r.custom ? 'active' : ''}"${on('click', 'setServiceDispatchMode', true)}>${esc(t('dispatch.custom'))}</button>
      </span>
      <span>${esc(t('dispatch.source_' + r.source))}</span>
    </div>
    ${editor}
    <div class="dispatch-note">${esc(t('dispatch.preview_note'))}</div>`;
  attachSortable(document.getElementById('svc-dispatch-list'), (from, to) => { moveItem(_svcRule.order, from, to); renderServiceDispatch(); });
}

async function setServiceDispatchMode(custom) {
  const r = _svcRule;
  if (!r) return;
  if (!custom) {
    if (r.source === 'service') {
      try {
        await api(`/dispatch/rules/${encodeURIComponent(r.service)}`, { method: 'DELETE' });
        toast(t('dispatch.svc_reset', { name: r.service }));
      } catch (e) { toast(e.message, 'error'); return; }
    }
    return loadServiceDispatch(r.service);
  }
  r.custom = true;
  if (!r.order.length) r.order = r.effective.filter(n => _providerMeta.has(n));
  renderServiceDispatch();
}

async function saveServiceDispatch() {
  const r = _svcRule;
  if (!r) return;
  try {
    await api(`/dispatch/rules/${encodeURIComponent(r.service)}`, { method: 'PUT', body: JSON.stringify({ order: r.order, others: r.others }) });
    toast(t('dispatch.svc_saved', { name: r.service }));
    loadServiceDispatch(r.service);
  } catch (e) { toast(e.message, 'error'); }
}

async function setAutoDispatch(name, val) {
  try {
    await api(`/providers/${name}`, { method: 'PATCH', body: JSON.stringify({ autoDispatch: val }) });
    toast(val ? t('provider.dispatch_joined', {name}) : t('provider.dispatch_left', {name}));
    loadProviders();
  } catch (e) { toast(e.message, 'error'); loadProviders(); }
}

async function showDomains(name) {
  const el = document.getElementById(`pex-${name}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  try {
    const data = await api(`/providers/${name}/domains`);
    const domains = data.domains || [];
    const emptyHint = data.domainMode === 'from_create' ? t('provider.domains_on_create') : t('provider.none');
    el.innerHTML = `<div class="provider-extra"><strong class="text-2">${t('provider.available_domains')}</strong> ${domains.length ? domains.map(d => `<span class="domain-tag">${esc(d)}</span>`).join('') : '<span class="text-3">'+emptyHint+'</span>'}</div>`;
  } catch (e) { el.innerHTML = `<div class="provider-extra tone-bad">${esc(e.message)}</div>`; }
}

async function showProviderDetail(name) {
  const el = document.getElementById(`pex-${name}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  try {
    const data = await api(`/providers/${name}`);
    const s = data.stats || {};
    el.innerHTML = `<div class="provider-extra">
      <div class="provider-stat"><span>${t('provider.success_count')}</span><strong class="tone-ok">${s.success_count ?? 0}</strong></div>
      <div class="provider-stat"><span>${t('provider.fail_count')}</span><strong class="tone-bad">${s.fail_count ?? 0}</strong></div>
      ${s.last_success_at ? `<div class="provider-stat"><span>${t('provider.last_success')}</span><strong>${fmtTime(s.last_success_at, 'date')}</strong></div>` : ''}
      ${s.last_error_at ? `<div class="provider-stat"><span>${t('provider.last_fail')}</span><strong>${fmtTime(s.last_error_at, 'date')}</strong></div>` : ''}
      ${s.last_error ? `<div class="provider-stat"><span>${t('provider.last_error')}</span><strong class="tone-bad">${esc(s.last_error)}</strong></div>` : ''}
    </div>`;
  } catch (e) { el.innerHTML = `<div class="provider-extra tone-bad">${esc(e.message)}</div>`; }
}
export { addSvcRule, loadProviders, loadServiceDispatch, moveDispatch, moveSvcRule, removeSvcRule, resetDispatchOrder, runDispatchPreview, saveDispatchOrder, saveServiceDispatch, setAutoDispatch, setServiceDispatchMode, setSvcRuleOthers, showDomains, showProviderDetail, toggleProvider };
