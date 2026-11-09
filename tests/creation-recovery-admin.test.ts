import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '../src/crypto.js';
import { getDb, getRow, initDb } from '../src/db.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { registry } from '../src/providers/registry.js';
import { TemplateProvider, type TemplateProviderConfig } from '../src/providers/template-provider.js';
import { app, jsonHeaders } from './helpers/http.js';

// New persistent admin contract: only authentication may be retried, stale
// responses cannot replace newer credentials, and a paid asset is claimed once.
type Row = {
  id: string; phase: string; address: string; auth_data: string; variables_json: string;
  operation_id: string | null; operation_lease_until: string | null;
  response_history_json: string; credential_checkpoint_json: string;
  last_status: number | null; updated_at: string; expires_at: string; claimed_inbox_id: string | null;
};
const name = 'recovery-admin';
const prefix = `/api/template-providers/${name}/recoveries`;
const read = () => getRow<Row>(getDb(), 'SELECT * FROM creation_recoveries WHERE provider = ? ORDER BY rowid DESC LIMIT 1', name)!;
const count = () => getRow<{ count: number }>(getDb(), 'SELECT COUNT(*) AS count FROM inboxes')!.count;
const post = (id: string, action: string, token?: string) => app.request(`${prefix}/${id}/${action}`, { method: 'POST', headers: jsonHeaders(token) });
const json = async (response: Response) => await response.json() as any;

function config(builtin = 'mailtm'): TemplateProviderConfig {
  const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === builtin)!.config);
  cfg.name = name;
  cfg.domains = { mode: 'static', list: ['recovery.test'] };
  cfg.rateLimit.createPerMinute = 10;
  return cfg;
}

function save(cfg: TemplateProviderConfig) {
  getDb().prepare('INSERT INTO template_providers (name, config_json) VALUES (?, ?)').run(name, JSON.stringify(cfg));
  const provider = new TemplateProvider(cfg);
  registry.register(provider);
  return provider;
}

async function pending() {
  const cfg = config();
  const provider = save(cfg);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).endsWith('/accounts')
    ? '{"address":"owned@recovery.test","id":"private-account"}' : '{"message":"first auth failed"}',
  { status: String(url).endsWith('/accounts') ? 201 : 401 })));
  await expect(provider.createInbox({ domain: 'recovery.test' })).rejects.toMatchObject({ name: 'TemplateCreationRecoveryError' });
  return { cfg, provider, row: read() };
}

async function ready() {
  const cfg = config('maildrop');
  const provider = save(cfg);
  await provider.createInbox({ username: 'owned', domain: 'recovery.test' });
  return { cfg, provider, row: read() };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); registry.unregister(name);
});

