import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { app, authHeaders, jsonOf } from './helpers/http.js';
import { extractCodes } from '../src/code-extractor.js';

interface VersionResponse {
  version: string;
}

const packageVersion = (JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string }).version;

describe('application version reporting', () => {
  it('/v1/llms.txt reports the current version and request base URL without authentication', async () => {
    const res = await app.request('/v1/llms.txt', {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mail.example.test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain(`> Version: ${packageVersion} | Base URL: https://mail.example.test`);
  });

  // AI-generated clients copy this response shape; stale keys make them miss a real code.
  it('documents the code fields returned by the extractor', async () => {
    const text = await (await app.request('/v1/llms.txt')).text();
    const section = text.split('### GET /api/inbox/:id/code\n')[1].split('\n### ')[0];
    const sample = JSON.parse(section.split('Response 200:\n')[1].split('\n\n')[0]);
    const actual = extractCodes({ subject: 'Your verification code is 123456', text: '' })[0];
    expect(actual.value).toBe('123456');
    expect(Object.keys(sample.codes[0]).sort()).toEqual(Object.keys(actual).sort());
    expect(sample.codes[0].value).toBe(actual.value);
  });

  it('/health reports package.json version', async () => {
    const res = await app.request('/health');
    const data = await jsonOf<VersionResponse>(res);

    expect(res.status).toBe(200);
    expect(data.version).toBe(packageVersion);
  });

  it('/api/admin/system-info reports package.json version', async () => {
    const res = await app.request('/api/admin/system-info', { headers: authHeaders() });
    const data = await jsonOf<VersionResponse>(res);

    expect(res.status).toBe(200);
    expect(data.version).toBe(packageVersion);
  });
});
