import { registry } from './registry.js';
import { allRows, getDb } from '../db.js';
import { createLogger } from '../logger.js';
import { seedDispatchRulesFromPriority } from '../dispatch-rules.js';

const log = createLogger('providers');
import { ImapProvider } from './imap.js';
import { OutlookProvider } from './outlook.js';
import { YydsProvider } from './yyds.js';
import { IcloudProvider } from './icloud.js';
import { TemplateProvider, type TemplateProviderConfig } from './template-provider.js';
import { BUILTIN_TEMPLATES } from './builtin-templates.js';

export function registerAllProviders(): void {
  seedBuiltinTemplates();

  registry.register(new ImapProvider());
  registry.register(new OutlookProvider());
  registry.register(new YydsProvider());
  registry.register(new IcloudProvider());

  registerTemplateProviders();

  // Needs trustLevel from the registered providers, so it cannot live in initDb().
  seedDispatchRulesFromPriority();
}

function seedBuiltinTemplates(): void {
  const db = getDb();
  for (const entry of BUILTIN_TEMPLATES) {
    const cfg = entry.config;
    const existing = db.prepare(`SELECT name FROM template_providers WHERE name = ?`).get(cfg.name);
    if (!existing) {
      db.prepare(`INSERT INTO template_providers (name, config_json, enabled) VALUES (?, ?, ?)`)
        .run(cfg.name, JSON.stringify(cfg), entry.defaultEnabled === false ? 0 : 1);
    }
  }
}

function registerTemplateProviders(): void {
  const db = getDb();
  const rows = allRows<{ name: string; config_json: string }>(
    db,
    `SELECT name, config_json FROM template_providers WHERE enabled = 1`,
  );
  for (const row of rows) {
    try {
      const raw = JSON.parse(row.config_json);
      const cfg = (raw.config ?? raw) as TemplateProviderConfig;
      if (!cfg.name) { log.error('template provider missing name', { row: row.name }); continue; }
      registry.register(new TemplateProvider(cfg));
    } catch (e) {
      log.error('failed to load template provider', { name: row.name, error: e });
    }
  }
}

export { registry } from './registry.js';
export type { BaseProvider, ProviderMeta, InboxData, Message, MessageDetail } from './base.js';
