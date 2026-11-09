// js/views/templates.js — template providers view.
import { _pageState, paginateTable } from '../components/pagination.js';
import { CHECKED, on } from '../core/actions.js';
import { api } from '../core/api.js';
import { confirmDialog, showDialog } from '../core/dialog.js';
import { t } from '../core/i18n.js';
import { motionDelay, setCount } from '../core/motion.js';
import { emptyStateRow, esc, iconBtn, renderLoading, toast, toggleSwitch } from '../core/util.js';
// ─── Template Providers ───
let _tplEditing = null;

const TPL_PRESETS = {
  bearer: {
    name: '', displayName: '', tier: 'free', trustLevel: 1,
    rateLimit: { createPerMinute: 2, pollPerMinute: 10 },
    retention: '1 小时', features: { customUsername: true, pollInbox: true, attachments: false },
    apiBase: 'https://api.mail.tm',
    auth: { type: 'none' }, extraHeaders: { 'Accept': 'application/ld+json' },
    domains: { mode: 'endpoint', path: '/domains', resultPath: 'hydra:member', domainField: 'domain', filter: { field: 'isActive', equals: true } },
    create: { path: '/accounts', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { address: 'address', authData: { id: 'id' } }, expiresIn: 3600 },
    postCreate: { path: '/token', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { authData: { token: 'token' } } },
    messages: { path: '/messages', method: 'GET', authFrom: 'inbox', authField: 'token', resultPath: 'hydra:member', itemMapping: { id: 'id', from: 'from.address', subject: 'subject', excerpt: 'intro', receivedAt: 'createdAt' } },
    messageDetail: { path: '/messages/{{messageId}}', method: 'GET', authFrom: 'inbox', authField: 'token', responseMapping: { id: 'id', from: 'from.address', subject: 'subject', text: 'text', html: 'html', receivedAt: 'createdAt' } },
    deleteInbox: { path: '/accounts/{{id}}', method: 'DELETE', authFrom: 'inbox', authField: 'token' }
  },
  apikey: {
    name: '', displayName: '', tier: 'free', trustLevel: 1,
    rateLimit: { createPerMinute: 2, pollPerMinute: 10 },
    retention: '24h', features: { customUsername: true, pollInbox: true, attachments: false },
    apiBase: 'https://api.example.com',
    auth: { type: 'header', headerName: 'X-Api-Key', value: 'YOUR_KEY' },
    domains: { mode: 'endpoint', path: '/domains', resultPath: '$root', domainField: 'domain' },
    create: { path: '/accounts', method: 'POST', body: { address: '{{address}}' }, responseMapping: { address: 'address', authData: { token: 'token' } } },
    messages: { path: '/messages', method: 'GET', authFrom: 'provider', resultPath: '$root', itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'excerpt', receivedAt: 'date' } },
    messageDetail: { path: '/messages/{{messageId}}', method: 'GET', authFrom: 'provider', responseMapping: { id: 'id', from: 'from', subject: 'subject', text: 'text', html: 'html', receivedAt: 'date' } }
  },
  noauth: {
    name: '', displayName: '', tier: 'free', trustLevel: 1,
    rateLimit: { createPerMinute: 3, pollPerMinute: 15 },
    retention: '10min', features: { customUsername: false, pollInbox: true, attachments: false },
    apiBase: 'https://api.example.com',
    auth: { type: 'none' },
    domains: { mode: 'from_create' },
    create: { path: '/inbox', method: 'POST', body: {}, responseMapping: { address: 'email', authData: { token: 'token' } }, expiresIn: 600 },
    messages: { path: '/inbox/{{token}}/messages', method: 'GET', authFrom: 'inbox', authField: 'token', resultPath: '$root', itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'text', receivedAt: 'received_at', text: 'text', html: 'html' } },
    messageDetail: { fromList: true, path: '', method: 'GET', authFrom: 'inbox', responseMapping: { id: 'id', from: 'from', subject: 'subject', text: 'text', html: 'html', receivedAt: 'received_at' } }
  },
  graphql: {
    // 把 token 拼到 apiBase 末尾；所有 endpoint 用 path:'' 直接 POST 到 apiBase。
    // 用 body.query 写 GraphQL 查询，可用 {{var}} 插值（vars: address/username/sessionId/...）。
    // resultPath / responseMapping 走 dot 路径（数组下标也用点号，例如 addresses.0.address）。
    name: '', displayName: '', tier: 'free', trustLevel: 1,
    rateLimit: { createPerMinute: 30, pollPerMinute: 30 },
    retention: '10min (auto-renew)', features: { customUsername: false, pollInbox: true, attachments: true },
    apiBase: 'https://example.com/graphql/PASTE_YOUR_TOKEN_HERE',
    auth: { type: 'none' },
    domains: { mode: 'endpoint', path: '', method: 'POST', body: { query: 'query { domains { name } }' }, resultPath: 'data.domains', domainField: 'name' },
    create: { path: '', method: 'POST', body: { query: 'mutation { introduceSession { id expiresAt addresses { address } } }' }, responseMapping: { address: 'data.introduceSession.addresses.0.address', authData: { sessionId: 'data.introduceSession.id' } } },
    messages: { path: '', method: 'POST', body: { query: 'query { session(id: "{{sessionId}}") { mails { id headerSubject headerFrom text html } } }' }, authFrom: 'provider', resultPath: 'data.session.mails', itemMapping: { id: 'id', from: 'headerFrom', subject: 'headerSubject', excerpt: 'text', receivedAt: '', text: 'text', html: 'html' } },
    messageDetail: { fromList: true, path: '', method: 'POST', authFrom: 'provider', responseMapping: { id: 'id', from: 'headerFrom', subject: 'headerSubject', text: 'text', html: 'html', receivedAt: '' } }
  }
};

