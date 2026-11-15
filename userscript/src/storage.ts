import type { KeyValueStore } from './gm.js';

/** Persisted view of one assistant run. Kept in the script manager, never the page. */
export type Phase =
  | 'idle'
  | 'creating'
  | 'create-unknown'
  | 'polling'
  | 'result'
  | 'reporting'
  | 'report-unknown'
  | 'reported'
  | 'closing'
  | 'close-failed'
  | 'closed';

export interface SessionInbox {
  id: string;
  address: string;
  provider: string;
  /** `for` value frozen at creation; reporting always uses this one. */
  service: string;
  expiresAt: string | null;
  createdAt: number;
}

/**
 * The last message the poll returned, kept with the run so a page navigation
 * (the site moving on to its "enter the code" step) does not lose it.
 */
export interface StoredResult {
  messageId: string | null;
  receivedAt: string | null;
  codes: Array<{ type: 'numeric' | 'alphanumeric' | 'link'; value: string; context?: string }>;
  subject: string | null;
  from: string | null;
  /** The code was filled/copied or the link opened. */
  used: boolean;
}

export interface SessionPage {
  url: string;
  service: string | null;
}

export interface SessionState {
  version: 1;
  /** Connection identity this run belongs to; a different connection cannot see it. */
  ownerId: string;
  tabId: string | null;
  phase: Phase;
  inbox: SessionInbox | null;
  /** Provider for the next allocation only. Never changes an existing inbox. */
  nextProvider: string | null;
  reported: boolean;
  reportedAt: number | null;
  seenMessageIds: string[];
  /** Absent in runs stored before it existed; read as null. */
  lastResult?: StoredResult | null;
  page: SessionPage | null;
  /** Set before an action that may have reached the server. */
  requestStartedAt: number | null;
  updatedAt: number;
}

export const SESSION_VERSION = 1 as const;

export interface SessionStore {
  load(): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  clear(): Promise<void>;
}

export function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    inbox: state.inbox ? { ...state.inbox } : null,
    seenMessageIds: [...state.seenMessageIds],
    lastResult: state.lastResult
      ? { ...state.lastResult, codes: state.lastResult.codes.map((code) => ({ ...code })) }
      : null,
    page: state.page ? { ...state.page } : null,
  };
}

export function emptySessionState(init: {
  ownerId: string;
  tabId: string | null;
  now: number;
}): SessionState {
  return {
    version: SESSION_VERSION,
    ownerId: init.ownerId,
    tabId: init.tabId,
    phase: 'idle',
    inbox: null,
    nextProvider: null,
    reported: false,
    reportedAt: null,
    seenMessageIds: [],
    lastResult: null,
    page: null,
    requestStartedAt: null,
    updatedAt: init.now,
  };
}

/**
 * Storage keys must be stable for one connection and different for another, so
 * switching API keys cannot surface the previous key's inbox. The key itself is
 * never part of the name.
 */
export function identityId(baseUrl: string, apiKey: string): string {
  return `${baseUrl.toLowerCase().replace(/\/+$/, '')}#${shortHash(apiKey)}`;
}

export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function sessionKey(ownerId: string, tabId: string | null): string {
  return `mailhub.session.${ownerId}.${tabId ?? 'notab'}`;
}

export function memorySessionStore(initial: SessionState | null = null): SessionStore {
  let current = initial ? cloneSessionState(initial) : null;
  return {
    async load() {
      return current ? cloneSessionState(current) : null;
    },
    async save(state) {
      current = cloneSessionState(state);
    },
    async clear() {
      current = null;
    },
  };
}

export function keyValueSessionStore(store: KeyValueStore, key: string): SessionStore {
  return {
    async load() {
      const stored = await store.get<SessionState | null>(key, null);
      if (!stored || stored.version !== SESSION_VERSION) return null;
      return cloneSessionState(stored);
    },
    async save(state) {
      await store.set(key, cloneSessionState(state));
    },
    async clear() {
      await store.remove(key);
    },
  };
}

export type ThemePreference = 'system' | 'light' | 'dark';

export interface StoredPosition {
  x: number;
  y: number;
}

