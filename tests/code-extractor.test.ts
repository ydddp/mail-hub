import { describe, expect, it } from 'vitest';
import { extractCodes } from '../src/code-extractor.js';

describe('code-extractor', () => {
  describe('numeric codes', () => {
    it('extracts 6-digit code near keyword', () => {
      const results = extractCodes({ subject: '验证码: 482910', text: '' });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ type: 'numeric', value: '482910', confidence: 1 });
    });

    it('extracts 4-digit code', () => {
      const results = extractCodes({ subject: 'Your code is 7391', text: '' });
      expect(results[0]).toMatchObject({ type: 'numeric', value: '7391' });
    });

    it('extracts 8-digit code', () => {
      const results = extractCodes({ subject: 'OTP: 12345678', text: '' });
      expect(results[0]).toMatchObject({ value: '12345678' });
    });

    it('filters out years', () => {
      const results = extractCodes({ subject: 'Copyright 2024', text: '' });
      expect(results).toHaveLength(0);
    });

    it('filters out phone-context numbers', () => {
      const results = extractCodes({ subject: '', text: 'Phone: 123456' });
      expect(results).toHaveLength(0);
    });

    it('filters out money-context numbers', () => {
      const results = extractCodes({ subject: '', text: 'Total amount: $123456' });
      expect(results).toHaveLength(0);
    });

    it('filters out zip codes', () => {
      const results = extractCodes({ subject: '', text: 'zip code 94025' });
      expect(results).toHaveLength(0);
    });

    it('assigns low confidence without keyword context', () => {
      const results = extractCodes({ subject: 'Hello 482910 world', text: '' });
      expect(results[0].confidence).toBeLessThan(0.5);
    });

    it('boosts confidence for colon pattern', () => {
      const results = extractCodes({ subject: 'verification code: 482910', text: '' });
      expect(results[0].confidence).toBe(1);
    });
  });

  describe('alphanumeric codes', () => {
    it('extracts mixed code near keyword', () => {
      const results = extractCodes({ subject: 'Your verification code is Ab3X9z', text: '' });
      const alpha = results.find(r => r.type === 'alphanumeric');
      expect(alpha).toBeDefined();
      expect(alpha!.value).toBe('Ab3X9z');
    });

    it('ignores pure letters or pure digits', () => {
      const results = extractCodes({ subject: 'verification code is ABCDEF', text: '' });
      const alpha = results.find(r => r.type === 'alphanumeric');
      expect(alpha).toBeUndefined();
    });

    it('ignores alphanumeric without keyword context', () => {
      const results = extractCodes({ subject: 'Hello Ab3X9z world', text: '' });
      const alpha = results.find(r => r.type === 'alphanumeric');
      expect(alpha).toBeUndefined();
    });
  });

  describe('link extraction', () => {
    it('extracts verification links from HTML', () => {
      const html = '<a href="https://example.com/verify?token=abc123">Verify</a>';
      const results = extractCodes({ subject: '', html });
      const link = results.find(r => r.type === 'link');
      expect(link).toBeDefined();
      expect(link!.value).toContain('verify');
      expect(link!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('extracts confirm links', () => {
      const html = '<a href="https://example.com/confirm/abc">Confirm</a>';
      const results = extractCodes({ subject: '', html });
      expect(results.find(r => r.type === 'link')).toBeDefined();
    });

    it('skips unsubscribe links', () => {
      const html = '<a href="https://example.com/unsubscribe?id=123">Unsubscribe</a>';
      const results = extractCodes({ subject: '', html });
      expect(results.find(r => r.type === 'link')).toBeUndefined();
    });

    it('skips non-http links', () => {
      const html = '<a href="mailto:test@example.com">Email</a>';
      const results = extractCodes({ subject: '', html });
      expect(results.find(r => r.type === 'link')).toBeUndefined();
    });

    it('boosts confidence for token= parameter', () => {
      const html = '<a href="https://example.com/verify?token=abc">Click</a>';
      const results = extractCodes({ subject: '', html });
      const link = results.find(r => r.type === 'link');
      expect(link!.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('HTML handling', () => {
    it('strips HTML tags and extracts from content', () => {
      const html = '<div>Your verification code is <b>394821</b></div>';
      const results = extractCodes({ subject: '', html });
      expect(results[0]).toMatchObject({ type: 'numeric', value: '394821' });
    });

    it('strips script and style tags', () => {
      const html = '<style>.code{color:red}</style><script>var x=123456</script><p>verification code: 789012</p>';
      const results = extractCodes({ subject: '', html });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe('789012');
    });
  });

  describe('sorting and deduplication', () => {
    it('sorts by confidence descending', () => {
      const results = extractCodes({
        subject: 'verification code: 123456',
        text: 'random number 987654',
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence);
    });

    it('deduplicates same value', () => {
      const results = extractCodes({
        subject: 'code: 123456',
        text: 'Your verification code is 123456',
      });
      const values = results.filter(r => r.value === '123456');
      expect(values).toHaveLength(1);
    });
  });

  describe('combined extraction', () => {
    it('extracts both numeric code and verification link', () => {
      const results = extractCodes({
        subject: 'Your OTP is 482910',
        html: '<p>Code: 482910</p><a href="https://example.com/verify?token=abc">Verify</a>',
      });
      const types = new Set(results.map(r => r.type));
      expect(types.has('numeric')).toBe(true);
      expect(types.has('link')).toBe(true);
    });

    it('returns empty for no codes', () => {
      const results = extractCodes({ subject: 'Welcome to our service', text: 'Thank you for signing up.' });
      expect(results).toHaveLength(0);
    });
  });
});
