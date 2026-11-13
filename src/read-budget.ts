import { AsyncLocalStorage } from 'node:async_hooks';

export interface ReadBudget { signal?: AbortSignal; deadline?: number; requestId?: string }
const budgets = new AsyncLocalStorage<ReadBudget>();
export const currentReadBudget = () => budgets.getStore();

export function budgetSignal(options: ReadBudget = {}) {
  const parent = currentReadBudget();
  const deadline = Math.min(options.deadline ?? Infinity, parent?.deadline ?? Infinity);
  const controller = new AbortController();
  const signals = [options.signal, parent?.signal].filter((signal): signal is AbortSignal => !!signal);
  const abort = () => controller.abort(signals.find(signal => signal.aborted)?.reason);
  for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
  if (signals.some(signal => signal.aborted)) abort();
  const expire = () => controller.abort(new DOMException('Read deadline exceeded', 'TimeoutError'));
  const timer = Number.isFinite(deadline) ? setTimeout(expire, Math.max(0, deadline - Date.now())) : undefined;
  timer?.unref();
  if (Date.now() >= deadline) expire();
  return {
    signal: controller.signal, deadline, requestId: options.requestId ?? parent?.requestId,
    cancel() { controller.abort(new DOMException('Read scope ended', 'AbortError')); },
    dispose() { if (timer) clearTimeout(timer); for (const signal of signals) signal.removeEventListener('abort', abort); },
  };
}

/** Scope stays attached to asynchronous descendants; no provider API/signature changes. */
export async function withReadBudget<T>(options: ReadBudget, operation: () => Promise<T>): Promise<T> {
  const budget = budgetSignal(options);
  try { return await budgets.run(budget, operation); }
  finally { budget.cancel(); budget.dispose(); }
}

export async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation(), cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function runReadOperation<T>(options: ReadBudget, operation: () => Promise<T>): Promise<T> {
  const parent = currentReadBudget();
  if (parent?.signal && options.deadline === undefined && options.signal === undefined) {
    return abortable(parent.signal, operation);
  }
  return withReadBudget(options, () => abortable(currentReadBudget()!.signal!, operation));
}

export async function readDelay(ms: number, signal?: AbortSignal): Promise<void> {
  const stop = signal ?? currentReadBudget()?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
  try { if (stop) await abortable(stop, wait); else await wait(); }
  finally { if (timer) clearTimeout(timer); }
}
