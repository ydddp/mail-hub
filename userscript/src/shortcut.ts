/**
 * Shortcut handling kept pure so the "does this key combo count" rules can be
 * tested without a browser. The panel never treats a keypress during an input
 * method composition as a shortcut; that guard lives next to the listener.
 */

export interface ShortcutSpec {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  /** Virtual key name, e.g. `M`, `1`, `F2`. */
  key: string;
}

const MODIFIER_CODES = /^(Alt|Control|Shift|Meta|OS|Super)/;

/** `KeyM` → `M`, `Digit1` → `1`, anything else keeps its code (`F2`, `ArrowUp`). */
function keyFromCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

/**
 * A usable shortcut must carry at least one modifier: a bare letter would
 * hijack ordinary typing on every page the assistant runs on.
 */
export function shortcutFromEvent(event: {
  altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean;
  code: string;
}): ShortcutSpec | null {
  if (!event.code || MODIFIER_CODES.test(event.code)) return null;
  if (!event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) return null;
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key: keyFromCode(event.code),
  };
}

export function formatShortcut(spec: ShortcutSpec): string {
  const parts: string[] = [];
  if (spec.ctrl) parts.push('Ctrl');
  if (spec.alt) parts.push('Alt');
  if (spec.shift) parts.push('Shift');
  if (spec.meta) parts.push('Meta');
  parts.push(spec.key);
  return parts.join('+');
}

export function parseShortcut(text: string): ShortcutSpec | null {
  const parts = String(text ?? '').split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.pop() as string;
  const spec: ShortcutSpec = { alt: false, ctrl: false, shift: false, meta: false, key };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'alt': spec.alt = true; break;
      case 'ctrl': case 'control': spec.ctrl = true; break;
      case 'shift': spec.shift = true; break;
      case 'meta': case 'cmd': case 'command': spec.meta = true; break;
      default: return null;
    }
  }
  if (!spec.alt && !spec.ctrl && !spec.shift && !spec.meta) return null;
  return spec;
}

export function matchesShortcut(event: {
  altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; code: string;
}, spec: ShortcutSpec): boolean {
  const pressed = shortcutFromEvent(event);
  if (!pressed) return false;
  return pressed.alt === spec.alt
    && pressed.ctrl === spec.ctrl
    && pressed.shift === spec.shift
    && pressed.meta === spec.meta
    && pressed.key === spec.key;
}
