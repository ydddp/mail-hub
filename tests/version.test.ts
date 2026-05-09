import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { app, authHeaders, jsonOf } from './helpers/http.js';

interface VersionResponse {
  version: string;
}

const packageVersion = (JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string }).version;

describe('application version reporting', () => {
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
