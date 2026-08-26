import type { Message, MessageDetail } from './base.js';
import {
  assertMailboxReadable,
  fetchMessageDetailAcrossMailboxes,
  fetchMessagesAcrossMailboxes,
  type ImapCreds,
} from './imap-core.js';

const IMAP_HOST = 'outlook.office365.com';
const IMAP_PORT = 993;

/**
 * Kept verbatim: it is the string the folder-boundary tests pin, and it names
 * Outlook so an operator reading a 502 knows which transport refused.
 */
const INVALID_MESSAGE_ID = 'Invalid Outlook IMAP message id';

export function outlookImapCreds(email: string, accessToken: string, proxy?: string): ImapCreds {
  return {
    poolKey: `outlook:${email}`,
    host: IMAP_HOST,
    port: IMAP_PORT,
    user: email,
    accessToken,
    tls: true,
    ...(proxy ? { proxy } : {}),
    connectionTimeout: 10000,
    socketTimeout: 30000,
  };
}

export async function fetchOutlookImapMessages(creds: ImapCreds, limit: number): Promise<Message[]> {
  // Outlook's mailbox view is newest-first, unlike the catch-all providers
  // whose listings the SPA reverses itself. The shared merge is ascending, so
  // this is where the two conventions meet.
  const messages = await fetchMessagesAcrossMailboxes(creds, { all: true }, { limit });
  return messages.reverse();
}

export async function fetchOutlookImapMessage(creds: ImapCreds, messageId: string): Promise<MessageDetail> {
  // No allowBareUid: this transport has always minted mailbox-qualified ids,
  // so a bare UID could only ever be a guess at someone else's message.
  return fetchMessageDetailAcrossMailboxes(creds, messageId, { invalidMessage: INVALID_MESSAGE_ID });
}

export async function checkOutlookImap(creds: ImapCreds): Promise<void> {
  await assertMailboxReadable(creds);
}
