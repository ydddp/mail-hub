import { createApp } from '../../src/app.js';

export const app = createApp();

export function authHeaders(token = 'admin-secret'): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function jsonHeaders(token = 'admin-secret'): Record<string, string> {
  return {
    ...authHeaders(token),
    'Content-Type': 'application/json',
  };
}

export async function jsonOf<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