export interface AssistantSettings {
  version: 1;
  theme: ThemePreference;
  /** Remembered "current site → service" corrections, keyed by host or main domain. */
  mappings: Record<string, string>;
  /** Main domains where the assistant is enabled at all. */
  enabledSites: string[];
  /** Main domains hidden for this visit only; cleared when the tab reloads. */
  hiddenForVisit: string[];
  /** Main domains where the assistant must never show a floating button. */
  hiddenSites: string[];
  /** Last provider choice per connection identity; null means auto. */
  lastProvider: Record<string, string | null>;
  /** Panel top-left per main domain, so a moved panel comes back where it was. */
  panelPositions: Record<string, StoredPosition>;
  /** Floating button top-left per main domain. */
  fabPositions: Record<string, StoredPosition>;
  shortcut: string;
}

export const SETTINGS_VERSION = 1 as const;
export const SETTINGS_KEY = 'mailhub.settings';

export function emptySettings(): AssistantSettings {
  return {
    version: SETTINGS_VERSION,
    theme: 'system',
    mappings: {},
    enabledSites: [],
    hiddenForVisit: [],
    hiddenSites: [],
    lastProvider: {},
    panelPositions: {},
    fabPositions: {},
    shortcut: 'Alt+Shift+M',
  };
}

export async function loadSettings(store: KeyValueStore): Promise<AssistantSettings> {
  const stored = await store.get<Partial<AssistantSettings> | null>(SETTINGS_KEY, null);
  const base = emptySettings();
  if (!stored || stored.version !== SETTINGS_VERSION) return base;
  return {
    ...base,
    ...stored,
    version: SETTINGS_VERSION,
    mappings: { ...(stored.mappings ?? {}) },
    enabledSites: [...(stored.enabledSites ?? [])],
    hiddenForVisit: [...(stored.hiddenForVisit ?? [])],
    hiddenSites: [...(stored.hiddenSites ?? [])],
    lastProvider: { ...(stored.lastProvider ?? {}) },
    panelPositions: validPositions(stored.panelPositions),
    fabPositions: validPositions(stored.fabPositions),
  };
}

/** A stored position is only usable if both coordinates are finite numbers. */
function validPositions(input: unknown): Record<string, StoredPosition> {
  const result: Record<string, StoredPosition> = {};
  if (!input || typeof input !== 'object') return result;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const entry = value as Partial<StoredPosition> | null;
    if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
    result[key] = { x: Math.round(entry.x as number), y: Math.round(entry.y as number) };
  }
  return result;
}

export async function saveSettings(store: KeyValueStore, settings: AssistantSettings): Promise<void> {
  await store.set(SETTINGS_KEY, settings);
}

/** Connection settings live with the identity so a key change cannot reuse them. */
export interface ConnectionSettings {
  baseUrl: string;
  apiKey: string;
  insecure: boolean;
}

export const CONNECTION_KEY = 'mailhub.connection';

export async function loadConnection(store: KeyValueStore): Promise<ConnectionSettings | null> {
  const stored = await store.get<Partial<ConnectionSettings> | null>(CONNECTION_KEY, null);
  if (!stored || typeof stored.baseUrl !== 'string' || typeof stored.apiKey !== 'string') return null;
  if (!stored.baseUrl || !stored.apiKey) return null;
  return { baseUrl: stored.baseUrl, apiKey: stored.apiKey, insecure: stored.insecure === true };
}

export async function saveConnection(store: KeyValueStore, connection: ConnectionSettings): Promise<void> {
  await store.set(CONNECTION_KEY, connection);
}

export async function clearConnection(store: KeyValueStore): Promise<void> {
  await store.remove(CONNECTION_KEY);
}

/**
 * Several Mail Hub connections, one active. Each profile is an address and its
 * key saved together, so switching profiles always switches both.
 */
export interface ConnectionProfile extends ConnectionSettings {
  id: string;
  /** User's own name for it; the host is shown when absent. */
  label: string | null;
}

export interface ConnectionBook {
  version: 1;
  activeId: string | null;
  profiles: ConnectionProfile[];
}

export const CONNECTIONS_KEY = 'mailhub.connections';

export function emptyBook(): ConnectionBook {
  return { version: 1, activeId: null, profiles: [] };
}