let _allTemplates = [];

function renderTplTable(rows) {
  document.getElementById('tpl-list').innerHTML = rows.length ? rows.map(p => {
    return `<tr>
      <td>${esc(p.displayName || p.name)}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.apiBase || '')}</td>
      <td>${p.trustLevel || 1}</td>
      <td>${toggleSwitch(p.enabled, on('change', 'toggleTpl', p.name, CHECKED), p.enabled ? t('common.disable') : t('common.enable'))}</td>
      <td>
        ${iconBtn('edit', t('common.edit'), on('click', 'editTpl', p.name), 'blue')}
        ${iconBtn('test', t('common.test'), on('click', 'testTpl', p.name), 'blue')}
        ${iconBtn('trash', t('common.delete'), on('click', 'deleteTpl', p.name), 'danger')}
      </td>
    </tr>`;
  }).join('') : emptyStateRow(6, t('common.no_data'));
}

async function loadTemplates() {
  renderLoading('tpl-list', 6);
  try {
    const data = await api('/template-providers');
    _allTemplates = data.providers || [];
    setCount(document.getElementById('templates-count'), _allTemplates.length);
    delete _pageState['tpl'];
    paginateTable('tpl', _allTemplates, renderTplTable, 'tpl-pager');
  } catch (e) { toast(e.message, 'error'); }
}


// List and editor swap like a list and its detail: the side
// being left fades out first, and going back restores the list's scroll position.
let _tplListScroll = 0;

async function swapTplMode(editing) {
  const view = document.getElementById('v-templates');
  if (view.classList.contains('detail-mode') === editing) return;
  const scroller = document.querySelector('.main');
  if (editing) _tplListScroll = scroller.scrollTop;
  view.classList.add('leaving');
  await motionDelay(120);
  view.classList.remove('leaving');
  view.classList.toggle('detail-mode', editing);
  scroller.scrollTop = editing ? 0 : _tplListScroll;
}

