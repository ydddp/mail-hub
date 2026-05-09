import { describe, expect, it } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { app, jsonHeaders, jsonOf } from './helpers/http.js';

interface ReportResponse {
  action: 'stats_updated' | 'fail_recorded' | 'auto_blocked';
  blocked?: { service: string; domain: string; rule: number }[];
}

function createInbox(provider: string, address: string, id: string) {
  getDb().prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, status) VALUES (?, ?, ?, '{}', 'active')`
  ).run(id, provider, address);
}

function createRule(opts: {
  service?: string; provider?: string; threshold?: number;
  window_hours?: number; scope?: string; domain_level?: number;
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO block_rules (service, provider, threshold, window_hours, scope, domain_level, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).run(
    opts.service ?? '*', opts.provider ?? '*',
    opts.threshold ?? 3, opts.window_hours ?? 24,
    opts.scope ?? 'per_service', opts.domain_level ?? 2,
  );
}

async function reportFail(inboxId: string, service: string) {
  return app.request(`/api/inbox/${inboxId}/report`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ success: false, service }),
  });
}

describe('auto-block rules engine', () => {
  it('blocks domain after reaching threshold', async () => {
    createRule({ threshold: 3 });
    createInbox('mailtm', 'test@example.com', 'inbox-1');

    await reportFail('inbox-1', 'twitter.com');
    await reportFail('inbox-1', 'twitter.com');
    const res = await reportFail('inbox-1', 'twitter.com');

    const data = await jsonOf<ReportResponse>(res);
    expect(data.action).toBe('auto_blocked');
    expect(data.blocked).toHaveLength(1);
    expect(data.blocked?.[0]?.domain).toBe('example.com');

    const blocks = getDb().prepare(`SELECT * FROM blocks WHERE domain = 'example.com'`).all();
    expect(blocks).toHaveLength(1);
  });

  it('does not block before reaching threshold', async () => {
    createRule({ threshold: 3 });
    createInbox('mailtm', 'test@example.com', 'inbox-2');

    await reportFail('inbox-2', 'twitter.com');
    const res = await reportFail('inbox-2', 'twitter.com');

    const data = await jsonOf<ReportResponse>(res);
    expect(data.action).toBe('fail_recorded');
  });

  it('respects service filter on rule', async () => {
    createRule({ service: 'twitter.com', threshold: 2 });
    createInbox('mailtm', 'test@example.com', 'inbox-3');

    await reportFail('inbox-3', 'github.com');
    const res1 = await reportFail('inbox-3', 'github.com');
    const d1 = await jsonOf<ReportResponse>(res1);
    expect(d1.action).toBe('fail_recorded');

    await reportFail('inbox-3', 'twitter.com');
    const res2 = await reportFail('inbox-3', 'twitter.com');
    const d2 = await jsonOf<ReportResponse>(res2);
    expect(d2.action).toBe('auto_blocked');
  });

  it('respects provider filter on rule', async () => {
    createRule({ provider: 'outlook', threshold: 2 });
    createInbox('mailtm', 'test@mt.com', 'inbox-4a');
    createInbox('outlook', 'test@outlook.com', 'inbox-4b');

    await reportFail('inbox-4a', 'svc.com');
    await reportFail('inbox-4a', 'svc.com');
    const r1 = await jsonOf<ReportResponse>(await reportFail('inbox-4a', 'svc.com'));
    expect(r1.action).toBe('fail_recorded');

    await reportFail('inbox-4b', 'svc.com');
    const r2 = await jsonOf<ReportResponse>(await reportFail('inbox-4b', 'svc.com'));
    expect(r2.action).toBe('auto_blocked');
  });

  it('scope=global blocks for all services', async () => {
    createRule({ scope: 'global', threshold: 2 });
    createInbox('mailtm', 'test@example.com', 'inbox-5');

    await reportFail('inbox-5', 'twitter.com');
    const res = await reportFail('inbox-5', 'twitter.com');
    const data = await jsonOf<ReportResponse>(res);
    expect(data.action).toBe('auto_blocked');

    const block = getRow<{ service: string }>(getDb(), `SELECT service FROM blocks WHERE domain = 'example.com'`);
    expect(block?.service).toBe('*');
  });

  it('domain_level=3 blocks higher-level domain', async () => {
    createRule({ threshold: 2, domain_level: 3 });
    createInbox('mailtm', 'test@sub.example.com', 'inbox-6');

    await reportFail('inbox-6', 'twitter.com');
    const res = await reportFail('inbox-6', 'twitter.com');
    const data = await jsonOf<ReportResponse>(res);
    expect(data.action).toBe('auto_blocked');
    expect(data.blocked?.[0]?.domain).toBe('sub.example.com');
  });

  it('does not duplicate blocks for same domain', async () => {
    createRule({ threshold: 2 });
    createInbox('mailtm', 'test@example.com', 'inbox-7');

    await reportFail('inbox-7', 'twitter.com');
    await reportFail('inbox-7', 'twitter.com');
    await reportFail('inbox-7', 'twitter.com');
    await reportFail('inbox-7', 'twitter.com');

    const blocks = getDb().prepare(`SELECT * FROM blocks WHERE domain = 'example.com'`).all();
    expect(blocks).toHaveLength(1);
  });
});
