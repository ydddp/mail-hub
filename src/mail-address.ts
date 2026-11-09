/**
 * Fold ASCII case for address identity and recipient evidence, as SQLite lower()
 * does. Preserve every non-ASCII code point: Unicode case or compatibility
 * normalization can merge distinct mailbox claims. Trimming belongs to callers.
 */
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}
