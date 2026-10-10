import { createHash, randomUUID } from 'crypto';
import { getDb, getRow, allRows } from './db.js';
import { runConcurrent } from './utils.js';
import { createLogger } from './logger.js';

export type BatchKind = 'outlook-check' | 'outlook-renew' | 'yyds-check';
type Outcome = { status?: string; valid?: boolean | null; renewed?: boolean };
type JobRow = {
  id: string; pool: string; kind: BatchKind; scope_hash: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  total: number; completed: number; summary_json: string; error: string;
  created_at: string; updated_at: string;
};
const log = createLogger('batch-jobs');

function publicJob(row: JobRow) {
  return {
    id: row.id, pool: row.pool, kind: row.kind, status: row.status,
    total: row.total, completed: row.completed, summary: JSON.parse(row.summary_json) as Record<string, number>,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getBatchJob(id: string) {
  const row = getRow<JobRow>(getDb(), 'SELECT * FROM batch_jobs WHERE id = ?', id);
  return row ? publicJob(row) : undefined;
}

export function latestBatchJobs(pool: string) {
  return allRows<JobRow>(getDb(), 'SELECT * FROM batch_jobs WHERE pool = ? ORDER BY rowid DESC LIMIT 1', pool).map(publicJob);
}

export function runningBatchJob(pool: string) {
  const row = getRow<JobRow>(getDb(), `SELECT * FROM batch_jobs WHERE pool = ? AND status = 'running'`, pool);
  return row ? publicJob(row) : undefined;
}

export class BatchConflictError extends Error {
  readonly status = 409;
  constructor() { super('This pool already has a running batch task; view its progress before starting another'); }
}

// Callbacks execute the original account operation. Only aggregate counts and
// a one-way selection fingerprint are persisted: no tokens, passwords or keys.
function launchBatchJob<T, R extends Outcome>(
  kind: BatchKind, scope: string[], items: T[], concurrency: number, fn: (item: T) => Promise<R>, reuse: boolean,
) {
  const db = getDb();
  const pool = kind.split('-')[0];
  const hash = createHash('sha256').update(JSON.stringify([kind, [...new Set(scope)].sort()])).digest('hex');
  const running = getRow<JobRow>(db, `SELECT * FROM batch_jobs WHERE pool = ? AND status = 'running'`, pool);
  if (running) {
    if (!reuse || running.scope_hash !== hash) throw new BatchConflictError();
    return { job: publicJob(running), completion: undefined };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const summary = { valid: 0, invalid: 0, unknown: 0, renewed: 0, failed: 0 };
  db.prepare(`INSERT INTO batch_jobs (id, pool, kind, scope_hash, total, summary_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, pool, kind, hash, items.length, JSON.stringify(summary), now, now);
  const initial = getBatchJob(id)!;
  // Yield to the HTTP response before issuing any upstream requests.
  const completion = new Promise<R[]>((resolve, reject) => setImmediate(() => {
    let completed = 0;
    let failure = false;
    let storageFailure = false;
    void runConcurrent(items, Math.min(50, Math.max(1, concurrency)), async item => {
      try {
        const result = await fn(item);
        const status = result.status || (result.valid === null ? 'unknown' : result.valid ? 'valid' : 'invalid');
        if (status === 'unknown') summary.unknown++;
        else if (status === 'invalid' || status === 'no_token') summary.invalid++;
        else if (status === 'valid' || status === 'renewed' || status === 'not_rotated') summary.valid++;
        if (kind === 'outlook-renew') {
          if (result.renewed) summary.renewed++;
          else summary.failed++;
        }
        return result;
      } catch {
        // Do not expose or persist arbitrary upstream error text containing secrets.
        failure = true;
        summary.unknown++;
        if (kind === 'outlook-renew') summary.failed++;
      } finally {
        completed++;
        try {
          db.prepare('UPDATE batch_jobs SET completed = ?, summary_json = ?, updated_at = ? WHERE id = ?')
            .run(completed, JSON.stringify(summary), new Date().toISOString(), id);
        } catch {
          // Keep the pool owned until all workers settle, even if a progress
          // write fails. Rejecting Promise.all here would unlock it too early.
          if (!storageFailure) log.error('batch task progress storage failed', { id, kind });
          storageFailure = true;
          failure = true;
        }
      }
    }).then(results => {
      const error = storageFailure ? 'Task progress storage failed; account operations may have completed'
        : failure ? 'Some accounts could not be processed; completed results were kept' : '';
      db.prepare('UPDATE batch_jobs SET status = ?, error = ?, completed = ?, summary_json = ?, updated_at = ? WHERE id = ?')
        .run(failure ? 'failed' : 'completed', error, completed, JSON.stringify(summary), new Date().toISOString(), id);
      log.info('batch task finished', { id, kind, completed, total: items.length, ...summary });
      if (failure) reject(new Error('Some accounts could not be processed'));
      else resolve(results as R[]);
    }).catch(() => {
      // All workers settle their account failures above; this covers storage failure.
      log.error('batch task storage failed', { id, kind });
      try {
        db.prepare(`UPDATE batch_jobs SET status = 'failed', error = 'Task storage failed', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), id);
      } catch { /* Startup recovery will mark a remaining running row interrupted. */ }
      reject(new Error('Task storage failed'));
    });
  }));
  return { job: initial, completion };
}

export function startBatchJob<T, R extends Outcome>(
  kind: BatchKind, scope: string[], items: T[], concurrency: number, fn: (item: T) => Promise<R>,
) {
  const { job, completion } = launchBatchJob(kind, scope, items, concurrency, fn, true);
  // Failure details are represented by the durable job state.
  void completion?.catch(() => undefined);
  return job;
}

export async function runSynchronousBatch<T, R extends Outcome>(
  kind: BatchKind, scope: string[], items: T[], concurrency: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const { completion } = launchBatchJob(kind, scope, items, concurrency, fn, false);
  return await completion!;
}