function showTplEditor(cfg) {
  _tplEditing = cfg?.name || null;
  document.getElementById('tpl-editor-title').textContent = _tplEditing ? t('tpl.edit_title', { name: cfg.displayName || cfg.name }) : t('tpl.new');
  if (cfg) {
    syncCfgToForm(cfg);
    document.getElementById('tpl-json').value = JSON.stringify(cfg, null, 2);
  } else {
    document.getElementById('tpl-json').value = '{}';
    document.getElementById('tpl-preset').value = '';
    ['tpl-name','tpl-display','tpl-apibase','tpl-auth-header','tpl-auth-value'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('tpl-trust').value = '1';
    document.getElementById('tpl-tier').value = 'free';
    document.getElementById('tpl-rate-create').value = '2';
    document.getElementById('tpl-rate-poll').value = '10';
    document.getElementById('tpl-retention').value = '1 小时';
    document.getElementById('tpl-auth-type').value = 'none';
  }
  return swapTplMode(true);
}

function hideTplEditor() {
  _tplEditing = null;
  return swapTplMode(false);
}

function syncCfgToForm(cfg) {
  document.getElementById('tpl-name').value = cfg.name || '';
  document.getElementById('tpl-display').value = cfg.displayName || '';
  document.getElementById('tpl-apibase').value = cfg.apiBase || '';
  document.getElementById('tpl-tier').value = cfg.tier || 'free';
  document.getElementById('tpl-trust').value = cfg.trustLevel || 1;
  document.getElementById('tpl-retention').value = cfg.retention || '';
  document.getElementById('tpl-rate-create').value = cfg.rateLimit?.createPerMinute || 2;
  document.getElementById('tpl-rate-poll').value = cfg.rateLimit?.pollPerMinute || 10;
  document.getElementById('tpl-feat-username').checked = cfg.features?.customUsername || false;
  document.getElementById('tpl-feat-poll').checked = cfg.features?.pollInbox !== false;
  document.getElementById('tpl-feat-attach').checked = cfg.features?.attachments || false;
  document.getElementById('tpl-auth-type').value = cfg.auth?.type || 'none';
  document.getElementById('tpl-auth-header').value = cfg.auth?.headerName || cfg.auth?.queryParam || '';
  document.getElementById('tpl-auth-value').value = cfg.auth?.value || '';
}

function syncFormToJson() {
  let cfg = {};
  try { cfg = JSON.parse(document.getElementById('tpl-json').value || '{}'); } catch { /* fall back to empty config */ }
  cfg.name = document.getElementById('tpl-name').value.trim();
  cfg.displayName = document.getElementById('tpl-display').value.trim();
  cfg.apiBase = document.getElementById('tpl-apibase').value.trim();
  cfg.tier = document.getElementById('tpl-tier').value;
  cfg.trustLevel = parseInt(document.getElementById('tpl-trust').value) || 1;
  cfg.retention = document.getElementById('tpl-retention').value.trim();
  cfg.rateLimit = { createPerMinute: parseInt(document.getElementById('tpl-rate-create').value) || 2, pollPerMinute: parseInt(document.getElementById('tpl-rate-poll').value) || 10 };
  cfg.features = { customUsername: document.getElementById('tpl-feat-username').checked, pollInbox: document.getElementById('tpl-feat-poll').checked, attachments: document.getElementById('tpl-feat-attach').checked };
  const authType = document.getElementById('tpl-auth-type').value;
  cfg.auth = { type: authType };
  if (authType === 'header') cfg.auth.headerName = document.getElementById('tpl-auth-header').value.trim();
  if (authType === 'query') cfg.auth.queryParam = document.getElementById('tpl-auth-header').value.trim();
  if (authType !== 'none') cfg.auth.value = document.getElementById('tpl-auth-value').value.trim();
  document.getElementById('tpl-json').value = JSON.stringify(cfg, null, 2);
}

function syncJsonToForm() {
  try {
    const cfg = JSON.parse(document.getElementById('tpl-json').value);
    syncCfgToForm(cfg);
    toast(t('toast.synced'));
  } catch (e) { toast(t('tpl.json_error') + e.message, 'error'); }
}

function applyTplPreset(key) {
  if (!key) return;
  const preset = TPL_PRESETS[key];
  if (!preset) return;
  const cfg = JSON.parse(JSON.stringify(preset));
  syncCfgToForm(cfg);
  document.getElementById('tpl-json').value = JSON.stringify(cfg, null, 2);
  toast(t('toast.tpl_loaded'));
}

async function saveTplProvider() {
  syncFormToJson();
  let cfg;
  try { cfg = JSON.parse(document.getElementById('tpl-json').value); } catch (e) { return toast(t('validate.json_error'), 'error'); }
  if (!cfg.name) return toast(t('validate.need_name'), 'error');
  if (!cfg.apiBase) return toast(t('validate.need_api_base'), 'error');
  const st = document.getElementById('tpl-save-status');
  st.textContent = t('common.loading');
  try {
    if (_tplEditing) {
      await api(`/template-providers/${_tplEditing}`, { method: 'PUT', body: JSON.stringify({ config: cfg }) });
    } else {
      await api('/template-providers', { method: 'POST', body: JSON.stringify({ config: cfg }) });
    }
    st.textContent = '';
    toast(t('toast.saved'));
    hideTplEditor();
    loadTemplates();
  } catch (e) { st.textContent = ''; toast(e.message, 'error'); }
}

function showTestResults(data, configName, { confirmed = true, disabled = false } = {}) {
  const stepNames = { getDomains: t('provider.domains'), createInbox: t('inbox.create'), getMessages: t('inbox.receive') };
  const stepErrors = { 'No available domains': 'tpl.test_no_domains', 'Template domain discovery failed': 'tpl.test_domains_failed', 'Template inbox creation requires recovery': 'tpl.test_create_recovery', 'Template message read failed': 'tpl.test_messages_failed' };
  const lines = (data.steps || []).map(s => {
    const icon = s.ok ? '✓' : '✗';
    const name = stepNames[s.step] || s.step;
    let detail = s.detail;
    const domains = s.step === 'getDomains' && /^(\d+) domains: (.*)$/.exec(detail || '');
    const messages = s.step === 'getMessages' && /^(\d+) messages$/.exec(detail || '');
    if (domains) detail = t('tpl.test_domain_count', { count: domains[1], domains: domains[2] });
    if (messages) detail = t('tpl.test_message_count', { count: messages[1] });
    const error = Object.hasOwn(stepErrors, s.error) ? t(stepErrors[s.error]) : s.error;
    return `<div class="tpl-test-step"><span class="${s.ok ? 'tone-ok' : 'tone-bad'} fw-semibold">${icon}</span> ${esc(name)}${detail ? ` <span class="text-3">— ${esc(detail)}</span>` : ''}${error ? ` <span class="tone-bad">— ${esc(error)}</span>` : ''}</div>`;
  }).join('');
  const configKey = !confirmed ? 'tpl.test_config_unconfirmed' : disabled ? 'tpl.test_config_retained_disabled' : 'tpl.test_config_retained';
  const configNotice = `<p>${esc(t(configKey, { name: configName }))}</p>`;
  let recoveryNotice = '';
  if (data.recovery) {
    const recovery = data.recovery;
    const phases = ['attempting', 'upstream_created', 'auth_pending', 'ready', 'claimed', 'outcome_unknown'];
    const phase = phases.includes(recovery.phase) ? recovery.phase : 'outcome_unknown';
    const hint = recovery.operationActive ? 'active' : recovery.canRetry ? 'retry' : recovery.canClaim ? 'claim' : 'inspect';
    recoveryNotice = `<p>${esc(t('tpl.test_asset_retained'))}</p>
      <div class="tpl-test-step">${esc(t('tpl.test_recovery_id', { id: recovery.id }))}</div>
      <div class="tpl-test-step">${esc(t('tpl.test_recovery_phase', { phase: t('tpl.test_phase_' + phase) }))}</div>
      <p class="form-hint">${esc(t('tpl.test_recovery_' + hint))}${disabled ? ` ${esc(t('tpl.test_recovery_disabled'))}` : ''}</p>`;
  }
  const requestNotice = data.requestInterrupted ? `<p class="tone-warn">${esc(t('tpl.test_request_interrupted'))}</p>` : '';
  showDialog(data.success ? t('common.success') : t('common.fail'), configNotice + lines + recoveryNotice + requestNotice, `<button class="btn" data-no-loading${on('click', 'hideDialog')}>${t('common.close')}</button>`);
}

async function testTpl(name) {
  const disabled = _allTemplates.find(provider => provider.name === name)?.enabled === false;
  toast(t('toast.testing'));
  try {
    const data = await api(`/template-providers/${name}/test`, { method: 'POST' });
    showTestResults(data, name, { disabled });
  } catch {
    showTestResults({ success: false, requestInterrupted: true }, name, { disabled });
  }
}

async function testTplProvider() {
  syncFormToJson();
  let cfg;
  try { cfg = JSON.parse(document.getElementById('tpl-json').value); } catch { return toast(t('validate.json_error'), 'error'); }
  cfg.name = '_test_' + Date.now();
  toast(t('toast.testing'));
  let created = false;
  try {
    await api('/template-providers', { method: 'POST', body: JSON.stringify({ config: cfg, enabled: false }) });
    created = true;
    const data = await api(`/template-providers/${cfg.name}/test`, { method: 'POST' });
    showTestResults(data, cfg.name, { disabled: true });
  } catch {
    showTestResults({ success: false, requestInterrupted: true }, cfg.name, { confirmed: created, disabled: true });
  } finally {
    // A lost response can still leave a saved config. Keep it available in the
    // existing list so the operator can return to its recovery records.
    loadTemplates();
  }
}

async function editTpl(name) {
  try {
    const data = await api(`/template-providers/${name}`);
    showTplEditor(data.config);
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleTpl(name, enabled) {
  try {
    await api(`/template-providers/${name}/toggle`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    toast(enabled ? t('op.enabled') : t('op.disabled'));
    loadTemplates();
  } catch (e) { toast(e.message, 'error'); loadTemplates(); }
}

async function deleteTpl(name) {
  if (!await confirmDialog(t('dialog.confirm_delete'), t('dialog.delete_tpl', {name}))) return;
  try {
    await api(`/template-providers/${name}`, { method: 'DELETE' });
    toast(t('toast.deleted'));
    loadTemplates();
  } catch (e) { toast(e.message, 'error'); }
}
export { applyTplPreset, deleteTpl, editTpl, hideTplEditor, loadTemplates, saveTplProvider, showTplEditor, syncFormToJson, syncJsonToForm, testTpl, testTplProvider, toggleTpl };
