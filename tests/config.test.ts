import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../src/config.js';

describe('configuration validation', () => {
  it('accepts default configuration', () => {
    const cfg = loadConfig({});
    const result = validateConfig(cfg);

    expect(result.errors).toEqual([]);
  });

  it('rejects invalid port and proxy values', () => {
    const cfg = loadConfig({
      PORT: '99999',
      PROXY_URL: 'not-a-url',
    });
    const result = validateConfig(cfg);

    expect(result.errors).toContain('PORT must be an integer between 1 and 65535');
    expect(result.errors).toContain('PROXY_URL must be a valid URL');
  });

  it('warns when API_SECRET is empty', () => {
    const cfg = loadConfig({ API_SECRET: '' });
    const result = validateConfig(cfg);

    expect(result.warnings).toContain('API_SECRET is empty; all API routes will run with admin access');
  });

  it('validates request log volume controls', () => {
    const cfg = loadConfig({
      REQUEST_LOG_SAMPLE_RATE: '2',
      REQUEST_LOG_SLOW_MS: '-1',
    });
    const result = validateConfig(cfg);

    expect(result.errors).toContain('REQUEST_LOG_SAMPLE_RATE must be a number between 0 and 1');
    expect(result.errors).toContain('REQUEST_LOG_SLOW_MS must be a non-negative number');
  });
});
