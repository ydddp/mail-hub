import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getDb, initDb } from '../src/db.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// New contract: every received token response is a private, durable asset,
// including failed/partial responses and credentials whose account disappears.
describe('private Outlook credential history', () => {
  // Issued tokens and created accounts cannot be regenerated after an OS
  // crash. Their commit must request WAL sync (SQLite FULL=2), including
  // after startup reopens the database; NORMAL only syncs at checkpoints.
  it.each(['fresh', 'reopened'])('requests commit durability for permanent credentials on a %s connection', connection => {
    if (connection === 'reopened') { getDb().close(); initDb(); }
    expect(getDb().pragma('journal_mode', { simple: true })).toBe('wal');
    expect(getDb().pragma('synchronous', { simple: true })).toBe(2);
  });

  it.each([
    ...[400, 401, 403, 429, 503].map(status => ({ status, raw: JSON.stringify({ access_token: 'private-at', refresh_token: 'private-rt', error_description: 'private-error' }) })),
    { status: 200, raw: '{"refresh_token":"private-rt"}' },
    { status: 200, raw: 'not-json-private-raw' },
  ])('preserves HTTP $status response before rejecting it', async ({ status, raw }) => {
    const db = getDb();
    db.prepare(`INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
      VALUES ('asset@outlook.com', 'pw', 'issuing-client', 'original-refresh', 'valid')`).run();
    const logs: string[] = [];
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation(chunk => { logs.push(String(chunk)); return true; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status })));
    const bodies: string[] = [];
    for (let n = 0; n < 2; n++) {
      const response = await app.request('/api/outlook/renew', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ emails: ['asset@outlook.com'] }) });
      bodies.push(await response.text());
    }
    const received = db.prepare('SELECT * FROM outlook_credential_checkpoints WHERE http_status IS NOT NULL').all() as Array<Record<string, unknown>>;
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ email: 'asset@outlook.com', issuing_client_id: 'issuing-client', http_status: status, raw_response: raw });
    expect(received[0].operation_id).not.toBe(received[1].operation_id);
    expect(received[0].received_at).toEqual(expect.any(String));
    if (raw.includes('private-rt')) expect(JSON.parse(String(received[0].credentials_json))).toMatchObject({ refresh_token: 'private-rt' });
    for (const path of ['/api/outlook/accounts', '/api/batch-jobs?pool=outlook']) {
      bodies.push(await (await app.request(path, { headers: authHeaders() })).text());
    }
    expect(bodies.join('') + logs.join('') + JSON.stringify(db.prepare('SELECT * FROM activity_log').all()))
      .not.toMatch(/private-at|private-rt|private-error|not-json-private-raw/);
    const count = received.length;
    db.prepare("DELETE FROM outlook_accounts WHERE email = 'asset@outlook.com'").run();
    const reopened = new Database(process.env.DB_PATH!);
    try { expect(reopened.prepare('SELECT COUNT(*) AS n FROM outlook_credential_checkpoints WHERE http_status IS NOT NULL').get()).toEqual({ n: count }); }
    finally { reopened.close(); }
  });

  it.each(['check', 'renew'].flatMap(operation => ['initial', 'received'].map(failure => ({ operation, failure }))))('stops $operation safely when $failure checkpoint storage fails', async ({ operation, failure }) => {
    const db = getDb();
    db.prepare(`INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status)
      VALUES ('storage@outlook.com', 'pw', 'client', 'original', 'valid')`).run();
    db.exec(`CREATE TEMP TRIGGER fail_private_checkpoint BEFORE INSERT ON outlook_credential_checkpoints
      WHEN ${failure === 'initial' ? 'NEW.http_status IS NULL' : 'NEW.http_status IS NOT NULL'}
      BEGIN SELECT RAISE(ABORT, 'private storage unavailable'); END`);
    const fetchMock = vi.fn(async () => new Response('{"access_token":"private-at","refresh_token":"private-rt"}'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await app.request(`/api/outlook/${operation}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ emails: ['storage@outlook.com'] }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ results: [{ status: 'unknown' }] });
      expect(fetchMock).toHaveBeenCalledTimes(failure === 'initial' ? 0 : 1);
      expect(db.prepare('SELECT refresh_token, token_status, last_checked_at FROM outlook_accounts').get())
        .toEqual({ refresh_token: 'original', token_status: 'valid', last_checked_at: null });
    } finally { db.exec('DROP TRIGGER fail_private_checkpoint'); }
  });
});
