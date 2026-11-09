// js/boot.js — everything that runs at load time, in its original order; loaded last.
import { addActivity } from './components/activity.js';
import { initConfigCard, openConfigTab, selectConfigTab } from './components/config-card.js';
import { initDragSelect } from './components/drag-select.js';
import { toggleFoldPanel } from './components/fold.js';
import { _changePageSize, _goPage } from './components/pagination.js';
import { _rowMenu, closeRowMenu, runMenuItem, toggleRowMenu } from './components/row-menu.js';
import { scopeSwitch } from './components/scope-tabs.js';
import { actions, initActions, on } from './core/actions.js';
import { api } from './core/api.js';
import { answerConfirm, hideDialog, showDialog } from './core/dialog.js';
import { applyTheme, t, toggleLang, toggleTheme } from './core/i18n.js';
import { initLoadingBlocks } from './core/loading-blocks.js';
import { clickById, copyText, debounce, getToken, selectText, toast } from './core/util.js';
import { initNavInd, switchViewWithTransition, syncNavInd } from './shell/nav-indicator.js';
import { setNavRail } from './shell/nav-rail.js';
import { closeMobileMore, enhanceNavA11y, loadView, refreshCurrentView, setupMobileNav } from './shell/navigation.js';
import { doLogin, doLogout, enterApp } from './shell/session.js';
import { addBlock, addBlockRule, deleteBlock, deleteRule, doDeleteBlock, loadBlocks, toggleRule } from './views/blocks.js';
import { filterDashTable, switchAndCode, switchAndView, switchAndViewMailbox } from './views/dashboard.js';
import { copyLlmsUrl, loadDocsMarkup, scrollDoc, toggleParentOpen } from './views/docs.js';
import { copyGmailAliases, renderGmailAliases, toggleGmailRule } from './views/gmail-tool.js';
import { addIcloudAccount, applyIcloudHostPreset, deleteIcloudAccount, generateIcloud, loadIcloudAccounts, loadIcloudAddresses, readIcloudMessage, refreshIcloudCookies, renderIcloudAccounts, renderIcloudAddresses, retireIcloudAddress, saveIcloudPoolSettings, srpAnswer, srpAnswerFrom, srpIcloudLogin, srpSendSms, suggestIcloudImapHost, testIcloudAccount, viewIcloudMailbox } from './views/icloud.js';
import { addImapAccount, deleteImapAccount, deleteImapSelected, loadImapAccounts, testImapAccount, toggleAllImap } from './views/imap.js';
import { batchCloseInbox, batchReportInbox, closeInbox, createInbox, doClose, exitInboxDetail, fitMsgFrame, getCode, invalidateCodeView, loadEarlierMailbox, loadInboxes, readMailboxMessage, readMessage, reportInbox, resetCodeSession, toggleAllInbox, viewInbox, viewMailbox } from './views/inboxes.js';
import { copyKeySecret, createKey, deleteKey, doDeleteKey, setKeyQuota, toggleKey, toggleKeySecret } from './views/keys.js';
import { batchCheckOutlook, batchDeleteOutlook, batchRenewOutlook, checkSingleOl, copyOutlookOauthPassword, deleteOlAccount, doBatchDeleteOl, doDeleteOl, filterOlAccounts, importOutlook, loadOutlook, loadOutlookAccounts, placeOutlookOauthPanel, renewSingleOl, saveOlSettings, startOutlookOauth, submitOutlookOauthFinalUrl, toggleAllOl } from './views/outlook.js';
import { addSvcRule, moveDispatch, moveSvcRule, removeSvcRule, resetDispatchOrder, runDispatchPreview, saveDispatchOrder, saveServiceDispatch, setAutoDispatch, setServiceDispatchMode, setSvcRuleOthers, showDomains, showProviderDetail, toggleProvider } from './views/providers.js';
import { closeServiceDetail, filterServices, loadServiceDetail } from './views/services.js';
import { checkForUpdates, deleteBackup, resetProxyUrl, saveSettings, triggerBackup, updateProxySource } from './views/settings.js';
import { applyTplPreset, deleteTpl, editTpl, hideTplEditor, saveTplProvider, showTplEditor, syncFormToJson, syncJsonToForm, testTpl, testTplProvider, toggleTpl } from './views/templates.js';
import { batchCheckYyds, batchDeleteYyds, checkSingleYd, deleteYdAccount, doBatchDeleteYd, doDeleteYd, importYyds, loadYyds, toggleAllYd, toggleYdStatus, toggleYdWildcard } from './views/yyds.js';
applyTheme();
window.filterDashTableDebounced = debounce(filterDashTable, 200);
window.loadBlocksDebounced = debounce(loadBlocks, 200);
// ─── Event delegation ───
// Every handler the markup names through data-on-* (js/core/actions.js); a name
// missing here fails tests/admin-spa-actions.test.ts.
actions({
  _changePageSize, _goPage, addBlock, addBlockRule, addIcloudAccount, addImapAccount, addSvcRule,
  answerConfirm, applyIcloudHostPreset, applyTplPreset, batchCheckOutlook, batchCheckYyds,
  batchCloseInbox, batchDeleteOutlook, batchDeleteYyds, batchRenewOutlook, batchReportInbox,
  checkForUpdates, checkSingleOl, checkSingleYd, clickById, closeInbox, closeServiceDetail,
  copyGmailAliases, copyKeySecret, copyLlmsUrl, copyOutlookOauthPassword, copyText, createInbox,
  createKey, deleteBackup, deleteBlock, deleteIcloudAccount, deleteImapAccount, deleteImapSelected,
  deleteKey, deleteOlAccount, deleteRule, deleteTpl, deleteYdAccount, doBatchDeleteOl,
  doBatchDeleteYd, doClose, doDeleteBlock, doDeleteKey, doDeleteOl, doDeleteYd, doLogin, doLogout,
  editTpl, exitInboxDetail, filterDashTableDebounced: window.filterDashTableDebounced,
  filterOlAccounts, filterServices, fitMsgFrame, generateIcloud, getCode, resetCodeSession, hideDialog,
  hideTplEditor, importOutlook, importYyds, loadBlocksDebounced: window.loadBlocksDebounced,
  loadEarlierMailbox, loadDocsMarkup, loadIcloudAccounts, loadIcloudAddresses, loadImapAccounts, loadInboxes,
  loadOutlook, loadOutlookAccounts, loadServiceDetail, loadYyds, moveDispatch, moveSvcRule,
  openConfigTab, readIcloudMessage, readMailboxMessage, readMessage, refreshCurrentView,
  refreshIcloudCookies, removeSvcRule, renderGmailAliases, renderIcloudAccounts,
  renderIcloudAddresses, renewSingleOl, reportInbox, resetDispatchOrder, resetProxyUrl,
  retireIcloudAddress, runDispatchPreview, runMenuItem, saveDispatchOrder, saveIcloudPoolSettings,
  saveOlSettings, saveServiceDispatch, saveSettings, saveTplProvider, scopeSwitch, scrollDoc,
  selectConfigTab, selectText, setAutoDispatch, setKeyQuota, setServiceDispatchMode,
  setSvcRuleOthers, showDomains, showProviderDetail, showTplEditor, srpAnswer, srpAnswerFrom,
  srpIcloudLogin, srpSendSms, startOutlookOauth, submitOutlookOauthFinalUrl, suggestIcloudImapHost,
  switchAndCode, switchAndView, switchAndViewMailbox, syncFormToJson, syncJsonToForm,
  testIcloudAccount, testImapAccount, testTpl, testTplProvider, toggleAllImap, toggleAllInbox,
  toggleAllOl, toggleAllYd, toggleFoldPanel, toggleGmailRule, toggleKey, toggleKeySecret,
  toggleLang, toggleParentOpen, toggleProvider, toggleRowMenu, toggleRule, toggleTheme, toggleTpl,
  toggleYdStatus, toggleYdWildcard, triggerBackup, updateProxySource, viewIcloudMailbox, viewInbox,
  viewMailbox
});
initActions();
document.addEventListener('pointerdown', e => {
  if (_rowMenu && !_rowMenu.menu.contains(e.target) && !_rowMenu.btn.contains(e.target)) closeRowMenu();
}, true);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !_rowMenu) return;
  const btn = _rowMenu.btn;
  closeRowMenu();
  btn.focus();
});
window.addEventListener('resize', () => closeRowMenu(true));
document.querySelector('.main')?.addEventListener('scroll', () => closeRowMenu(true), { passive: true });
initLoadingBlocks();

