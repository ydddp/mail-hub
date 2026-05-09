import { registry } from './providers/registry.js';
import type { InboxData } from './providers/base.js';
import { createLogger } from './logger.js';
import { logIgnoredError } from './errors.js';

const log = createLogger('inbox-lifecycle');

export interface StoredInbox {
  id: string;
  provider: string;
  address: string;
  authData: Record<string, string>;
  apiBase: string;
}

export function parseStoredInbox(row: unknown[] | {
  id: string;
  provider: string;
  address: string;
  auth_data: string;
  api_base: string | null;
}): StoredInbox {
  const id = Array.isArray(row) ? row[0] : row.id;
  const provider = Array.isArray(row) ? row[1] : row.provider;
  const address = Array.isArray(row) ? row[2] : row.address;
  const authDataStr = Array.isArray(row) ? row[3] : row.auth_data;
  const apiBase = Array.isArray(row) ? row[4] : row.api_base;
  return {
    id: id as string,
    provider: provider as string,
    address: address as string,
    authData: JSON.parse(authDataStr as string),
    apiBase: (apiBase as string) || '',
  };
}

export function toInboxData(inbox: StoredInbox): InboxData {
  return {
    address: inbox.address,
    authData: inbox.authData,
    provider: inbox.provider,
    apiBase: inbox.apiBase,
  };
}

export function rowToInboxData(row: { address: string; auth_data: string; provider: string; api_base: string | null }): InboxData {
  return {
    address: row.address,
    authData: JSON.parse(row.auth_data),
    provider: row.provider,
    apiBase: row.api_base || '',
  };
}

export async function releaseInboxResources(
  inbox: StoredInbox,
  opts: { deleteExternal?: boolean } = {}
): Promise<void> {
  const provider = registry.get(inbox.provider);
  const inboxData = toInboxData(inbox);

  if (opts.deleteExternal && provider?.deleteInbox) {
    await provider.deleteInbox(inboxData).catch((error: unknown) => {
      logIgnoredError(log, 'provider inbox deletion failed', error, { inboxId: inbox.id, provider: inbox.provider });
    });
  }

  await provider?.releaseInbox?.(inboxData, inbox.id).catch((error: unknown) => {
    logIgnoredError(log, 'provider inbox release failed', error, { inboxId: inbox.id, provider: inbox.provider });
  });
}