describe('admin recovery authentication and ownership', () => {
  it('reloads an account and retries only snapshot authentication with the original password', async () => {
    const { row } = await pending();
    const original = JSON.parse(row.auth_data);
    getDb().prepare('UPDATE template_providers SET config_json = ? WHERE name = ?').run(JSON.stringify({ ...config(), apiBase: 'https://changed.test' }), name);
    getDb().close(); initDb();
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe('https://api.mail.tm/token');
      expect(JSON.parse(String(options?.body))).toEqual({ address: 'owned@recovery.test', password: original.password });
      expect(options?.method).toBe('POST');
      return new Response('{"token":"recovered-opaque-token"}');
    });
    vi.stubGlobal('fetch', fetch);
    const response = await post(row.id, 'retry');
    expect(response.status).toBe(200);
    expect((await json(response)).recovery).toMatchObject({ id: row.id, phase: 'ready' });
    expect(read().expires_at).toBe(row.expires_at);
    expect(JSON.parse(read().auth_data)).toMatchObject({ password: original.password, token: 'recovered-opaque-token' });
    expect(read().operation_id).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(count()).toBe(0);
  });

  it.each([
    { status: 401, body: '{"token":"issued-on-error"}' },
    { status: 429, body: '{"error":"limited"}' },
    { status: 503, body: '{"error":"offline"}' },
    { status: 200, body: '{broken-private-json' },
    { status: 200, body: '{}' },
    { status: 200, body: '{"token":true}' },
  ])('preserves the account after retry status=$status body=$body', async ({ status, body }) => {
    const { row } = await pending();
    const output: string[] = [];
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const fetch = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetch);
    const response = await post(row.id, 'retry');
    expect(response.status).toBe(status >= 400 ? status : 500);
    const publicData = await json(response);
    expect(publicData).toMatchObject({ error: 'Template inbox creation requires recovery', recovery: { id: row.id, phase: 'auth_pending' } });
    expect(JSON.stringify(publicData)).not.toMatch(/issued-on-error|private-json|private-account|password|auth_data|response_history/);
    expect(JSON.parse(read().auth_data).password).toBe(JSON.parse(row.auth_data).password);
    expect(JSON.parse(read().response_history_json)).toEqual(expect.arrayContaining([expect.objectContaining({ rawBody: body, operationId: expect.any(String) })]));
    expect(read().operation_id).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(count()).toBe(0);
    expect(output.join('')).not.toContain(row.id);
    expect(output.join('')).not.toContain(JSON.parse(row.auth_data).password);
  });

  it('keeps list output controlled and denies all three recovery operations to ordinary keys', async () => {
    const { row } = await pending();
    const response = await app.request(prefix, { headers: jsonHeaders() });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text).recoveries).toEqual([expect.objectContaining({ id: row.id, phase: 'auth_pending' })]);
    expect(text).not.toMatch(/password|private-account|config_snapshot|variables_json|auth_data|response_history|credential_checkpoint|api\.mail/);
    getDb().prepare('INSERT INTO api_keys (key, name) VALUES (?, ?)').run(hashApiKey('mk_user'), 'user');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await app.request(prefix, { headers: jsonHeaders('mk_user') })).status).toBe(403);
    for (const action of ['retry', 'claim']) expect((await post(row.id, action, 'mk_user')).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps recovery IDs out of malformed-request logs too', async () => {
    const { row } = await pending();
    const output: string[] = [];
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const response = await app.request(`${prefix}/${row.id}/claim`, { method: 'POST', headers: jsonHeaders(), body: '{invalid-json' });
    expect(response.status).toBe(400);
    expect(output.join('')).not.toContain(row.id);
  });

  it('does not replay an unknown create or let another provider use the recovery ID', async () => {
    const provider = save(config());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('create response lost'); }));
    await provider.createInbox({ domain: 'recovery.test' }).catch(() => {});
    const row = read();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await post(row.id, 'retry')).status).toBe(409);
    expect((await post(row.id, 'claim')).status).toBe(409);
    expect((await app.request(`/api/template-providers/other/recoveries/${row.id}/retry`, { method: 'POST', headers: jsonHeaders() })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('authenticates from the snapshot after configuration deletion, but refuses a claim', async () => {
    const { row } = await pending();
    getDb().prepare('DELETE FROM template_providers WHERE name = ?').run(name);
    const fetch = vi.fn(async () => new Response('{"token":"saved-token"}')); vi.stubGlobal('fetch', fetch);
    expect((await post(row.id, 'retry')).status).toBe(200);
    expect((await post(row.id, 'claim')).status).toBe(409);
    expect(read().phase).toBe('ready');
    expect(count()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the original generated password when response mappings also contain a password field', async () => {
    const cfg = config();
    cfg.postCreate!.responseMapping.authData.password = 'password';
    const provider = save(cfg);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).endsWith('/accounts')
      ? '{"address":"owned@recovery.test","id":42}' : '{"password":"mapped-password","token":"issued-token"}',
    { status: String(url).endsWith('/accounts') ? 201 : 401 })));
    await provider.createInbox({ domain: 'recovery.test' }).catch(() => {});
    const row = read();
    const generatedPassword = JSON.parse(row.variables_json).password;
    const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(JSON.parse(String(options?.body)).password).toBe(generatedPassword);
      return new Response('{"password":"mapped-password","token":"valid-token"}');
    });
    vi.stubGlobal('fetch', fetch);
    expect((await post(row.id, 'retry')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('wraps original authentication lock DB failure without leaking database text or losing the checkpoint', async () => {
    const provider = save(config());
    getDb().exec("CREATE TRIGGER reject_original_auth_lock BEFORE UPDATE ON creation_recoveries WHEN NEW.operation_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'private-lock-db-text'); END");
    const fetch = vi.fn(async () => new Response('{"address":"owned@recovery.test","id":42}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const failure = await provider.createInbox({ domain: 'recovery.test' }).catch(error => error);
      expect(failure).toMatchObject({ name: 'TemplateCreationRecoveryError', message: 'Template inbox creation requires recovery', recoveryId: read().id });
      expect(read().phase).toBe('upstream_created');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { getDb().exec('DROP TRIGGER reject_original_auth_lock'); }
  });

  it('claims a ready local asset once for admin, including after its inbox is purged', async () => {
    const { row } = await ready();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await post(row.id, 'retry')).status).toBe(200);
    const first = await json(await post(row.id, 'claim'));
    expect(first).toMatchObject({ id: expect.any(String), address: row.address, expiresAt: row.expires_at, recovery: { phase: 'claimed' } });
    expect(count()).toBe(1);
    expect(getDb().prepare('SELECT owner_key FROM inboxes WHERE id = ?').get(first.id)).toEqual({ owner_key: null });
    getDb().prepare('INSERT INTO api_keys (key, name) VALUES (?, ?)').run(hashApiKey('mk_user'), 'user');
    expect((await app.request(`/api/inbox/${first.id}/messages`, { headers: jsonHeaders('mk_user') })).status).toBe(404);
    expect((await json(await post(row.id, 'claim'))).id).toBe(first.id);
    expect(count()).toBe(1);
    getDb().prepare('DELETE FROM inboxes WHERE id = ?').run(first.id);
    expect((await json(await post(row.id, 'claim'))).id).toBe(first.id);
    expect((await post(row.id, 'retry')).status).toBe(200);
    expect(read().claimed_inbox_id).toBe(first.id);
    expect(count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['disabled-template', 'disabled-provider', 'changed-config', 'deleted-config', 'expired'])('preserves ready assets when claim is $0', async (condition) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const { cfg, row } = await ready();
    if (condition === 'disabled-template') getDb().prepare('UPDATE template_providers SET enabled = 0 WHERE name = ?').run(name);
    if (condition === 'disabled-provider') getDb().prepare('UPDATE provider_config SET enabled = 0 WHERE provider = ?').run(name);
    if (condition === 'changed-config') getDb().prepare('UPDATE template_providers SET config_json = ? WHERE name = ?').run(JSON.stringify({ ...cfg, apiBase: 'https://changed.test' }), name);
    if (condition === 'deleted-config') getDb().prepare('DELETE FROM template_providers WHERE name = ?').run(name);
    if (condition === 'expired') vi.setSystemTime(new Date(row.expires_at));
    expect((await post(row.id, 'claim')).status).toBe(condition === 'expired' ? 410 : 409);
    expect(read().phase).toBe('ready');
    expect(read().claimed_inbox_id).toBeNull();
    expect(count()).toBe(0);
  });

  it('rolls back claim on INSERT failure and permits a later single claim without changing expiry', async () => {
    const { row } = await ready();
    getDb().exec("CREATE TRIGGER reject_admin_recovery_inbox BEFORE INSERT ON inboxes BEGIN SELECT RAISE(ABORT, 'private-insert-failure'); END");
    try {
      const response = await post(row.id, 'claim');
      expect(response.status).toBe(500);
      expect(await json(response)).toEqual({ error: 'Creation recovery claim failed' });
      expect(read()).toMatchObject({ phase: 'ready', claimed_inbox_id: null, expires_at: row.expires_at });
      expect(count()).toBe(0);
    } finally { getDb().exec('DROP TRIGGER reject_admin_recovery_inbox'); }
    expect((await post(row.id, 'claim')).status).toBe(200);
    expect(count()).toBe(1);
  });

  it('recovers paid credentials after local expiry without extending the lifetime or allowing a new inbox claim', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const { row } = await pending();
    getDb().prepare("UPDATE creation_recoveries SET phase = 'upstream_created' WHERE id = ?").run(row.id);
    const fetch = vi.fn(async () => new Response('{"token":"recovered-token"}')); vi.stubGlobal('fetch', fetch);
    expect((await post(row.id, 'retry')).status).toBe(200);
    expect(read().phase).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(1);
    getDb().prepare("UPDATE creation_recoveries SET phase = 'auth_pending' WHERE id = ?").run(row.id);
    vi.setSystemTime(new Date(row.expires_at));
    // A local inbox lifetime does not make the paid upstream account worthless.
    // Authentication may recover its credentials; claim still honors expiry.
    expect((await post(row.id, 'retry')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(read().phase).toBe('ready');
    expect(read().expires_at).toBe(row.expires_at);
    expect((await post(row.id, 'claim')).status).toBe(410);
  });
});

describe('authentication operation fencing', () => {
  it('blocks retry while original authentication is in flight, including a DB reload', async () => {
    const provider = save(config());
    let started!: () => void; const inFlight = new Promise<void>(resolve => { started = resolve; });
    let resolveAuth!: (response: Response) => void;
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/accounts')) return new Response('{"address":"owned@recovery.test","id":42}', { status: 201 });
      started(); return new Promise<Response>(resolve => { resolveAuth = resolve; });
    });
    vi.stubGlobal('fetch', fetch);
    const original = provider.createInbox({ domain: 'recovery.test' });
    await inFlight;
    const row = read();
    expect(row.operation_id).toEqual(expect.any(String));
    expect(Date.parse(row.operation_lease_until!) - Date.now()).toBeGreaterThan(15000);
    getDb().close(); initDb();
    expect(read().operation_id).toBe(row.operation_id);
    expect((await post(row.id, 'retry')).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(2);
    resolveAuth(new Response('{"token":"original-token"}'));
    await expect(original).resolves.toMatchObject({ authData: { token: 'original-token' } });
    expect(read().phase).toBe('ready');
  });

  it.each(['normal', 'retry'].flatMap(origin => ['fetch', 'body'].map(stage => ({ origin, stage }))))('preserves late $origin $stage credentials without overwriting a newer retry operation', async ({ origin, stage }) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const provider = origin === 'normal' ? save(config()) : (await pending()).provider;
    let started!: () => void; const inFlight = new Promise<void>(resolve => { started = resolve; });
    let resolveLate!: (value: any) => void;
    let authCalls = 0;
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/accounts')) return new Response('{"address":"owned@recovery.test","id":42}', { status: 201 });
      if (++authCalls > 1) return new Response('{"token":"newest-token"}');
      if (stage === 'fetch') { started(); return new Promise<Response>(resolve => { resolveLate = resolve; }); }
      return { ok: true, status: 200, headers: new Headers(), text: async () => { started(); return new Promise<string>(resolve => { resolveLate = resolve; }); } } as Response;
    });
    vi.stubGlobal('fetch', fetch);
    const old = origin === 'normal' ? provider.createInbox({ domain: 'recovery.test' }).catch(error => error) : post(read().id, 'retry');
    await inFlight;
    const row = read();
    const oldOperation = read().operation_id;
    vi.setSystemTime(Date.parse(read().operation_lease_until!) + 1);
    const newer = await post(row.id, 'retry');
    expect(newer.status).toBe(200);
    const current = read();
    expect(JSON.parse(current.auth_data).token).toBe('newest-token');
    resolveLate(stage === 'fetch' ? new Response('{"token":"late-issued-token"}', { status: 429 }) : '{"token":"late-issued-token"}');
    const lateResult = await old;
    expect(lateResult.status).toBe(409);
    if (origin === 'normal') expect(lateResult.name).toBe('TemplateCreationRecoveryError');
    const final = read();
    expect(final).toMatchObject({ phase: 'ready', auth_data: current.auth_data, last_status: current.last_status, updated_at: current.updated_at, operation_id: current.operation_id });
    expect(JSON.parse(final.credential_checkpoint_json)).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: oldOperation, authData: expect.objectContaining({ token: 'late-issued-token' }) })]));
    expect(final.response_history_json).toContain('late-issued-token');
    expect(fetch).toHaveBeenCalledTimes(origin === 'normal' ? 3 : 2);
  });
});