// ─── Button loading state ───
document.addEventListener('click', e => {
  const btn = e.target.closest('.btn');
  if (!btn || btn.hasAttribute('data-loading') || btn.disabled) return;
  if (btn.hasAttribute('data-no-loading')) return;
  const fn = btn.onclick;
  if (!fn) return;
  e.stopImmediatePropagation();
  btn.onclick = null;
  btn.setAttribute('data-loading', '');
  btn.disabled = true;
  const done = () => { btn.removeAttribute('data-loading'); btn.disabled = btn.dataset.batchBusy === '1'; btn.onclick = fn; };
  let result;
  try { result = fn.call(btn, e); } catch(err) { done(); return; }
  if (result && typeof result.then === 'function') {
    result.catch((err) => {
      console.warn('Button action failed', err);
    }).finally(done);
  } else {
    done();
  }
}, true);
document.querySelectorAll('.nav-icon[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    invalidateCodeView();
    const from = document.querySelector('.nav-icon[data-view].active');
    switchViewWithTransition(from, btn, () => {
      document.querySelectorAll('.nav-icon').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('v-' + btn.dataset.view).classList.add('active');
      syncNavInd(true);
      closeMobileMore();
      // Navigating to 收件箱 means "show me the list", never "put me back in the
      // detail I was reading". Scroll to the top rather than the stale position.
      if (btn.dataset.view === 'inboxes') exitInboxDetail(false, false);
      loadView(btn.dataset.view);
    }).then(() => setNavRail(btn.dataset.view === 'docs'));
  });
});
enhanceNavA11y();
setupMobileNav();
initNavInd();
// Config cards start folded: the list is what each view is for, and every pixel
// above it is a pixel of scrolling between a click and its result.
document.querySelectorAll('.config-card').forEach(card => initConfigCard(card.id));

