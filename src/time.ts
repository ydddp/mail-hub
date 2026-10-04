/** Parse time points independently of the host timezone. Legacy zone-less
 * SQLite/ISO datetimes mean UTC. Date-only values and unknown formats are not
 * time points; never invent a time or infer a numeric timestamp's unit. */
export function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction = '', zone = 'Z'] = match;
    const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month)
      || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
    return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${zone.toUpperCase()}`);
  }
  // RFC email dates must contain a full date/time and a terminal explicit
  // zone. A comment such as (UTC) is not a zone and Date.parse ignores it.
  const rfc = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})\s+(GMT|UTC|[+-]\d{4})$/i.exec(text);
  if (rfc) {
    const [, day, month, year, time, zone] = rfc;
    const monthNumber = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month.toLowerCase()) + 1;
    return parseTimestamp(`${year}-${String(monthNumber).padStart(2, '0')}-${day.padStart(2, '0')}T${time}${/^[+-]/.test(zone) ? zone : 'Z'}`);
  }
  return NaN;
}

export function toUtcIso(value: unknown): string | null {
  const timestamp = parseTimestamp(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export type TimestampFormat = 'iso' | 'utc' | 'unix_seconds' | 'unix_milliseconds';

/** Upstream zone-less dates and numbers require an explicit source contract. */
export function providerTime(value: unknown, format: TimestampFormat = 'iso'): string {
  if (format === 'unix_seconds' || format === 'unix_milliseconds') {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return '';
    const ms = Number(value) * (format === 'unix_seconds' ? 1000 : 1);
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : '';
  }
  if (format !== 'iso' && format !== 'utc') return '';
  if (format === 'iso' && (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i.test(value))) return '';
  return toUtcIso(value) ?? '';
}

/** Serialize only selected fields: provider configs, auth data and email bodies
 * are opaque and must not be recursively rewritten based on their key names. */
export function utcFields<T>(row: T, ...fields: string[]): T {
  const result = { ...row } as Record<string, unknown>;
  for (const field of fields) {
    if (Object.hasOwn(result, field)) result[field] = toUtcIso(result[field]);
  }
  return result as T;
}

export function utcMessage<T extends { receivedAt: string }>(message: T): T {
  return { ...message, receivedAt: toUtcIso(message.receivedAt) ?? '' };
}
