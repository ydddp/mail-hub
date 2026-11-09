import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getRow, initDb } from '../src/db.js';
import { dispatch } from '../src/dispatcher.js';
import { isTransientUpstreamError, NoAssetCreatedError, TemplateCreationRecoveryError } from '../src/errors.js';
import { creationConfigFingerprint } from '../src/creation-recovery.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { BUILTIN_TEMPLATES } from '../src/providers/builtin-templates.js';
import { registry } from '../src/providers/registry.js';
import { TemplateProvider } from '../src/providers/template-provider.js';
import { app, jsonHeaders } from './helpers/http.js';

// New top-level suite: allocated credentials must survive failures/restarts,
// and an asset must be handed to exactly one inbox even after inbox retention.
interface RecoveryRow {
  id: string; provider: string; phase: string; address: string;
  variables_json: string; auth_data: string; config_snapshot: string;
  config_fingerprint: string; api_base: string; expires_at: string;
  requested_inbox_id: string | null; claimed_inbox_id: string | null;
  response_history_json: string;
}

function config(name = 'mailtm') {
  const cfg = structuredClone(BUILTIN_TEMPLATES.find(entry => entry.config.name === name)!.config);
  cfg.name = 'recovery-test';
  cfg.domains = { mode: 'static', list: ['recovery.example.test'] };
  cfg.rateLimit.createPerMinute = 10;
  return cfg;
}

function recovery(): RecoveryRow {
  const row = getRow<RecoveryRow>(getDb(), 'SELECT * FROM creation_recoveries ORDER BY created_at DESC LIMIT 1');
  expect(row).toBeDefined();
  return row!;
}

function inboxCount(): number {
  return getRow<{ count: number }>(getDb(), 'SELECT COUNT(*) AS count FROM inboxes')!.count;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  registry.unregister('recovery-test');
});

