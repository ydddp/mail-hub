import { describe, expect, it } from 'vitest';
import { parseTimestamp, toUtcIso } from '../src/time.js';

// New contract: all accepted time-point forms denote the same instant on every host.
describe('UTC timestamp contract', () => {
  it.each([
    ['2026-10-04 12:00:00', '2026-10-04T12:00:00.000Z'],
    ['2026-10-04T12:00:00', '2026-10-04T12:00:00.000Z'],
    ['2026-10-04 12:00:00.123', '2026-10-04T12:00:00.123Z'],
    ['2026-10-04T12:00:00Z', '2026-10-04T12:00:00.000Z'],
    ['2026-10-04 21:00:00+09:00', '2026-10-04T12:00:00.000Z'],
    ['2026-10-04T05:00:00-07:00', '2026-10-04T12:00:00.000Z'],
    ['Sun, 04 Oct 2026 12:00:00 GMT', '2026-10-04T12:00:00.000Z'],
    ['04 Oct 2026 21:00:00 +0900', '2026-10-04T12:00:00.000Z'],
  ])('normalizes %s to UTC', (value, expected) => {
    expect(toUtcIso(value)).toBe(expected);
    expect(parseTimestamp(value)).toBe(Date.parse(expected));
  });

  it.each([undefined, null, '', 'not a date', '1728043200', '2026-10-04', '2026-02-30T00:00:00Z',
    '2026-10-04 GMT', '30 Feb 2026 12:00:00 GMT', '04 Oct 2026 12:00:00 (UTC)'])
    ('keeps an unknown/invalid instant unknown: %s', (value) => {
      expect(toUtcIso(value)).toBeNull();
      expect(Number.isNaN(parseTimestamp(value))).toBe(true);
    });
});