function validProfile(value: unknown): ConnectionProfile | null {
  const entry = value as Partial<ConnectionProfile> | null;
  if (!entry || typeof entry.id !== 'string' || typeof entry.baseUrl !== 'string' || typeof entry.apiKey !== 'string') return null;
  if (!entry.id || !entry.baseUrl || !entry.apiKey) return null;
  return {
    id: entry.id,
    label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    insecure: entry.insecure === true,
  };
}

/**
 * Reads the book, adopting the single connection stored before profiles
 * existed. The legacy entry is left in place; it is simply no longer read once
 * a book exists.
 */
export async function loadConnectionBook(store: KeyValueStore): Promise<ConnectionBook> {
  const stored = await store.get<Partial<ConnectionBook> | null>(CONNECTIONS_KEY, null);
  if (stored && stored.version === 1 && Array.isArray(stored.profiles)) {
    const profiles = stored.profiles.map(validProfile).filter((entry): entry is ConnectionProfile => entry !== null);
    const activeId = profiles.some((entry) => entry.id === stored.activeId) ? stored.activeId ?? null : profiles[0]?.id ?? null;
    return { version: 1, activeId, profiles };
  }
  const legacy = await loadConnection(store);
  if (!legacy) return emptyBook();
  const profile: ConnectionProfile = { ...legacy, id: profileId(legacy.baseUrl, legacy.apiKey), label: null };
  return { version: 1, activeId: profile.id, profiles: [profile] };
}

export async function saveConnectionBook(store: KeyValueStore, book: ConnectionBook): Promise<void> {
  await store.set(CONNECTIONS_KEY, book);
}

export function profileId(baseUrl: string, apiKey: string): string {
  return `c-${shortHash(`${baseUrl.toLowerCase()}\n${apiKey}`)}`;
}

export function activeProfile(book: ConnectionBook): ConnectionProfile | null {
  return book.profiles.find((entry) => entry.id === book.activeId) ?? null;
}

export function profileTitle(profile: ConnectionProfile): string {
  if (profile.label) return profile.label;
  try {
    return new URL(profile.baseUrl).host;
  } catch {
    return profile.baseUrl;
  }
}

/**
 * Add or edit a profile. Adding makes it active; editing never switches (it
 * stays active only if it already was). Editing keeps the profile's place
 * in the list; saving an address + key that another profile already has
 * replaces that one instead of creating a duplicate.
 */
export function upsertProfile(
  book: ConnectionBook,
  input: { editingId: string | null; label: string | null; baseUrl: string; apiKey: string; insecure: boolean },
): { book: ConnectionBook; profile: ConnectionProfile } {
  const label = input.label && input.label.trim() ? input.label.trim() : null;
  const duplicate = book.profiles.find((entry) => entry.id !== input.editingId
    && entry.baseUrl.toLowerCase() === input.baseUrl.toLowerCase() && entry.apiKey === input.apiKey);
  const editing = input.editingId ? book.profiles.find((entry) => entry.id === input.editingId) ?? null : null;
  const target = editing ?? duplicate ?? null;
  const profile: ConnectionProfile = {
    id: target?.id ?? profileId(input.baseUrl, input.apiKey),
    label: label ?? (target && target === duplicate ? target.label : null),
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    insecure: input.insecure,
  };
  let profiles = target
    ? book.profiles.map((entry) => (entry.id === target.id ? profile : entry))
    : [...book.profiles, profile];
  // An edit that now equals another profile folds the two into one.
  if (editing && duplicate) profiles = profiles.filter((entry) => entry.id !== duplicate.id);
  const wasActive = target !== null && (target.id === book.activeId || (editing !== null && duplicate?.id === book.activeId));
  const activeId = !editing || wasActive ? profile.id : book.activeId;
  return { book: { version: 1, activeId, profiles }, profile };
}

export function removeProfile(book: ConnectionBook, id: string): ConnectionBook {
  const profiles = book.profiles.filter((entry) => entry.id !== id);
  const activeId = book.activeId === id ? profiles[0]?.id ?? null : book.activeId;
  return { version: 1, activeId, profiles };
}

export function selectProfile(book: ConnectionBook, id: string): ConnectionBook {
  if (!book.profiles.some((entry) => entry.id === id)) return book;
  return { ...book, activeId: id };
}