describe('template creation durable asset contract', () => {
  const failures = [
    { label: '401', status: 401, body: '{"token":"issued-on-error"}' },
    { label: '429', status: 429, body: '{"message":"limited"}' },
    { label: '503', status: 503, body: '{"message":"unavailable"}' },
    { label: 'bad JSON', status: 200, body: '{broken' },
    { label: 'missing token', status: 200, body: '{}' },
    { label: 'boolean token', status: 200, body: '{"token":true}' },
    { label: 'object token', status: 200, body: '{"token":{"secret":"opaque"}}' },
    { label: 'blank token', status: 200, body: '{"token":"  "}' },
  ];
  it.each(['mailtm', 'mailgw'].flatMap(name => failures.map(failure => ({ name, ...failure }))))(
    'preserves $name account after token $label and never announces a usable inbox', async ({ name, status, body }) => {
      const cfg = config(name);
      registry.register(new TemplateProvider(cfg));
      let createdPassword = '';
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/accounts')) {
          const sent = JSON.parse(String(init?.body));
          createdPassword = sent.password;
          return new Response(JSON.stringify({ address: sent.address, id: 42 }), { status: 201 });
        }
        return new Response(body, { status, headers: { 'Retry-After': '17' } });
      });
      vi.stubGlobal('fetch', fetch);
      const error = await dispatch({ provider: cfg.name, username: 'owned' }).catch(error => error);
      expect(error).toMatchObject({ name: 'TemplateCreationRecoveryError', assetMayExist: true, status: status >= 400 ? status : 500 });
      expect(error).not.toBeInstanceOf(NoAssetCreatedError);
      const row = recovery();
      expect(error.recoveryId).toBe(row.id);
      expect(error.message).toBe('Template inbox creation requires recovery');
      expect(row).toMatchObject({ phase: 'auth_pending', address: 'owned@recovery.example.test', provider: cfg.name, api_base: cfg.apiBase, claimed_inbox_id: null });
      expect(JSON.parse(row.auth_data)).toMatchObject({ accountId: '42', password: createdPassword });
      expect(JSON.parse(row.variables_json).password).toBe(createdPassword);
      expect(JSON.parse(row.response_history_json)).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'authenticate', rawBody: body })]));
      if (status === 401) expect(JSON.parse(row.auth_data).token).toBe('issued-on-error');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(inboxCount()).toBe(0);
      expect(rateLimiter.getCreateStatus(cfg.name).currentCount).toBe(1);
    },
  );

  it('checkpoints variables/config before create and credentials before authentication; reload survives restart', async () => {
    const cfg = config();
    cfg.auth = { type: 'bearer', value: 'private-provider-secret' };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const row = recovery();
      if (String(url).endsWith('/accounts')) {
        const sent = JSON.parse(String(init?.body));
        expect(row.phase).toBe('attempting');
        expect(JSON.parse(row.variables_json)).toMatchObject({ address: sent.address, password: sent.password });
        expect(JSON.parse(row.config_snapshot)).toEqual(cfg);
        expect(row.config_fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(row.requested_inbox_id).toBe('requested-inbox');
        return new Response(JSON.stringify({ address: sent.address, id: 17 }), { status: 201 });
      }
      expect(row.phase).toBe('auth_pending');
      expect(JSON.parse(row.auth_data)).toMatchObject({ accountId: '17' });
      expect(row.response_history_json).toContain('17');
      throw new TypeError('token network disconnected');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(new TemplateProvider(cfg).createInbox({ username: 'saved', inboxId: 'requested-inbox' })).rejects.toMatchObject({ name: 'TemplateCreationRecoveryError' });
    const before = recovery();
    getDb().close();
    initDb();
    expect(recovery()).toEqual(before);
    expect(JSON.parse(recovery().auth_data).password.length).toBeGreaterThanOrEqual(20);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['disconnect', 'JSON', 'shape', 'HTTP error'])('preserves uncertain create outcome after %s without replay', async (failure) => {
    const cfg = config('tempmail-lol');
    cfg.domains = { mode: 'from_create' };
    registry.register(new TemplateProvider(cfg));
    const fetch = vi.fn(async () => {
      if (failure === 'disconnect') throw new TypeError('lost after commit');
      return new Response(failure === 'JSON' ? 'broken' : '{}', { status: failure === 'HTTP error' ? 503 : 201 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(dispatch({ provider: cfg.name })).rejects.toMatchObject({ name: 'TemplateCreationRecoveryError', assetMayExist: true });
    expect(recovery().phase).toBe('outcome_unknown');
    expect(JSON.parse(recovery().variables_json).password.length).toBeGreaterThanOrEqual(20);
    expect(inboxCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rateLimiter.getCreateStatus(cfg.name).currentCount).toBe(1);
  });

  it('fails closed before create if the first durable checkpoint fails', async () => {
    getDb().exec("CREATE TRIGGER reject_creation_checkpoint BEFORE INSERT ON creation_recoveries BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END");
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const cfg = config();
      registry.register(new TemplateProvider(cfg));
      const failure = await dispatch({ provider: cfg.name }).catch(error => error);
      expect(failure).toBeInstanceOf(NoAssetCreatedError);
      expect(failure.message).toBe('Template inbox creation could not be started');
      expect(failure).not.toHaveProperty('recoveryId');
      expect(fetch).not.toHaveBeenCalled();
      expect(inboxCount()).toBe(0);
      expect(rateLimiter.getCreateStatus(cfg.name).currentCount).toBe(0);
    } finally {
      getDb().exec('DROP TRIGGER reject_creation_checkpoint');
    }
  });

  it.each(['tempmail-lol', 'maildrop', 'catchmail'])('transparently saves one %s inbox and permanently claims its recovery record', async (name) => {
    const cfg = config(name);
    registry.register(new TemplateProvider(cfg));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"address":"upstream@recovery.example.test","token":"opaque-token"}', { status: 201 })));
    const result = await dispatch({ provider: cfg.name });
    expect(inboxCount()).toBe(1);
    expect(recovery()).toMatchObject({ phase: 'claimed', claimed_inbox_id: result.id });
    expect(result).not.toHaveProperty('creationRecoveryId');
    expect(getRow<{ auth_data: string }>(getDb(), 'SELECT auth_data FROM inboxes WHERE id = ?', result.id)!.auth_data).not.toContain('creationRecoveryId');
  });

  it('rolls back a failed inbox INSERT, then permits one internal claim and refuses a second after inbox purge', async () => {
    const cfg = config('tempmail-lol');
    const provider = new TemplateProvider(cfg);
    registry.register(provider);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"address":"owned@recovery.example.test","token":"opaque-token"}')));
    const inbox = await provider.createInbox();
    vi.spyOn(provider, 'createInbox').mockResolvedValue(inbox);
    getDb().exec("CREATE TRIGGER reject_recovery_inbox BEFORE INSERT ON inboxes BEGIN SELECT RAISE(ABORT, 'inbox write failed'); END");
    try {
      const failure = await dispatch({ provider: cfg.name }).catch(error => error);
      expect(failure).toBeInstanceOf(TemplateCreationRecoveryError);
      expect(failure.message).toBe('Template inbox creation requires recovery');
      expect(failure.cause.message).toBe('inbox write failed');
      expect(recovery()).toMatchObject({ phase: 'ready', claimed_inbox_id: null });
      expect(inboxCount()).toBe(0);
      expect(rateLimiter.getCreateStatus(cfg.name).currentCount).toBe(1);
    } finally {
      getDb().exec('DROP TRIGGER reject_recovery_inbox');
    }
    const claimed = await dispatch({ provider: cfg.name });
    expect(recovery().claimed_inbox_id).toBe(claimed.id);
    getDb().prepare('DELETE FROM inboxes WHERE id = ?').run(claimed.id);
    await expect(dispatch({ provider: cfg.name })).rejects.toThrow('Template inbox creation requires recovery');
    expect(recovery().claimed_inbox_id).toBe(claimed.id);
    expect(inboxCount()).toBe(0);
  });

  it.each(['provider', 'address'])('refuses an internal recovery marker bound to a different %s', async (field) => {
    const cfg = config('tempmail-lol');
    const provider = new TemplateProvider(cfg);
    registry.register(provider);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"address":"owned@recovery.example.test","token":"opaque-token"}')));
    const inbox = await provider.createInbox();
    vi.spyOn(provider, 'createInbox').mockResolvedValue({ ...inbox, [field]: 'different' });
    await expect(dispatch({ provider: cfg.name })).rejects.toThrow('Template inbox creation requires recovery');
    expect(inboxCount()).toBe(0);
    expect(recovery().phase).toBe('ready');
  });

  it.each([
    { expiresIn: 86400, duration: undefined, expectedSeconds: 86400 },
    { expiresIn: 86400, duration: 600, expectedSeconds: 600 },
    { expiresIn: 86400, duration: 7 * 86400, expectedSeconds: 86400 },
    { expiresIn: undefined, duration: undefined, expectedSeconds: 86400 },
    { expiresIn: undefined, duration: 600, expectedSeconds: 600 },
    { expiresIn: undefined, duration: 7 * 86400, expectedSeconds: 7 * 86400 },
  ])('freezes expiry=$expiresIn with requested duration=$duration before authentication and preserves opaque token bytes', async ({ expiresIn, duration, expectedSeconds }) => {
    vi.useFakeTimers();
    const start = new Date('2026-11-07T00:00:00Z');
    vi.setSystemTime(start);
    const cfg = config();
    cfg.create.expiresIn = expiresIn;
    registry.register(new TemplateProvider(cfg));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/accounts')) return new Response('{"address":"owned@recovery.example.test","id":5}', { status: 201 });
      vi.setSystemTime(start.getTime() + 30_000);
      return new Response('{"token":"  opaque token  "}');
    }));
    const result = await dispatch({ provider: cfg.name, duration });
    const original = new Date(start.getTime() + expectedSeconds * 1000).toISOString();
    expect(recovery().expires_at).toBe(original);
    expect(result.expiresAt).toBe(original);
    expect(JSON.parse(recovery().auth_data).token).toBe('  opaque token  ');
  });

  it.each([
    { createToken: 123, postCreateMapping: false, expectedToken: undefined },
    { createToken: 'existing-opaque-token', postCreateMapping: false, expectedToken: 'existing-opaque-token' },
    { createToken: 'existing-opaque-token', postCreateMapping: true, expectedToken: 'new-opaque-token' },
  ])('validates raw create credential $createToken before postCreate mapping=$postCreateMapping', async ({ createToken, postCreateMapping, expectedToken }) => {
    const cfg = config();
    cfg.create.responseMapping.authData.token = 'token';
    cfg.postCreate!.responseMapping.authData = postCreateMapping ? { token: 'new_token' } : {};
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('/accounts')
      ? { address: 'owned@recovery.example.test', id: 42, token: createToken } : { new_token: 'new-opaque-token' })));
    vi.stubGlobal('fetch', fetch);
    if (expectedToken === undefined) {
      await expect(new TemplateProvider(cfg).createInbox()).rejects.toBeInstanceOf(TemplateCreationRecoveryError);
      expect(recovery().phase).toBe('outcome_unknown');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(inboxCount()).toBe(0);
    } else {
      const inbox = await new TemplateProvider(cfg).createInbox();
      expect(inbox.authData.token).toBe(expectedToken);
      expect(recovery().phase).toBe('ready');
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it.each([undefined, true, {}, 123, ' '])('does not announce a no-postCreate inbox with unusable token %j', async (token) => {
    const cfg = config('tempmail-lol');
    registry.register(new TemplateProvider(cfg));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ address: 'owned@recovery.example.test', token })));
    vi.stubGlobal('fetch', fetch);
    await expect(dispatch({ provider: cfg.name })).rejects.toBeInstanceOf(TemplateCreationRecoveryError);
    expect(recovery().phase).toBe('outcome_unknown');
    expect(inboxCount()).toBe(0);
    expect(rateLimiter.getCreateStatus(cfg.name).currentCount).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates the configured authField while preserving compatible numeric ID mappings', async () => {
    const cfg = config();
    cfg.postCreate!.responseMapping.authData = { bearer: 'access_token', loginId: 'id' };
    cfg.messages.authField = 'bearer';
    cfg.messageDetail.authField = 'bearer';
    cfg.deleteInbox!.authField = 'bearer';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).endsWith('/accounts')
      ? '{"address":"owned@recovery.example.test","id":42}' : '{"access_token":"opaque-bearer","id":123}')));
    const inbox = await new TemplateProvider(cfg).createInbox();
    expect(inbox.authData).toMatchObject({ bearer: 'opaque-bearer', loginId: '123', accountId: '42' });
    expect(recovery().phase).toBe('ready');
  });

  it.each(['create', 'postCreate'].flatMap(stage => ['expires', 'quota'].map(field => ({ stage, field }))))(
    'preserves finite numeric $field metadata from $stage without treating it as a bearer credential', async ({ stage, field }) => {
      const cfg = config(stage === 'create' ? 'tempmail-lol' : 'mailtm');
      const mapping = stage === 'create' ? cfg.create.responseMapping.authData : cfg.postCreate!.responseMapping.authData;
      mapping[field] = field;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        address: 'owned@recovery.example.test', id: 42, token: 'valid-token', [field]: 3600,
      }))));
      const inbox = await new TemplateProvider(cfg).createInbox();
      expect(inbox.authData).toMatchObject({ token: 'valid-token', [field]: '3600' });
      expect(recovery().phase).toBe('ready');
    },
  );

  it('refuses a custom local template that requires an unavailable inbox token', async () => {
    const cfg = config('catchmail');
    cfg.messages.authFrom = 'inbox';
    cfg.messages.authField = 'token';
    registry.register(new TemplateProvider(cfg));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(dispatch({ provider: cfg.name })).rejects.toBeInstanceOf(TemplateCreationRecoveryError);
    expect(recovery().phase).toBe('outcome_unknown');
    expect(inboxCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps transient network classification through the private recovery wrapper', async () => {
    const cfg = config();
    const disconnected = new TypeError('lost connection with sensitive details');
    vi.stubGlobal('fetch', vi.fn(async () => { throw disconnected; }));
    const failure = await new TemplateProvider(cfg).createInbox().catch(error => error);
    expect(failure.cause).toBe(disconnected);
    expect(isTransientUpstreamError(failure)).toBe(true);
    expect(failure.message).not.toContain('sensitive');
  });

  it('uses a stable semantic fingerprint and immutable snapshot/expiry/claim fields', async () => {
    const cfg = config('maildrop');
    const reordered = { ...cfg, auth: { ...cfg.auth }, displayName: 'renamed', rateLimit: { createPerMinute: 1, pollPerMinute: 1 } };
    expect(creationConfigFingerprint(reordered)).toBe(creationConfigFingerprint(cfg));
    expect(creationConfigFingerprint({ ...cfg, apiBase: 'https://different.test' })).not.toBe(creationConfigFingerprint(cfg));
    await new TemplateProvider(cfg).createInbox();
    const row = recovery();
    for (const column of ['config_snapshot', 'config_fingerprint', 'variables_json', 'expires_at']) {
      expect(() => getDb().prepare(`UPDATE creation_recoveries SET ${column} = ? WHERE id = ?`).run('changed', row.id)).toThrow('immutable');
    }
    getDb().prepare("UPDATE creation_recoveries SET phase = 'claimed', claimed_inbox_id = 'first' WHERE id = ?").run(row.id);
    expect(() => getDb().prepare('UPDATE creation_recoveries SET claimed_inbox_id = NULL WHERE id = ?').run(row.id)).toThrow('already claimed');
  });

  it.each(BUILTIN_TEMPLATES.map(entry => entry.config.name))('keeps the shared %s builtin create path compatible', async (name) => {
    const cfg = config(name);
    const data = {
      address: 'returned@recovery.example.test', id: 42, token: 'opaque-token',
      email: name === 'tempmail-ing' ? { address: 'returned@recovery.example.test' } : 'returned@recovery.example.test',
      email_addr: 'returned@recovery.example.test', sid_token: 'opaque-sid', user: 'returned@recovery.example.test',
      data: { introduceSession: { id: 'opaque-session', addresses: [{ address: 'returned@recovery.example.test' }] } },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(data), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const inbox = await new TemplateProvider(cfg).createInbox({ username: 'builtin' });
    expect(inbox.address).toBe(cfg.create.skip ? 'builtin@recovery.example.test' : 'returned@recovery.example.test');
    expect(recovery().phase).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(cfg.create.skip ? 0 : cfg.postCreate ? 2 : 1);
  });

  it('maps token HTTP 429 through the business API without exposing assets', async () => {
    const cfg = config();
    registry.register(new TemplateProvider(cfg));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).endsWith('/accounts')
      ? '{"address":"private@recovery.example.test","id":"private-account"}' : '{"token":"private-issued-token"}',
    { status: String(url).endsWith('/accounts') ? 201 : 429, headers: { 'Retry-After': '17' } })));
    const response = await app.request('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ for: 'r05.test', provider: cfg.name }) });
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain('Template inbox creation requires recovery');
    expect(body).not.toMatch(/private-|recoveryId|creationRecoveryId/);
    expect(body).not.toContain(recovery().id);
    expect(inboxCount()).toBe(0);
  });
});
