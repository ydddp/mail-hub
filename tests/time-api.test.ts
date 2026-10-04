import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
import { app, authHeaders, jsonHeaders } from './helpers/http.js';

const stored = '2026-10-04 12:00:00';
const iso = '2026-10-04T12:00:00.000Z';

// New external contract: every DB-backed API timestamp is unambiguous UTC.
describe('API time-point serialization', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("INSERT INTO inboxes (id,provider,address,auth_data,target_service,created_at,expires_at,closed_at,status) VALUES ('tz','mailtm','tz@example.test','{}','date.test',?,?,?,'closed')").run(stored, stored, stored);
    db.prepare("INSERT INTO blocks (service,domain,blocked_at) VALUES ('date.test','example.test',?)").run(stored);
    db.prepare("INSERT INTO block_rules (created_at) VALUES (?)").run(stored);
    db.prepare("INSERT INTO fail_log (service,provider,domain,reported_at) VALUES ('date.test','mailtm','example.test',?)").run(stored);
    db.prepare("INSERT INTO service_stats (name,first_used_at,last_used_at) VALUES ('date.test',?,?)").run(stored, stored);
    db.prepare("INSERT INTO api_keys (key,name,created_at,last_used_at) VALUES ('tz','tz',?,?)").run(stored, stored);
    db.prepare("INSERT INTO outlook_accounts (email,password,created_at,token_renewed_at,last_checked_at) VALUES ('tz@outlook.com','pw',?,?,?)").run(stored, stored, stored);
    db.prepare("INSERT INTO imap_accounts (id,host,user,password,domain,created_at,last_checked_at) VALUES ('tz','imap.test','tz','pw','example.test',?,?)").run(stored, stored);
    db.prepare("INSERT INTO yyds_accounts (api_key,created_at,last_used_at) VALUES ('tz',?,?)").run(stored, stored);
    db.prepare("INSERT INTO icloud_accounts (id,apple_id,created_at,last_checked_at) VALUES ('tz','tz@icloud.com',?,?)").run(stored, stored);
    db.prepare("INSERT INTO icloud_addresses (hme,account_id,anonymous_id,created_at,assigned_at) VALUES ('tz@icloud.com','tz','tz',?,?)").run(stored, stored);
    db.prepare("INSERT INTO activity_log (text,created_at) VALUES ('timezone test',?)").run(stored);
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('backup_enabled','1',?)").run(stored);
    db.prepare("UPDATE template_providers SET created_at=?,updated_at=?").run(stored, stored);
  });

  it.each([
    ['/inboxes', 'inboxes.0.created_at'], ['/inbox/tz', 'expires_at'], ['/inbox/tz', 'created_at'],
    ['/blocks', 'blocks.0.blocked_at'], ['/block-rules', 'rules.0.created_at'],
    ['/keys', 'keys.0.createdAt'], ['/keys', 'keys.0.lastUsedAt'],
    ['/services', 'services.0.lastUsed'], ['/services/date.test', 'stats.firstUsed'],
    ['/services/date.test', 'inboxes.0.created_at'], ['/services/date.test', 'failures.0.reported_at'],
    ['/outlook/accounts', 'accounts.0.token_renewed_at'], ['/outlook/accounts', 'accounts.0.created_at'],
    ['/imap/accounts', 'accounts.0.last_checked_at'], ['/imap/accounts/tz', 'account.created_at'],
    ['/yyds/accounts', 'accounts.0.last_used_at'], ['/icloud/accounts', 'accounts.0.created_at'],
    ['/icloud/addresses', 'addresses.0.assigned_at'], ['/activity', 'activities.0.time'],
    ['/admin/settings', 'updatedAt.backup_enabled'], ['/template-providers', 'providers.0.updated_at'],
  ])('%s exposes %s as ISO UTC', async (path, field) => {
    const res = await app.request(`/api${path}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(field.split('.').reduce((value, key) => value?.[key], body)).toBe(iso);
    expect(getDb().prepare("SELECT created_at FROM inboxes WHERE id='tz'").get()).toEqual({ created_at: stored });
  });

  it('serializes timestamps on iCloud account creation as well as list responses', async () => {
    const res = await app.request('/api/icloud/accounts', {
      method:'POST', headers:jsonHeaders(),
      body:JSON.stringify({appleId:'new@icloud.test',cookies:'X-APPLE-WEBAUTH-TOKEN=token; X-APPLE-WEBAUTH-USER=user'}),
    });
    expect(res.status).toBe(200);
    const { account } = await res.json();
    const storedRow = getDb().prepare('SELECT created_at FROM icloud_accounts WHERE id=?').get(account.id) as {created_at:string};
    expect(account.created_at).toBe(storedRow.created_at.replace(' ','T') + '.000Z');
    expect(account.last_checked_at).toBeNull();
  });
});
