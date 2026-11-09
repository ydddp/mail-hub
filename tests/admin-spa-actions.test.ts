import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { describe, expect, it } from 'vitest';
import { spaFiles } from './helpers/spa-source.js';

// Handlers are delegated (js/core/actions.js): markup names one with data-on-*,
// boot.js registers it. An inline on* attribute cannot reach a module's
// functions, and a name nobody registered makes a control that does nothing.
const read = (path: string) => readFileSync(resolve(process.cwd(), 'src/public', path), 'utf8');
const sources = spaFiles().filter(path => path.endsWith('.html') || path.endsWith('.js'));

function usedNames(): Set<string> {
  const used = new Set<string>();
  for (const path of sources) {
    const text = read(path);
    for (const m of text.matchAll(/data-on-[a-z]+="([\w$]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/\bon\(\s*'[a-z]+(?::\w+)?'\s*,\s*'([\w$]+)'/g)) used.add(m[1]);
  }
  return used;
}

function registeredNames(): Set<string> {
  const boot = read('js/boot.js');
  const call = /\nactions\(\{([\s\S]*?)\}\);/.exec(boot);
  expect(call, 'actions({…}) in boot.js').not.toBeNull();
  return new Set(call![1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean));
}

describe('admin SPA actions', () => {
  // The code result distinguishes throttling from upstream failure using the
  // real API client's error status; preserving only a message hides that state.
  it.each([429, 502])('retains HTTP %s for actionable UI retry states', async status => {
    const source = read('js/core/api.js').replace(/^import .*;\r?\n/gm, '').replace(/^export .*;\r?$/gm, '');
    const context = {
      API: '/api', getToken: () => 'admin-secret',
      fetch: async () => ({ status, ok: false, headers: new Headers({ 'Retry-After': '23' }), json: async () => ({ error: 'Mailbox unavailable' }) }),
    };
    const api = runInNewContext(source + '\napi;', context) as (path: string) => Promise<unknown>;
    await expect(api('/inbox/matching/code?selection=matching')).rejects.toMatchObject({ status, message: 'Mailbox unavailable' });
  });

  it('writes no inline event handler attributes', () => {
    const offenders: string[] = [];
    for (const path of sources) {
      const text = read(path);
      for (const m of text.matchAll(/\son[a-z]+=\\?["']/g)) offenders.push(`${path}:${text.slice(0, m.index).split('\n').length}  ${m[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('registers every handler the markup names', () => {
    const registered = registeredNames();
    expect([...usedNames()].filter(name => !registered.has(name))).toEqual([]);
  });

  it('registers no handler the markup no longer names', () => {
    const used = usedNames();
    expect([...registeredNames()].filter(name => !used.has(name))).toEqual([]);
  });
});
