// js/core/api.js — API client and batch-job polling.
import { t } from './i18n.js';
import { API, getToken, toast } from './util.js';
import { _isAdmin, doLogout } from '../shell/session.js';
import { loadOutlookAccounts, loadOutlookStats } from '../views/outlook.js';
import { loadYydsAccounts, loadYydsStats } from '../views/yyds.js';
async function api(path, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) { doLogout(); throw new Error('Unauthorized'); }
  let data;
  try { data = await res.json(); } catch { throw new Error(`HTTP ${res.status}`); }
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// GET /api/inboxes is server-paginated (default pageSize 50, max 100) while the
// tables here paginate client-side over a full array. Without this, the UI
// silently showed only the newest 50 rows and the pager reported 50 as the
// total. Walk the pages using the `total` the endpoint returns.
async function apiAllInboxes(path) {
  // Callers build query strings that can end in '?' or '&'; normalize so the
  // paging params always append cleanly.
  const base = path.replace(/[?&]+$/, '');
  const sep = base.includes('?') ? '&' : '?';
  const PAGE_SIZE = 100;
  const first = await api(`${base}${sep}page=1&pageSize=${PAGE_SIZE}`);
  const rows = first.inboxes || [];
  const total = Number(first.total);
  if (!Number.isFinite(total) || total <= rows.length) return { ...first, inboxes: rows };
  const lastPage = Math.ceil(total / PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, i) => api(`${base}${sep}page=${i + 2}&pageSize=${PAGE_SIZE}`)),
  );
  for (const page of rest) rows.push(...(page.inboxes || []));
  return { ...first, inboxes: rows };
}

// Short requests track durable batch jobs independently of the current view.
const poolJobs = new Map();
const poolJobPollers = new Map();

function lockPoolButtons(pool, busy) {
  document.querySelectorAll(`[data-batch-pool="${pool}"]`).forEach(btn => {
    btn.dataset.batchBusy = busy ? '1' : '0';
    btn.disabled = busy || btn.hasAttribute('data-loading');
  });
}

function renderPoolJob(job, retrying = false) {
  const previous = poolJobs.get(job.pool);
  if (previous && (job.createdAt < previous.createdAt || (job.id === previous.id && job.updatedAt < previous.updatedAt))) return false;
  poolJobs.set(job.pool, job);
  const action = job.kind === 'outlook-renew' ? t('outlook.batch_renew')
    : job.pool === 'outlook' ? t('outlook.batch_check') : t('yyds.batch_check');
  const summary = job.summary;
  const counts = t(job.kind === 'outlook-renew' ? 'batch.renew_counts' : 'batch.counts', summary);
  document.getElementById(`${job.pool}-batch-progress`).hidden = false;
  document.getElementById(`${job.pool}-batch-text`).textContent = t('batch.progress', {
    action, state: t(`batch.${job.status}`), done: job.completed, total: job.total,
  }) + ' · ' + counts + (retrying ? ' · ' + t('batch.retrying') : '');
  const bar = document.getElementById(`${job.pool}-batch-bar`);
  bar.max = Math.max(1, job.total);
  bar.value = job.total ? job.completed : job.status === 'completed' ? 1 : 0;
  bar.setAttribute('aria-label', action);
  lockPoolButtons(job.pool, job.status === 'running');
  return true;
}

function watchPoolJob(job) {
  if (!renderPoolJob(job)) return;
  const existing = poolJobPollers.get(job.pool);
  if (existing?.id === job.id) return;
  if (existing) clearTimeout(existing.timer);
  poolJobPollers.delete(job.pool);
  if (job.status !== 'running') return;
  const poller = { id: job.id, timer: null };
  poolJobPollers.set(job.pool, poller);
  const poll = async () => {
    if (poolJobPollers.get(job.pool) !== poller) return;
    let delay = 2000;
    try {
      const data = await api(`/batch-jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (poolJobPollers.get(job.pool) !== poller) return;
      renderPoolJob(data.job);
      if (data.job.status !== 'running') {
        poolJobPollers.delete(job.pool);
        toast(t(`batch.${data.job.status}`), data.job.status === 'completed' ? 'success' : 'error');
        if (job.pool === 'outlook') await Promise.all([loadOutlookStats(), loadOutlookAccounts()]);
        else await Promise.all([loadYydsStats(), loadYydsAccounts()]);
        return;
      }
    } catch (e) {
      if (poolJobPollers.get(job.pool) !== poller) return;
      renderPoolJob(poolJobs.get(job.pool), true);
      delay = 4000;
    }
    if (poolJobPollers.get(job.pool) === poller) poller.timer = setTimeout(poll, delay);
  };
  poller.timer = setTimeout(poll, 2000);
}

async function restorePoolJob(pool) {
  if (!_isAdmin) return;
  try {
    const data = await api(`/batch-jobs?pool=${pool}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!_isAdmin) return;
    if (!data.jobs.length && !poolJobs.has(pool)) {
      document.getElementById(`${pool}-batch-progress`).hidden = true;
      lockPoolButtons(pool, false);
    }
    data.jobs.forEach(watchPoolJob);
  } catch (e) {
    if (!_isAdmin || poolJobPollers.has(pool)) return;
    console.warn('Batch progress lookup failed', e);
    const previous = poolJobs.get(pool);
    if (previous) renderPoolJob(previous, true);
    else {
      document.getElementById(`${pool}-batch-progress`).hidden = false;
      document.getElementById(`${pool}-batch-text`).textContent = t('batch.retrying');
    }
    const poller = { id: null, timer: null };
    poolJobPollers.set(pool, poller);
    poller.timer = setTimeout(() => {
      if (poolJobPollers.get(pool) !== poller) return;
      poolJobPollers.delete(pool);
      void restorePoolJob(pool);
    }, 4000);
  }
}

async function beginPoolJob(path, body) {
  const pool = path.startsWith('/outlook/') ? 'outlook' : 'yyds';
  if (poolJobs.get(pool)?.status === 'running') return toast(t('batch.busy'), 'error');
  lockPoolButtons(pool, true);
  try {
    const data = await api(path, { method: 'POST', body: JSON.stringify({ ...body, background: true }), signal: AbortSignal.timeout(10000) });
    watchPoolJob(data.job);
    toast(t('batch.started'));
  } catch (e) {
    toast(t('batch.start_uncertain') + ': ' + e.message, 'error');
    await restorePoolJob(pool);
  } finally {
    lockPoolButtons(pool, poolJobs.get(pool)?.status === 'running');
  }
}

function stopPoolJobPolling() {
  poolJobPollers.forEach(poller => clearTimeout(poller.timer));
  poolJobPollers.clear();
  poolJobs.clear();
  for (const pool of ['outlook', 'yyds']) {
    document.getElementById(`${pool}-batch-progress`).hidden = true;
    lockPoolButtons(pool, false);
  }
}
export { api, apiAllInboxes, beginPoolJob, restorePoolJob, stopPoolJobPolling };
