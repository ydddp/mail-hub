import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// New display contract: explicit instants follow the viewer's zone; legacy
// UTC input must still denote the same instant rather than the viewer's noon.
describe('SPA local time formatting', () => {
  it.each([
    ['UTC', '12:00'], ['Asia/Tokyo', '21:00'],
    ['Asia/Shanghai', '20:00'], ['America/Los_Angeles', '05:00'],
  ])('uses browser timezone %s for all accepted time-point forms', (tz, expected) => {
    const script = `
      const fs = require('node:fs'), vm = require('node:vm');
      const html = fs.readFileSync('src/public/index.html', 'utf8');
      const code = html.slice(html.indexOf('function timeAgo('), html.indexOf('function fmtBytes('));
      const ctx = {_lang:'zh', esc:String, t:()=>'-', Date, Intl};
      vm.createContext(ctx); vm.runInContext(code,ctx);
      console.log(JSON.stringify(['2026-10-04 12:00:00','2026-10-04T12:00:00','2026-10-04T12:00:00Z','2026-10-04 21:00:00+09:00'].map(value=>ctx.shortTime(value))));
    `;
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz } }));
    expect(actual).toEqual([expected, expected, expected, expected]);
  });

  it('keeps missing, invalid and date-only display values unknown', () => {
    const script = `
      const fs=require('node:fs'), vm=require('node:vm');
      const html=fs.readFileSync('src/public/index.html','utf8');
      const code=html.slice(html.indexOf('function timeAgo('),html.indexOf('function fmtBytes('));
      const ctx={_lang:'zh',esc:String,t:()=>'-',Date,Intl};
      vm.createContext(ctx);vm.runInContext(code,ctx);
      console.log(JSON.stringify([null,'','2026-10-04','2026-02-30T00:00:00Z','123','bad time'].map(value=>ctx.fmtTime(value))));
    `;
    expect(JSON.parse(execFileSync(process.execPath, ['-e',script], {encoding:'utf8'}))).toEqual(Array(6).fill('-'));
  });
});
