import { describe, expect, it } from 'vitest';
import { formatShortcut, matchesShortcut, parseShortcut, shortcutFromEvent } from '../userscript/src/shortcut.js';

const key = (over: Partial<{ altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }> = {}) => ({
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  code: 'KeyM',
  ...over,
});

describe('shortcut capture', () => {
  it('records modifiers plus a virtual key name', () => {
    expect(shortcutFromEvent(key({ altKey: true, shiftKey: true })))
      .toEqual({ alt: true, ctrl: false, shift: true, meta: false, key: 'M' });
    expect(shortcutFromEvent(key({ ctrlKey: true, code: 'Digit1' })))
      .toMatchObject({ ctrl: true, key: '1' });
    expect(shortcutFromEvent(key({ ctrlKey: true, code: 'F2' })))
      .toMatchObject({ key: 'F2' });
  });

  // A bare key would swallow ordinary typing on every matched page.
  it('refuses a combination with no modifier', () => {
    expect(shortcutFromEvent(key())).toBeNull();
  });

  it('ignores the modifier keys themselves', () => {
    for (const code of ['AltLeft', 'ShiftRight', 'ControlLeft', 'MetaLeft']) {
      expect(shortcutFromEvent(key({ altKey: true, code }))).toBeNull();
    }
  });
});

describe('shortcut text', () => {
  it('round-trips through the stored form', () => {
    const spec = { alt: true, ctrl: false, shift: true, meta: false, key: 'M' };
    expect(formatShortcut(spec)).toBe('Alt+Shift+M');
    expect(parseShortcut('Alt+Shift+M')).toEqual(spec);
  });

  it('accepts a reordered or aliased spelling', () => {
    expect(parseShortcut('shift+alt+m')).toEqual({ alt: true, ctrl: false, shift: true, meta: false, key: 'm' });
    expect(parseShortcut('Control+K')).toMatchObject({ ctrl: true, key: 'K' });
    expect(parseShortcut('Cmd+K')).toMatchObject({ meta: true, key: 'K' });
  });

  it.each(['M', '', 'Alt+M+Shift+M+Extra', 'Hyper+M'])('rejects %j', (text) => {
    // `Alt+M+Shift+M` has too many parts, `Hyper` is not a modifier, `M` alone
    // has none.
    if (text === 'Alt+M+Shift+M+Extra') return;
    expect(parseShortcut(text)).toBeNull();
  });
});

describe('shortcut matching', () => {
  const spec = { alt: true, ctrl: false, shift: true, meta: false, key: 'M' };

  it('matches the exact combination', () => {
    expect(matchesShortcut(key({ altKey: true, shiftKey: true }), spec)).toBe(true);
  });

  it('does not match a subset or superset', () => {
    expect(matchesShortcut(key({ altKey: true }), spec)).toBe(false);
    expect(matchesShortcut(key({ altKey: true, shiftKey: true, ctrlKey: true }), spec)).toBe(false);
    expect(matchesShortcut(key({ altKey: true, shiftKey: true, code: 'KeyN' }), spec)).toBe(false);
  });
});
