import { describe, expect, it } from 'vitest';
import { memoryKeyValueStore } from '../userscript/src/gm.js';
import {
  CONNECTIONS_KEY,
  CONNECTION_KEY,
  activeProfile,
  emptyBook,
  loadConnectionBook,
  removeProfile,
  selectProfile,
  upsertProfile,
} from '../userscript/src/storage.js';
import type { ConnectionBook } from '../userscript/src/storage.js';

/**
 * Several Mail Hub connections, one active. The contract the panel relies on:
 * an address and its key always travel together, switching never mixes them,
 * and the single connection saved before profiles existed is not lost.
 */

const home = { baseUrl: 'https://mail.home.example', apiKey: 'mk_home', insecure: false };
const vps = { baseUrl: 'https://mail.vps.example', apiKey: 'mk_vps', insecure: false };

function add(book: ConnectionBook, entry: typeof home, label: string | null = null) {
  return upsertProfile(book, { editingId: null, label, ...entry }).book;
}

describe('connection book', () => {
  it('adopts the single connection saved before profiles existed', async () => {
    const store = memoryKeyValueStore({ [CONNECTION_KEY]: home });
    const book = await loadConnectionBook(store);
    expect(book.profiles).toHaveLength(1);
    expect(activeProfile(book)).toMatchObject(home);
  });

  it('reads an empty book when nothing was ever saved', async () => {
    expect(await loadConnectionBook(memoryKeyValueStore())).toEqual(emptyBook());
  });

  it('a stored book wins over the legacy entry', async () => {
    const book = add(add(emptyBook(), home), vps);
    const store = memoryKeyValueStore({ [CONNECTION_KEY]: home, [CONNECTIONS_KEY]: book });
    const loaded = await loadConnectionBook(store);
    expect(loaded.profiles.map((entry) => entry.apiKey)).toEqual(['mk_home', 'mk_vps']);
    expect(activeProfile(loaded)?.apiKey).toBe('mk_vps');
  });

  it.each<[string, (book: ConnectionBook) => ConnectionBook, { keys: string[]; active: string | null }]>([
    ['adding makes the new one active', (book) => add(book, vps), { keys: ['mk_home', 'mk_vps'], active: 'mk_vps' }],
    ['the same address and key is not added twice', (book) => add(book, home, '家里'), { keys: ['mk_home'], active: 'mk_home' }],
    ['switching changes address and key together', (book) => selectProfile(add(book, vps), book.profiles[0].id), { keys: ['mk_home', 'mk_vps'], active: 'mk_home' }],
    ['switching to an unknown id changes nothing', (book) => selectProfile(book, 'nope'), { keys: ['mk_home'], active: 'mk_home' }],
    ['removing the active one falls back to the next', (book) => {
      const two = add(book, vps);
      return removeProfile(two, two.activeId!);
    }, { keys: ['mk_home'], active: 'mk_home' }],
    ['removing the last one leaves nothing active', (book) => removeProfile(book, book.profiles[0].id), { keys: [], active: null }],
  ])('%s', (_name, change, expected) => {
    const next = change(add(emptyBook(), home));
    expect(next.profiles.map((entry) => entry.apiKey)).toEqual(expected.keys);
    expect(activeProfile(next)?.apiKey ?? null).toBe(expected.active);
  });

  it('editing keeps the profile in place, and a rotated key replaces the old one', () => {
    const book = add(add(emptyBook(), home), vps);
    const homeId = book.profiles[0].id;
    const { book: edited } = upsertProfile(book, { editingId: homeId, label: '家里', ...home, apiKey: 'mk_home_rotated' });
    expect(edited.profiles.map((entry) => entry.apiKey)).toEqual(['mk_home_rotated', 'mk_vps']);
    expect(edited.profiles[0]).toMatchObject({ id: homeId, label: '家里' });
    // Editing is not switching: the connection in use stays in use.
    expect(activeProfile(edited)?.apiKey).toBe('mk_vps');
  });

  it('editing the connection in use keeps it in use', () => {
    const book = add(add(emptyBook(), home), vps);
    const { book: edited } = upsertProfile(book, { editingId: book.activeId, label: 'VPS', ...vps });
    expect(activeProfile(edited)).toMatchObject({ label: 'VPS', apiKey: 'mk_vps' });
  });

  it('an edit that now equals another profile folds the two into one', () => {
    const book = add(add(emptyBook(), home), vps);
    const { book: edited } = upsertProfile(book, { editingId: book.profiles[0].id, label: null, ...vps });
    expect(edited.profiles).toHaveLength(1);
    expect(activeProfile(edited)?.apiKey).toBe('mk_vps');
  });
});
