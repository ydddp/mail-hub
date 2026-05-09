import type { MiddlewareHandler } from 'hono';

export type AdminEnv = { Variables: { isAdmin: boolean; apiKey: string } };

export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  return next();
};