describe('template test retains created assets', () => {
  it.each(['mailtm', 'tempmail-lol'].flatMap(builtin => ['success', 'create failure', 'read failure'].map(outcome => ({ builtin, outcome }))))(
    'retains $builtin asset on test $outcome and returns safe recovery metadata', async ({ builtin, outcome }) => {
      const cfg = config(builtin);
      if (builtin === 'tempmail-lol') cfg.domains = { mode: 'from_create' };
      save(cfg);
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        expect(options?.method).not.toBe('DELETE');
        if (String(url).includes('/messages') || String(url).includes('/inbox?')) {
          if (outcome === 'read failure') throw new Error('private-message-read-secret');
          return new Response('{"hydra:member":[],"emails":[]}');
        }
        if (outcome === 'create failure' && (builtin !== 'mailtm' || String(url).endsWith('/token'))) return new Response('{"token":"private-issued-token"}', { status: 401 });
        return new Response('{"address":"owned@recovery.test","id":42,"token":"private-token"}', { status: 201 });
      });
      vi.stubGlobal('fetch', fetch);
      const response = await app.request(`/api/template-providers/${name}/test`, { method: 'POST', headers: jsonHeaders() });
      expect(response.status).toBe(200);
      const result = await json(response);
      expect(result).toMatchObject({ success: outcome === 'success', recovery: { id: read().id } });
      expect(result.steps.some((step: any) => step.step === 'deleteInbox')).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/private-(?:issued-token|token|message-read-secret)|password/);
      expect(read().phase).toBe(outcome === 'create failure' ? builtin === 'mailtm' ? 'auth_pending' : 'outcome_unknown' : 'ready');
      expect(count()).toBe(0);
    },
  );
});
