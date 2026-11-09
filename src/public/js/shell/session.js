// js/shell/session.js — login, logout, entering the app.
import { api, stopPoolJobPolling } from '../core/api.js';
import { applyLang, t } from '../core/i18n.js';
import { API } from '../core/util.js';
import { clearCodeSession } from '../views/inboxes.js';
import { closeMobileMore, refreshMobileMoreChrome, refreshNavLabels } from './navigation.js';
import { loadDashboard } from '../views/dashboard.js';
// ─── Login / Logout ───
// Whether the token is the admin secret; set by enterApp() and logout, read across the app.
let _isAdmin = false;
window.addEventListener('storage', event => {
  if (event.key === 'token' || event.key === null) clearCodeSession();
});
async function doLogin(event) {
  if (event?.preventDefault) event.preventDefault();
  const token = document.getElementById('login-token').value.trim();
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  if (!token) { errEl.textContent = t('login.enter_key'); return false; }
  btn.disabled = true;
  errEl.textContent = '';
  try {
    const res = await fetch(API + '/providers', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(t('login.invalid_key'));
    localStorage.setItem('token', token);
    enterApp();
  } catch (e) {
    errEl.textContent = e.message || t('login.failed');
  } finally { btn.disabled = false; }
  return false;
}

function doLogout() {
  clearCodeSession();
  stopPoolJobPolling();
  localStorage.removeItem('token');
  _isAdmin = false;
  closeMobileMore();
  document.documentElement.classList.remove('authed');
  document.getElementById('login-token').value = '';
  document.getElementById('login-error').textContent = '';
}

async function enterApp() {
  clearCodeSession();
  // Idempotent on reload (the head script already set it); the load-bearing
  // case is a fresh sign-in, where no token existed when the page opened.
  document.documentElement.classList.add('authed');
  try {
    await api('/keys');
    _isAdmin = true;
  } catch { _isAdmin = false; }
  for (const id of ['nav-keys', 'nav-settings', 'nav-services', 'nav-templates']) document.getElementById(id).hidden = !_isAdmin;
  loadDashboard();
  applyLang();
  refreshNavLabels();
  refreshMobileMoreChrome();
}
export { _isAdmin, doLogin, doLogout, enterApp };
