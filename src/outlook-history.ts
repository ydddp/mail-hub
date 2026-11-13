import { createHash, randomBytes } from 'crypto';
import { parseTimestamp } from './time.js';
import { rateLimiter } from './rate-limiter.js';
import { UpstreamHttpError } from './errors.js';
import type { Message } from './providers/base.js';
import { runReadOperation, withReadBudget } from './read-budget.js';

export interface HistoryFolder {
  folder: string;
  next: string | null;
  buffer: Message[];
  uidValidity?: string;
  upperUid?: number;
  beforeUid?: number;
}
export interface OutlookHistoryState {
  apiType: 'graph' | 'outlook' | 'imap';
  limit: number;
  folders: HistoryFolder[];
  emitted: Set<string>;
  ceiling?: number;
  // Shared by this browsing chain, including failed inputs and cached pages.
  // Only the provider's current operation may acknowledge its own rotation.
  credentials: { fingerprint: string };
}
export interface HistoryReadControl {
  run<T>(operation: () => Promise<T>): Promise<T>;
  read<T>(operation: () => Promise<T>): Promise<T>;
  checkpoint(): void;
}
type HistoryPage = { messages: Message[]; limit: number; nextPageToken: string | null };
interface Entry {
  email: string;
  adminHash: string;
  expiresAt: number;
  state: OutlookHistoryState;
  response?: HistoryPage;
  pending?: Promise<HistoryPage>;
}
const states = new Map<string, Entry>();
const TTL = 10 * 60_000;
const MAX_STATES = 100;

export class OutlookHistoryTokenError extends Error {
  constructor() { super('Outlook history page expired or invalid; reload the mailbox'); }
}

function remember(entry: Entry): string {
  for (const [token, candidate] of states) if (candidate.expiresAt <= Date.now()) states.delete(token);
  const token = randomBytes(32).toString('base64url');
  states.set(token, entry);
  while (states.size > MAX_STATES) states.delete(states.keys().next().value!);
  return token;
}

function clone(state: OutlookHistoryState): OutlookHistoryState {
  return { ...state, emitted: new Set(state.emitted), folders: state.folders.map(folder => ({ ...folder, buffer: folder.buffer.slice() })) };
}
function order(a: Message, b: Message): number {
  return (parseTimestamp(b.receivedAt) || 0) - (parseTimestamp(a.receivedAt) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A token names an immutable page input; only successful reads publish its successor. */
export function readOutlookHistory(...args: Parameters<typeof readHistory>): Promise<HistoryPage> {
  return withReadBudget({ signal: args[7], deadline: args[8] ?? Date.now() + 30_000 }, () => readHistory(...args));
}

async function readHistory(
  email: string, adminKey: string, pageToken: string | undefined, limit: number,
  initialize: (control: HistoryReadControl) => Promise<OutlookHistoryState>,
  load: (state: OutlookHistoryState, folder: HistoryFolder, control: HistoryReadControl) => Promise<void>,
  validate: (state: OutlookHistoryState) => void,
  signal?: AbortSignal,
  deadline = Date.now() + 30_000,
  prepare?: (state: OutlookHistoryState, control: HistoryReadControl) => Promise<void>,
): Promise<HistoryPage> {
  const adminHash = createHash('sha256').update(adminKey).digest('hex');
  const control: HistoryReadControl = {
    checkpoint() {
      if (signal?.aborted || Date.now() >= deadline) throw new Error('Outlook history read timed out; retry this page');
    },
    async run(operation) {
      control.checkpoint();
      const value = await runReadOperation({}, operation);
      control.checkpoint();
      return value;
    },
    read(operation) {
      control.checkpoint();
      if (!rateLimiter.isPollAvailable('outlook')) throw new UpstreamHttpError('Outlook poll rate limit exceeded', 429, rateLimiter.getPollStatus('outlook').nextAvailableAt);
      rateLimiter.recordPoll('outlook');
      return control.run(operation);
    },
  };
  let entry: Entry;
  if (pageToken !== undefined) {
    const found = states.get(pageToken);
    if (!found || found.email !== email || found.adminHash !== adminHash || found.expiresAt <= Date.now()) throw new OutlookHistoryTokenError();
    states.delete(pageToken); states.set(pageToken, found);
    entry = found;
    validate(entry.state);
    if (entry.response) return entry.response;
    if (entry.pending) return control.run(() => entry.pending!);
  } else entry = { email, adminHash, expiresAt: Date.now() + TTL, state: await initialize(control) };

  const pending = (async () => {
    const state = clone(entry.state);
    if (prepare) await prepare(state, control);
    const messages: Message[] = [];
    const prune = () => { for (const folder of state.folders) folder.buffer = folder.buffer.filter(message => !state.emitted.has(message.id) && (state.ceiling === undefined || (parseTimestamp(message.receivedAt) || 0) <= state.ceiling)); };
    while (messages.length < state.limit) {
      control.checkpoint(); validate(state); prune();
      for (const folder of state.folders) {
        while (!folder.buffer.length && folder.next !== null) {
          await load(state, folder, control);
          control.checkpoint(); validate(state); prune();
        }
      }
      const next = state.folders.filter(folder => folder.buffer.length).sort((a, b) => order(a.buffer[0], b.buffer[0]))[0];
      if (!next) break;
      const message = next.buffer.shift()!;
      // IMAP already freezes each folder's UID ceiling. INTERNALDATE need not
      // increase with UID (e.g. imported mail), so a time ceiling loses mail.
      if (state.apiType !== 'imap' && state.ceiling === undefined) state.ceiling = parseTimestamp(message.receivedAt) || 0;
      state.emitted.add(message.id); messages.push(message); prune();
    }
    control.checkpoint(); validate(state);
    const more = state.folders.some(folder => folder.buffer.length || folder.next !== null);
    const nextPageToken = more ? remember({ email, adminHash, expiresAt: entry.expiresAt, state }) : null;
    const response = { messages: messages.sort(order), limit: state.limit, nextPageToken };
    entry.response = response;
    return response;
  })();
  entry.pending = pending;
  try { return await pending; } finally { entry.pending = undefined; }
}
