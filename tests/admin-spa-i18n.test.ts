import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { spaFiles } from './helpers/spa-source.js';

// Text written straight into markup or a template stays in one language: the
// Chinese UI showed "No rules" and "Cumulative: … created", the English one
// showed 地址 and 封禁时间. Everything a reader sees goes through t() or data-i18n.
const read = (path: string) => readFileSync(resolve(process.cwd(), 'src/public', path), 'utf8');
const scripts = spaFiles().filter(p => p.endsWith('.js') && !p.endsWith('core/i18n.js'));
const CJK = /[一-鿿]/;

/** Visible text in a script: text nodes of markup in string and template literals. */
function templateTexts(path: string): { line: number; text: string }[] {
  const code = read(path);
  const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: { line: number; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (/[<>]/.test(n.text)) {
        for (const m of n.text.matchAll(/>([^<>]+)</g)) {
          const text = m[1].trim();
          if (text) out.push({ line: file.getLineAndCharacterOfPosition(n.getStart()).line + 1, text });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

describe('admin SPA text', () => {
  it('writes no Chinese into script templates', () => {
    const offenders = scripts.flatMap(path => templateTexts(path).filter(t => CJK.test(t.text)).map(t => `${path}:${t.line}  ${t.text}`));
    expect(offenders).toEqual([]);
  });

  it('writes no English sentences into script templates', () => {
    // Two or more lower-case English words in a text node is a sentence, not a name or an identifier.
    const sentence = /\b[A-Za-z][a-z]+\s+[a-z]{2,}\b/;
    const offenders = scripts.flatMap(path => templateTexts(path).filter(t => sentence.test(t.text) && !t.text.includes('${')).map(t => `${path}:${t.line}  ${t.text}`));
    expect(offenders).toEqual([]);
  });

  it('picks no wording by checking the language inline', () => {
    const offenders = scripts.flatMap(path => {
      const code = read(path);
      return [...code.matchAll(/_lang\s*===?\s*['"]zh['"]\s*\?\s*(['"`])([^'"`]*)\1/g)]
        .filter(m => CJK.test(m[2]))
        .map(m => `${path}:${code.slice(0, m.index).split('\n').length}  ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  // The docs view is markup too, and a title tooltip is read like any other text.
  it('gives every Chinese text and tooltip in the markup a data-i18n key', () => {
    const offenders: string[] = [];
    for (const path of ['index.html', 'views/docs.html']) {
      const html = read(path).replace(/<!--[\s\S]*?-->/g, '');
      const body = html.includes('<body') ? html.slice(html.indexOf('<body')) : html;
      // Open elements; text under one carrying data-i18n or data-i18n-html is translated with it.
      const open: { tag: string; keyed: boolean }[] = [];
      for (const m of body.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
        if (m[4] !== undefined) {
          if (CJK.test(m[4]) && !open.some(e => e.keyed)) offenders.push(`${path}  ${m[4].trim().slice(0, 40)}`);
          continue;
        }
        const [, close, tag, attrs] = m;
        if (close) {
          const at = open.map(e => e.tag).lastIndexOf(tag);
          if (at >= 0) open.length = at;
          continue;
        }
        const title = attrs.match(/\btitle="([^"]*)"/);
        if (title && CJK.test(title[1]) && !/data-i18n-title/.test(attrs)) offenders.push(`${path}  title="${title[1].slice(0, 40)}"`);
        if (!/^(br|hr|img|input|meta|link|wbr)$/.test(tag) && !attrs.endsWith('/')) open.push({ tag, keyed: /data-i18n(-html)?=/.test(attrs) });
      }
    }
    expect(offenders).toEqual([]);
  });

  // A ${…} in static markup is never evaluated: the docs showed "等待并${t('inbox.extract')}code".
  it('writes no template expressions into static markup', () => {
    const offenders = ['index.html', 'views/docs.html'].flatMap(path =>
      [...read(path).matchAll(/\$\{\s*t\(/g)].map(m => `${path}:${read(path).slice(0, m.index).split('\n').length}`));
    expect(offenders).toEqual([]);
  });

  // An empty list is the shared empty state, which also hides the header.
  it('shows empty lists with the shared empty state, not a hand-made row', () => {
    const offenders = spaFiles().filter(p => p.endsWith('.js') || p.endsWith('.html'))
      .filter(path => /empty-row/.test(read(path)));
    expect(offenders).toEqual([]);
  });
});

// Testing a provider can create a paid upstream asset. The editor must keep
// its saved config even when authentication or the response fails, and tell
// the operator which config and recovery record they can return to.
describe('template test asset retention notices', () => {
  it.each(['zh', 'en'].flatMap(lang => [
    ...['success', 'auth_pending', 'domains failed', 'request lost', 'save response lost'].map(outcome => ({ lang, outcome, origin: 'editor' })),
    ...['success', 'auth_pending', 'request lost'].map(outcome => ({ lang, outcome, origin: 'disabled list' })),
  ]))('keeps the config and shows a localized notice after $outcome ($lang, $origin)', async ({ lang, outcome, origin }) => {
      const calls: { path: string; method: string; body?: string }[] = [];
      const dialogs: { title: string; body: string }[] = [];
      const fields = new Map<string, { value: string; checked?: boolean; textContent?: string }>();
      const field = (id: string) => {
        if (!fields.has(id)) fields.set(id, { value: '' });
        return fields.get(id)!;
      };
      field('tpl-json').value = '{}';
      field('tpl-name').value = 'draft-config';
      field('tpl-apibase').value = 'https://local.example.test';
      const recovery = { id: '<recovery-id>', phase: outcome === 'auth_pending' ? 'auth_pending' : 'ready', canRetry: outcome === 'auth_pending', canClaim: outcome === 'success', authData: { token: 'private-token' } };
      const context = {
        localStorage: { getItem: (key: string) => key === 'mailhub_lang' ? lang : null },
        navigator: { language: lang },
        document: { getElementById: field },
        Date: { now: () => 123456789 },
        _pageState: {},
        renderLoading: () => {}, setCount: () => {}, paginateTable: () => {},
        on: () => '',
        esc: (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        toast: () => {},
        showDialog: (title: string, body: string) => dialogs.push({ title, body }),
        api: async (path: string, options: { method?: string; body?: string } = {}) => {
          calls.push({ path, method: options.method || 'GET', body: options.body });
          if (options.method === 'DELETE') return {};
          if (path.endsWith('/test')) {
            if (outcome === 'request lost') throw new Error('private transport error');
            if (outcome === 'domains failed') return { success: false, steps: [{ step: 'getDomains', ok: false, error: 'Template domain discovery failed' }] };
            return { success: outcome === 'success', steps: [
              { step: 'getDomains', ok: true, detail: '1 domains: local.example.test' },
              { step: 'createInbox', ok: outcome === 'success', ...(outcome === 'auth_pending' ? { error: 'Template inbox creation requires recovery' } : {}) },
              ...(outcome === 'success' ? [{ step: 'getMessages', ok: true, detail: '0 messages' }] : []),
            ], recovery };
          }
          if (options.method === 'POST' && outcome === 'save response lost') throw new Error('private save error');
          return { providers: [] };
        },
      };
      const stripModule = (source: string) => source.replace(/^import .*;\r?\n/gm, '').replace(/^export .*;\r?\n?/gm, '');
      const run = origin === 'editor' ? 'testTplProvider();' : `_allTemplates = [{ name: '<list-config>', enabled: false }]; testTpl('<list-config>');`;
      await runInNewContext(`${stripModule(read('js/core/i18n.js'))}\n${stripModule(read('js/views/templates.js'))}\n${run}`, context);
      expect(calls.filter(call => call.method === 'DELETE')).toEqual([]);
      if (origin === 'editor') expect(JSON.parse(calls.find(call => call.path === '/template-providers' && call.method === 'POST')!.body!).enabled).toBe(false);
      expect(dialogs).toHaveLength(1);
      const body = dialogs[0].body;
      expect(body).toContain(origin === 'editor' ? '_test_123456789' : '&lt;list-config&gt;');
      expect(body).toContain(lang === 'zh' ? outcome === 'save response lost' ? '保存结果未确认' : '配置已保留' : outcome === 'save response lost' ? 'Config save is unconfirmed' : 'Config retained');
      if (outcome !== 'save response lost') expect(body).toContain(lang === 'zh' ? '保持停用' : 'remains disabled');
      expect(body).not.toMatch(/private-|<recovery-id>|tpl\.test_/);
      if (lang === 'zh') expect(body).not.toMatch(/Template domain|requires recovery|\d+ domains:|\d+ messages/);
      if (outcome === 'success' || outcome === 'auth_pending') {
        expect(body).toContain('&lt;recovery-id&gt;');
        expect(body).toContain(lang === 'zh' ? outcome === 'success' ? '可领取' : '等待认证' : outcome === 'success' ? 'Ready to claim' : 'Authentication pending');
      } else if (outcome === 'domains failed') {
        expect(body).not.toContain(lang === 'zh' ? '账号资料已保存' : 'account data are saved');
      } else {
        expect(body).toContain(lang === 'zh' ? '请求中断' : 'request was interrupted');
      }
    });
});
