import { Hono } from 'hono';
import { requireAdmin, type AdminEnv } from './admin.js';
import { getBatchJob, latestBatchJobs } from '../batch-jobs.js';

export const batchJobRoutes = new Hono<AdminEnv>();
batchJobRoutes.use('/batch-jobs', requireAdmin);
batchJobRoutes.use('/batch-jobs/*', requireAdmin);
batchJobRoutes.get('/batch-jobs', c => {
  c.header('Cache-Control', 'no-store');
  const pool = c.req.query('pool');
  if (pool !== 'outlook' && pool !== 'yyds') return c.json({ error: 'pool must be outlook or yyds' }, 400);
  return c.json({ jobs: latestBatchJobs(pool) });
});
batchJobRoutes.get('/batch-jobs/:id', c => {
  c.header('Cache-Control', 'no-store');
  const job = getBatchJob(c.req.param('id'));
  return job ? c.json({ job }) : c.json({ error: 'Batch task not found' }, 404);
});
