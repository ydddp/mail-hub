import { Hono } from 'hono';
import { allRows, getDb, getRow, logActivity } from '../db.js';
import { requireAdmin, type AdminEnv } from './admin.js';
import { TemplateProvider, type TemplateProviderConfig } from '../providers/template-provider.js';
import { registry } from '../providers/registry.js';
import { errorMessage } from '../errors.js';
import type { InboxData } from '../providers/base.js';

export const templateProviderRoutes = new Hono<AdminEnv>();

interface TemplateProviderRow {
  name?: string;
  config_json: string;
  enabled: number;
  created_at?: string;
  updated_at?: string;
}

templateProviderRoutes.use('/template-providers/*', requireAdmin);

templateProviderRoutes.get('/template-providers', (c) => {
  const db = getDb();
  const rows = allRows<TemplateProviderRow>(
    db,
    `SELECT name, config_json, enabled, created_at, updated_at FROM template_providers ORDER BY created_at DESC`,
  );
  const providers = rows.map(r => {
    const raw = JSON.parse(r.config_json);
    const cfg = raw.config ?? raw;
    return { ...cfg, enabled: r.enabled === 1, created_at: r.created_at, updated_at: r.updated_at };
  });
  return c.json({ providers });
});

templateProviderRoutes.get('/template-providers/:name', (c) => {
  const db = getDb();
  const row = getRow<TemplateProviderRow>(
    db,
    `SELECT config_json, enabled FROM template_providers WHERE name = ?`,
    c.req.param('name'),
  );
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ config: JSON.parse(row.config_json), enabled: row.enabled === 1 });
});

templateProviderRoutes.post('/template-providers', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cfg = body.config as TemplateProviderConfig;
  if (!cfg?.name || !cfg?.apiBase || !cfg?.create || !cfg?.messages || !cfg?.messageDetail) {
    return c.json({ error: 'Incomplete configuration: name, apiBase, create, messages, messageDetail required' }, 400);
  }

  const db = getDb();
  const existing = db.prepare(`SELECT name FROM template_providers WHERE name = ?`).get(cfg.name);
  if (existing) return c.json({ error: 'Name already exists' }, 409);

  db.prepare(`INSERT INTO template_providers (name, config_json) VALUES (?, ?)`).run(cfg.name, JSON.stringify(cfg));

  try {
    registry.register(new TemplateProvider(cfg));
  } catch (e) {
    db.prepare(`DELETE FROM template_providers WHERE name = ?`).run(cfg.name);
    return c.json({ error: `Registration failed: ${errorMessage(e)}` }, 500);
  }

  logActivity('green', `Added template provider: ${cfg.displayName || cfg.name}`);
  return c.json({ success: true, name: cfg.name });
});

templateProviderRoutes.put('/template-providers/:name', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json().catch(() => ({}));
  const cfg = body.config as TemplateProviderConfig;
  if (!cfg?.name || !cfg?.apiBase || !cfg?.create || !cfg?.messages || !cfg?.messageDetail) {
    return c.json({ error: 'Incomplete configuration' }, 400);
  }

  const db = getDb();
  const existing = db.prepare(`SELECT name FROM template_providers WHERE name = ?`).get(name);
  if (!existing) return c.json({ error: 'Not found' }, 404);

  cfg.name = name;
  db.prepare(`UPDATE template_providers SET config_json = ?, updated_at = datetime('now') WHERE name = ?`).run(JSON.stringify(cfg), name);

  registry.unregister(name);
  const enabled = getRow<{ enabled: number }>(db, `SELECT enabled FROM template_providers WHERE name = ?`, name);
  if (enabled?.enabled === 1) {
    registry.register(new TemplateProvider(cfg));
  }

  logActivity('blue', `Updated template provider: ${cfg.displayName || cfg.name}`);
  return c.json({ success: true });
});

templateProviderRoutes.delete('/template-providers/:name', (c) => {
  const name = c.req.param('name');
  const db = getDb();
  db.prepare(`DELETE FROM template_providers WHERE name = ?`).run(name);
  registry.unregister(name);
  logActivity('amber', `Deleted template provider: ${name}`);
  return c.json({ success: true });
});

templateProviderRoutes.patch('/template-providers/:name/toggle', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json().catch(() => ({}));
  const enabled: boolean = body.enabled ?? true;
  const db = getDb();

  const row = getRow<{ config_json: string }>(db, `SELECT config_json FROM template_providers WHERE name = ?`, name);
  if (!row) return c.json({ error: 'Not found' }, 404);

  db.prepare(`UPDATE template_providers SET enabled = ?, updated_at = datetime('now') WHERE name = ?`).run(enabled ? 1 : 0, name);

  if (enabled) {
    const raw = JSON.parse(row.config_json);
    const cfg = (raw.config ?? raw) as TemplateProviderConfig;
    registry.register(new TemplateProvider(cfg));
  } else {
    registry.unregister(name);
  }

  logActivity('blue', `${enabled ? 'Enabled' : 'Disabled'} template provider: ${name}`);
  return c.json({ success: true, enabled });
});

templateProviderRoutes.post('/template-providers/:name/test', async (c) => {
  const name = c.req.param('name');
  const db = getDb();
  const row = getRow<{ config_json: string }>(db, `SELECT config_json FROM template_providers WHERE name = ?`, name);
  if (!row) return c.json({ error: 'Not found' }, 404);

  const raw = JSON.parse(row.config_json);
  const cfg = (raw.config ?? raw) as TemplateProviderConfig;
  const provider = new TemplateProvider(cfg);
  const steps: { step: string; ok: boolean; detail?: string; error?: string }[] = [];
  const isFromCreate = cfg.domains.mode === 'from_create';

  let inbox: InboxData;

  if (!isFromCreate) {
    let domains: string[] = [];
    try {
      domains = await provider.getDomains();
      if (domains.length === 0) {
        steps.push({ step: 'getDomains', ok: false, error: 'No available domains' });
        return c.json({ success: false, steps });
      }
      steps.push({ step: 'getDomains', ok: true, detail: `${domains.length} domains: ${domains.slice(0, 3).join(', ')}` });
    } catch (e) {
      steps.push({ step: 'getDomains', ok: false, error: errorMessage(e) });
      return c.json({ success: false, steps });
    }

    try {
      inbox = await provider.createInbox({ domain: domains[0] });
      steps.push({ step: 'createInbox', ok: true, detail: inbox.address });
    } catch (e) {
      steps.push({ step: 'createInbox', ok: false, error: errorMessage(e) });
      return c.json({ success: false, steps });
    }
  } else {
    try {
      inbox = await provider.createInbox();
      steps.push({ step: 'createInbox', ok: true, detail: inbox.address });
    } catch (e) {
      steps.push({ step: 'createInbox', ok: false, error: errorMessage(e) });
      return c.json({ success: false, steps });
    }
  }

  try {
    const msgs = await provider.getMessages(inbox);
    steps.push({ step: 'getMessages', ok: true, detail: `${msgs.length} messages` });
  } catch (e) {
    steps.push({ step: 'getMessages', ok: false, error: errorMessage(e) });
  }

  try {
    await provider.deleteInbox(inbox);
    steps.push({ step: 'deleteInbox', ok: true });
  } catch (e) {
    steps.push({ step: 'deleteInbox', ok: false, error: errorMessage(e) });
  }

  const allOk = steps.every(s => s.ok);
  return c.json({ success: allOk, steps });
});
