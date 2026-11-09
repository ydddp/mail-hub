import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { spaSource } from './helpers/spa-source.js';

// The formatting helpers run in a child process so TZ can differ per case;
// the parent cuts them out of the SPA source and passes them as argv[1].
const source = spaSource();
const formatCode = source.slice(source.indexOf('function timeAgo('), source.indexOf('function fmtBytes('));

function runFormat(body: string, env: NodeJS.ProcessEnv = process.env): unknown {
  const script = `
    const vm = require('node:vm');
    const ctx = {_lang:'zh', esc:String, t:(key)=>key === 'time.unknown' ? '时间未知' : '-', Date, Intl};
    vm.createContext(ctx); vm.runInContext(process.argv[1], ctx);
    console.log(JSON.stringify(${body}));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script, formatCode], { encoding: 'utf8', env }));
}

// New display contract: explicit instants follow the viewer's zone; legacy
// UTC input must still denote the same instant rather than the viewer's noon.
describe('SPA local time formatting', () => {
  it.each([
    ['UTC', '12:00'], ['Asia/Tokyo', '21:00'],
    ['Asia/Shanghai', '20:00'], ['America/Los_Angeles', '05:00'],
  ])('uses browser timezone %s for all accepted time-point forms', (tz, expected) => {
    const actual = runFormat(
      `['2026-10-04 12:00:00','2026-10-04T12:00:00','2026-10-04T12:00:00Z','2026-10-04 21:00:00+09:00'].map(value=>ctx.shortTime(value))`,
      { ...process.env, TZ: tz },
    );
    expect(actual).toEqual([expected, expected, expected, expected]);
  });

  it('keeps missing, invalid and date-only display values unknown', () => {
    const actual = runFormat(`[null,'','2026-10-04','2026-02-30T00:00:00Z','123','bad time'].map(value=>ctx.fmtTime(value))`);
    expect(actual).toEqual(Array(6).fill('-'));
  });

  // Mail must distinguish arrivals within one minute and let a viewer inspect
  // the exact instant without guessing the server's timezone.
  it.each([
    ['UTC', '12:00:05'], ['Asia/Tokyo', '21:00:05'],
    ['America/Los_Angeles', '05:00:05'],
  ])('shows mail seconds and preserves the precise instant in %s', (tz, expected) => {
    const actual = runFormat(`ctx.mailTime('2026-10-04T12:00:05.123Z')`, { ...process.env, TZ: tz }) as { label: string; iso: string; zone: string };
    expect(actual.label).toContain(expected);
    expect(actual.iso).toBe('2026-10-04T12:00:05.123Z');
    expect(actual.zone).toBe(tz);
  });

  it.each([null, '', 'bad time', '2026-02-30T00:00:00Z', '2026-10-04'])('does not invent a mail arrival for %s', (value) => {
    expect(runFormat(`ctx.mailTime(${JSON.stringify(value)})`)).toEqual({ label: '时间未知', iso: '', zone: '' });
  });

  // Equal instants have no observable chronology; a code-unit ID tie-break
  // merely fixes their display order across language settings and refreshes.
  it('orders mail by instant descending, then locale-independent ID, with unknown times last', () => {
    const actual = runFormat(`[
      {id:'a',receivedAt:'2026-10-04T12:00:05.123Z'},
      {id:'unknown-z',receivedAt:''},
      {id:'later',receivedAt:'2026-10-04T12:00:05.124Z'},
      {id:'Z',receivedAt:'2026-10-04T21:00:05.123+09:00'},
      {id:'unknown-A',receivedAt:'invalid'},
      {id:'A',receivedAt:'2026-10-04T12:00:05.123Z'}
    ].sort(ctx.compareMailReceived).map(message=>message.id)`);
    expect(actual).toEqual(['later', 'A', 'Z', 'a', 'unknown-A', 'unknown-z']);
  });

  // Exact-time help must fit the viewport even when its table is scrolled;
  // the popup itself is rendered in the top layer, outside table clipping.
  it.each([
    [{ left: 15, right: 100, top: 480, bottom: 500 }, { width: 280, height: 60 }, 390, 844, { left: 12, top: 506 }],
    [{ left: 300, right: 380, top: 480, bottom: 500 }, { width: 280, height: 60 }, 390, 844, { left: 98, top: 506 }],
    [{ left: 300, right: 380, top: 790, bottom: 810 }, { width: 280, height: 60 }, 390, 844, { left: 98, top: 724 }],
    [{ left: -100, right: 40, top: 10, bottom: 30 }, { width: 280, height: 60 }, 390, 100, { left: 12, top: 28 }],
  ])('keeps exact-time help visible for anchor %j', (anchor, popup, width, height, expected) => {
    expect(runFormat(`ctx.mailTooltipPosition(${JSON.stringify(anchor)},${JSON.stringify(popup)},${width},${height})`)).toEqual(expected);
  });
});
