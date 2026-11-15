import { afterEach, describe, expect, it } from 'vitest';
import { DICTIONARIES, resolveLang, setLang, t } from '../userscript/src/i18n.js';
import type { MessageKey } from '../userscript/src/i18n.js';

/**
 * The assistant is shown in Chinese or English. A key missing in one language,
 * or a placeholder that one translation forgets, is text the user sees broken.
 */

afterEach(() => setLang('zh'));

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('dictionaries', () => {
  const keys = Object.keys(DICTIONARIES.zh) as MessageKey[];

  it('have the same keys in both languages', () => {
    expect(Object.keys(DICTIONARIES.en).sort()).toEqual([...keys].sort());
  });

  it.each(keys)('%s keeps the same placeholders and is not empty', (key) => {
    expect(DICTIONARIES.en[key].trim()).not.toBe('');
    expect(placeholders(DICTIONARIES.en[key])).toEqual(placeholders(DICTIONARIES.zh[key]));
  });
});

describe('resolveLang', () => {
  it.each<[string, Parameters<typeof resolveLang>[0], string[], 'zh' | 'en']>([
    ['Chinese browser', 'auto', ['zh-CN', 'en'], 'zh'],
    ['Traditional Chinese browser', 'auto', ['zh-TW'], 'zh'],
    ['English browser', 'auto', ['en-US', 'zh-CN'], 'en'],
    ['any other language falls back to English', 'auto', ['ja-JP'], 'en'],
    ['no language reported', 'auto', [], 'en'],
    ['a choice in settings wins over the browser', 'en', ['zh-CN'], 'en'],
    ['and the other way round', 'zh', ['en-US'], 'zh'],
  ])('%s', (_name, preference, languages, expected) => {
    expect(resolveLang(preference, languages)).toBe(expected);
  });
});

describe('t', () => {
  it('fills placeholders in the current language', () => {
    expect(t('cap.candidates', { n: 3 })).toBe('3 个候选码');
    setLang('en');
    expect(t('cap.candidates', { n: 3 })).toBe('3 candidates');
  });
});