// ─── Keyboard shortcuts ───
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('overlay')?.classList.contains('show')) return hideDialog();
    if (document.body.classList.contains('mobile-more-open')) return closeMobileMore();
  }
  if (e.altKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const visible = [...document.querySelectorAll('.nav-icon[data-view]')]
      .filter(el => el.offsetParent !== null);
    const idx = parseInt(e.key) - 1;
    if (idx < visible.length) visible[idx].click();
  }
  if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
  let list = [...document.querySelectorAll('.nav-icon[data-view]')]
      .filter(el => el.offsetParent !== null)
      .slice(0, 9)
      .map((el, i) => `<div class="shortcut-row"><kbd class="key-cap">Alt+${i + 1}</kbd> <span>${el.closest('.tooltip-wrap')?.querySelector('.tooltip')?.textContent || el.dataset.view}</span></div>`)
      .join('');
    showDialog(t('settings.shortcuts'), `<div class="fs-base">${list}</div>`, `<button class="btn btn-primary"${on('click', 'hideDialog')}>${t('common.close')}</button>`);
  }
});
document.getElementById('overlay').addEventListener('click', e => { if (e.target === e.currentTarget) hideDialog(); });
initDragSelect();

// ─── Init ───
// Visibility is already settled by the head script; this is the data side of
// entering the app (admin probe, dashboard load, i18n).
if (getToken()) enterApp();

Object.assign(window, { api, toast, addActivity, loadOutlook, scrollDoc });
loadDocsMarkup().then(function loadOptionalExtensions() {
  const script = document.createElement('script');
  script.src = '/extensions.js';
  script.onload = placeOutlookOauthPanel;
  script.onerror = placeOutlookOauthPanel;
  document.body.appendChild(script);
});
