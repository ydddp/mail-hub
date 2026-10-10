import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';
import { getDb, initDb, setSetting } from '../src/db.js';
import { hashApiKey } from '../src/crypto.js';
import { cleanupExpired } from '../src/app.js';
import { startBatchJob } from '../src/batch-jobs.js';

const cases = [
  ['outlook/check', 'outlook-check'],
  ['outlook/renew', 'outlook-renew'],
  ['yyds/check', 'yyds-check'],
] as const;

function seed() {
  const db = getDb();
  for (const n of [1, 2]) {
    db.prepare(`INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
      VALUES (?, 'secret-password', 'secret-client', ?, 'valid')`).run(`test${n}@outlook.com`, `secret-refresh-${n}`);
    db.prepare(`INSERT INTO yyds_accounts (api_key) VALUES (?)`).run(`secret-key-${n}`);
  }
  setSetting('batch_concurrency', '1');
}

async function post(path: string, body: object = { background: true }) {
  return app.request(`/api/${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
}

async function job(id: string) {
  const res = await app.request(`/api/batch-jobs/${id}`, { headers: authHeaders() });
  expect(res.status).toBe(200);
  return (await res.json()).job;
}

// Every request is held until explicitly released, reproducing a slow upstream
// without waiting minutes or touching production accounts.
function slowUpstream() {
  const pending: Array<() => void> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    await new Promise<void>(resolve => pending.push(resolve));
    const token = String(url).includes('/token');
    return new Response(JSON.stringify(token ? { access_token: 'secret-access' } : {}), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    async finish() {
      for (let i = 0; i < 25; i++) {
        pending.splice(0).forEach(resolve => resolve());
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    release() { pending.splice(0).forEach(resolve => resolve()); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('background pool operations', () => {
  it.each(cases)('%s returns before upstream finishes and persists progress', async (path, kind) => {
    seed();
    const upstream = slowUpstream();
    const started = post(path);
    const early = await Promise.race([started, new Promise<null>(resolve => setTimeout(() => resolve(null), 60))]);
    if (!early || early.status !== 202) {
      await upstream.finish();
      await started;
      expect(early?.status).toBe(202);
      return;
    }
    try {
      const initial = (await early.json()).job;
      expect(initial).toMatchObject({ kind, status: 'running', total: 2, completed: 0 });
      const reused = await post(path);
      expect(reused.status).toBe(202);
      expect((await reused.json()).job.id).toBe(initial.id);
      expect(await job(initial.id)).toMatchObject({ completed: 0, status: 'running' });
      await vi.waitFor(() => expect(upstream.fetchMock).toHaveBeenCalled());
      upstream.release();
      if (kind.startsWith('outlook')) {
        await vi.waitFor(() => expect(upstream.fetchMock).toHaveBeenCalledTimes(2));
        upstream.release();
      }
      await vi.waitFor(async () => expect(await job(initial.id)).toMatchObject({ completed: 1, status: 'running' }));
      await upstream.finish();
      expect(await job(initial.id)).toMatchObject({ completed: 2, status: 'completed' });
      const latest = await app.request(`/api/batch-jobs?pool=${kind.split('-')[0]}`, { headers: authHeaders() });
      expect((await latest.json()).jobs.some((j: { id: string }) => j.id === initial.id)).toBe(true);
      const stored = getDb().prepare('SELECT * FROM batch_jobs WHERE id = ?').get(initial.id);
      expect(JSON.stringify(stored)).not.toMatch(/secret-(?:password|client|refresh|access|key)/);
      expect(JSON.stringify(await job(initial.id))).not.toContain('results');
    } finally {
      await upstream.finish();
    }
  });

  it('rejects competing Outlook work without starting another upstream request', async () => {
    seed();
    const upstream = slowUpstream();
    const started = post('outlook/check');
    const early = await Promise.race([started, new Promise<null>(resolve => setTimeout(() => resolve(null), 60))]);
    if (!early) { await upstream.finish(); await started; expect(early).not.toBeNull(); return; }
    try {
      expect((await post('outlook/renew')).status).toBe(409);
      expect((await post('outlook/check', { background: true, emails: ['test1@outlook.com'] })).status).toBe(409);
      expect((await post('outlook/renew', { emails: ['test1@outlook.com'] })).status).toBe(409);
    } finally { await upstream.finish(); }
  });

  it('requires admin access for job state', async () => {
    getDb().prepare('INSERT INTO api_keys (key, name) VALUES (?, ?)').run(hashApiKey('user-key'), 'user');
    for (const path of ['/api/batch-jobs?pool=outlook', '/api/batch-jobs/missing']) {
      expect((await app.request(path, { headers: authHeaders('user-key') })).status).toBe(403);
      expect((await app.request(path, { headers: authHeaders() })).status).toBe(path.includes('?') ? 200 : 404);
    }
  });

  it.each(cases)('%s keeps infrastructure failures unknown', async (path) => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('upstream unreachable'); }));
    const response = await post(path);
    expect(response.status).toBe(202);
    const id = (await response.json()).job.id;
    await vi.waitFor(async () => expect(await job(id)).toMatchObject({ status: 'completed', completed: 2 }));
    expect((await job(id)).summary.unknown).toBe(2);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM outlook_accounts WHERE token_status = 'valid'`).get()).toEqual({ n: 2 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM yyds_accounts WHERE status = 'active'`).get()).toEqual({ n: 2 });
  });

  it.each([429, 500, 502, 503, 524])('YYDS HTTP %s preserves stored key status as unknown', async status => {
    seed();
    getDb().prepare(`UPDATE yyds_accounts SET status = 'disabled'`).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream temporarily unavailable', { status })));
    const response = await post('yyds/check');
    const id = (await response.json()).job.id;
    await vi.waitFor(async () => expect(await job(id)).toMatchObject({ status: 'completed' }));
    expect((await job(id)).summary).toMatchObject({ valid: 0, invalid: 0, unknown: 2 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM yyds_accounts WHERE status = 'disabled'`).get()).toEqual({ n: 2 });
  });

  it.each(cases)('%s completes an empty pool without contacting upstream', async path => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await post(path);
    expect(response.status).toBe(202);
    const id = (await response.json()).job.id;
    await vi.waitFor(async () => expect(await job(id)).toMatchObject({ status: 'completed', total: 0, completed: 0 }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains interrupted progress across restart and releases the pool for a retry', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO batch_jobs (id, pool, kind, scope_hash, total, completed, summary_json, created_at, updated_at)
      VALUES ('interrupted-job', 'outlook', 'outlook-check', 'hash', 10, 3, '{"valid":2,"unknown":1}', ?, ?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    db.close();
    initDb();
    expect(await job('interrupted-job')).toMatchObject({ status: 'interrupted', total: 10, completed: 3, summary: { valid: 2, unknown: 1 } });
    const response = await post('outlook/check');
    expect(response.status).toBe(202);
    const id = (await response.json()).job.id;
    await vi.waitFor(async () => expect(await job(id)).toMatchObject({ status: 'completed' }));
  });

  it('defers the scheduled check while an admin batch owns the Outlook pool', async () => {
    seed();
    const upstream = slowUpstream();
    const response = await post('outlook/check');
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(upstream.fetchMock).toHaveBeenCalledTimes(1));
    const cleanup = cleanupExpired();
    const early = await Promise.race([cleanup.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 60))]);
    await upstream.finish();
    await cleanup;
    expect(early).toBe(true);
    expect((await job((await response.json()).job.id)).status).toBe('completed');
  });

  it('rejects an admin batch while the scheduled check owns the Outlook pool', async () => {
    seed();
    const upstream = slowUpstream();
    const cleanup = cleanupExpired();
    try {
      await vi.waitFor(() => expect(upstream.fetchMock).toHaveBeenCalledTimes(1));
      expect((await post('outlook/renew')).status).toBe(409);
    } finally { await upstream.finish(); await cleanup; }
  });

  it('keeps the pool locked until all workers settle after a processing failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = startBatchJob('outlook-check', ['failure-case'], [1, 2], 2, async n => {
      if (n === 1) throw new Error('secret-refresh-must-not-leak');
      await gate;
      return { status: 'valid' };
    });
    try {
      await vi.waitFor(async () => expect(await job(started.id)).toMatchObject({ status: 'running', completed: 1, summary: { unknown: 1 } }));
      expect((await post('outlook/renew')).status).toBe(409);
    } finally { release(); }
    await vi.waitFor(async () => expect(await job(started.id)).toMatchObject({ status: 'failed', completed: 2, summary: { valid: 1, unknown: 1 } }));
    expect(JSON.stringify(await job(started.id))).not.toContain('secret-refresh');
  });

  it('keeps the pool locked until workers settle after a progress write fails', async () => {
    const db = getDb();
    const prepare = db.prepare.bind(db);
    let failedOnce = false;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!failedOnce && sql.startsWith('UPDATE batch_jobs SET completed')) {
        failedOnce = true;
        throw new Error('progress storage unavailable');
      }
      return prepare(sql);
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = startBatchJob('outlook-check', ['storage-failure'], [1, 2], 2, async n => {
      if (n === 2) await gate;
      return { status: 'valid' };
    });
    try {
      await vi.waitFor(() => expect(failedOnce).toBe(true));
      expect((await job(started.id)).status).toBe('running');
      expect((await post('outlook/renew')).status).toBe(409);
    } finally {
      release();
      await vi.waitFor(async () => expect((await job(started.id)).status).not.toBe('running'));
      spy.mockRestore();
    }
  });

  it('lets an identical async start observe a legacy synchronous operation without repeating it', async () => {
    seed();
    const upstream = slowUpstream();
    const legacy = post('outlook/check', {});
    try {
      await vi.waitFor(() => expect(upstream.fetchMock).toHaveBeenCalledTimes(1));
      // Identical selections reuse the running task, including a task started
      // by a synchronous client. 409 applies to competing selections/actions.
      const joined = await post('outlook/check');
      expect(joined.status).toBe(202);
      expect((await joined.json()).job).toMatchObject({ status: 'running', completed: 0 });
      expect(upstream.fetchMock).toHaveBeenCalledTimes(1);
    } finally { await upstream.finish(); }
    const response = await legacy;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checked: 2, valid: 2, invalid: 0, unknown: 0, results: [{ email: 'test1@outlook.com' }, { email: 'test2@outlook.com' }] });
  });

  it('normalizes duplicate selections when reusing a task', async () => {
    seed();
    const upstream = slowUpstream();
    try {
      const first = await post('outlook/check', { background: true, emails: ['test1@outlook.com', 'test2@outlook.com'] });
      const second = await post('outlook/check', { background: true, emails: ['test2@outlook.com', 'test1@outlook.com', 'test1@outlook.com'] });
      expect((await second.json()).job.id).toBe((await first.json()).job.id);
    } finally { await upstream.finish(); }
  });
});
