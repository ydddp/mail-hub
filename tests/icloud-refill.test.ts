import { describe, it, expect, vi, afterEach } from 'vitest';
// setSetting, not `UPDATE settings`: DEFAULT_SETTINGS is a code-level fallback
// and no row exists until something writes one, so an UPDATE matches nothing
// and the target silently stays at the default 10.
import { getDb, setSetting } from '../src/db.js';
import {
  runRefillOnce, startIcloudPool, stopIcloudPool, rescheduleIcloudPool,
} from '../src/providers/icloud-pool.js';
import { setCooldown } from '../src/providers/icloud.js';

afterEach(() => {
  stopIcloudPool();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seedAccount(id = 'acc-1', status = 'active'): void {
  getDb().prepare(
    `INSERT INTO icloud_accounts (id, apple_id, cookies, hme_service_url, status)
     VALUES (?, 'me@icloud.com', 'c', 'https://svc.test', ?)`,
  ).run(id, status);
}

/** Apple answers generate then reserve, with the list call for reconciliation. */
function stubApple(opts: { fail?: string } = {}): void {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = (body: unknown) => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(body),
    });
    if (u.includes('/v2/hme/list')) return json({ success: true, result: { hmeEmails: [] } });
    if (opts.fail) return json({ success: false, error: { errorMessage: opts.fail } });
    if (u.includes('/generate')) return json({ success: true, result: { hme: `gen${++n}@icloud.com` } });
    return json({ success: true, result: { hme: { hme: `gen${n}@icloud.com`, anonymousId: `anon${n}`, label: 'mail-hub', note: '', isActive: true } } });
  }));
}

describe('pool refill', () => {
  it('mints up to the target and stops', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '3');
    stubApple();

    const result = await runRefillOnce();

    expect(result.created).toBe(3);
    const free = getDb().prepare(
      `SELECT COUNT(*) AS c FROM icloud_addresses WHERE state = 'free'`,
    ).get() as { c: number };
    expect(free.c).toBe(3);
    expect(getDb().prepare(`SELECT upstream_active, upstream_checked_at FROM icloud_addresses`).all())
      .toEqual(Array.from({ length: 3 }, () => ({ upstream_active: null, upstream_checked_at: null })));
  });

  it('excludes inactive aliases from both target reads and mints only the shortfall after adoption', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '2');
    const db = getDb();
    for (let n = 0; n < 2; n++) db.prepare(`INSERT INTO icloud_addresses
      (hme, account_id, anonymous_id, upstream_active) VALUES (?, 'acc-1', ?, 0)`).run(`dead${n}@icloud.com`, `dead${n}`);
    let generated = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      const body = String(url).includes('/list')
        ? { hmeEmails: [
          { hme: 'adopt@icloud.com', anonymousId: 'adopt', label: 'mail-hub', isActive: true },
          { hme: 'inactive-adopt@icloud.com', anonymousId: 'inactive-adopt', label: 'mail-hub', isActive: false },
        ] }
        : String(url).includes('/generate') ? { hme: `mint${++generated}@icloud.com` }
        : { hme: { hme: `mint${generated}@icloud.com`, anonymousId: `mint${generated}` } };
      return new Response(JSON.stringify({ success: true, result: body }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    expect((await runRefillOnce()).created).toBe(1);
    expect(generated).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(db.prepare(`SELECT state, upstream_active FROM icloud_addresses WHERE anonymous_id = 'inactive-adopt'`).get())
      .toEqual({ state: 'retired', upstream_active: 0 });
    expect(db.prepare(`SELECT upstream_active, upstream_checked_at FROM icloud_addresses WHERE anonymous_id = 'mint1'`).get())
      .toEqual({ upstream_active: null, upstream_checked_at: null });
  });

  it.each([
    { success: true, result: {} }, { success: true, result: { hmeEmails: null } },
    { result: { hmeEmails: [] } }, { success: true, result: { hmeEmails: [], hasMore: true } },
    { success: true, result: { hmeEmails: [{ hme: 'known@icloud.com', anonymousId: 'known', isActive: false }, null] } },
  ])('does not mint, spend cooldown, or alter markers after an unusable list: %j', async envelope => {
    seedAccount(); setSetting('icloud_pool_target', '2');
    const db = getDb();
    db.prepare(`INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('known@icloud.com', 'acc-1', 'known')`).run();
    const before = db.prepare(`SELECT * FROM icloud_addresses`).all();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(envelope)));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runRefillOnce();
    expect(result.created).toBe(0); expect(result.errors).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT * FROM icloud_addresses`).all()).toEqual(before);
    expect(db.prepare(`SELECT pool_cooldown_until FROM icloud_accounts`).get()).toEqual({ pool_cooldown_until: null });
  });

  it('does nothing when the pool is already at target', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '1');
    getDb().prepare(
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES ('have@icloud.com', 'acc-1', 'anon-have')`,
    ).run();
    // A full pool needs neither minting nor reconciliation, so Apple must not
    // hear from us at all — a tick against a full pool used to burn one LIST
    // per account, forever.
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    expect((await runRefillOnce()).created).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('retries a failed reconcile next tick instead of spending the mint backoff', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '5');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/v2/hme/list')) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'oops' };
      }
      throw new Error('nothing past the list call should run');
    }));
    const output: string[] = [];
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    let result: Awaited<ReturnType<typeof runRefillOnce>>;
    try {
      result = await runRefillOnce();
    } finally {
      logSpy.mockRestore();
    }

    expect(result.created).toBe(0);
    expect(result.errors.length).toBe(1);
    // A failed LIST says nothing about the mint quota. The 45-minute backoff
    // is for Apple refusing to mint; conflating the two silently starved the
    // pool for most of an hour over one flaky list call.
    const row = getDb().prepare(
      `SELECT pool_cooldown_until FROM icloud_accounts WHERE id = 'acc-1'`,
    ).get() as { pool_cooldown_until: string | null };
    expect(row.pool_cooldown_until).toBeNull();
    const events = output
      .flatMap((chunk) => chunk.trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.module === 'icloud-pool');
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('info');
  });

  it('degrades the account when Apple says the session is dead', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '5');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 421, headers: { get: () => null }, text: async () => 'sign in again',
    })));
    const output: string[] = [];
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await runRefillOnce();
      await runRefillOnce();
    } finally {
      logSpy.mockRestore();
    }

    // 421 is a credential problem, not a rate limit: 'degraded' is what makes
    // the operator (or silent SRP renewal) go fix the cookie. Before this, the
    // account sat 'active' while every refill quietly failed until the pool
    // ran dry.
    const row = getDb().prepare(
      `SELECT status, last_error, pool_cooldown_until FROM icloud_accounts WHERE id = 'acc-1'`,
    ).get() as { status: string; last_error: string; pool_cooldown_until: string | null };
    expect(row.status).toBe('degraded');
    expect(row.last_error).toMatch(/session is not valid/i);
    expect(row.pool_cooldown_until).toBeNull();

    const warnings = output
      .flatMap((chunk) => chunk.trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === 'warn' && entry.module === 'icloud-pool');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ accountId: 'acc-1' });
    expect(warnings[0]?.operatorAction).toMatch(/cookie.*SRP/i);
    expect(warnings[0]?.error).toEqual({ class: 'UpstreamHttpError', category: 'upstream_http', status: 421 });
    expect(output.join('')).not.toMatch(/session is not valid/i);
  });

  it('backs off and keeps Apple’s own wording when a mint is refused', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '5');
    stubApple({ fail: 'You have reached your limit' });

    const result = await runRefillOnce();

    expect(result.created).toBe(0);
    // Apple's failure taxonomy is unknown, so the raw text is recorded rather
    // than classified into an invented error code.
    expect(result.errors.join(' ')).toContain('You have reached your limit');
    const row = getDb().prepare(
      `SELECT pool_cooldown_until, last_error FROM icloud_accounts WHERE id = 'acc-1'`,
    ).get() as { pool_cooldown_until: string | null; last_error: string };
    expect(row.pool_cooldown_until).toBeTruthy();
    expect(row.last_error).toContain('You have reached your limit');
  });

  it('skips an account still inside its cooldown without calling Apple', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '5');
    setCooldown('acc-1', 60_000, 'earlier failure');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const result = await runRefillOnce();

    expect(result.skipped).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips a degraded account, because minting is exactly what it cannot do', async () => {
    seedAccount('acc-deg', 'degraded');
    setSetting('icloud_pool_target', '5');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const result = await runRefillOnce();

    expect(result.skipped).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('refill backoff and budget', () => {
  it('keeps the cooldown when a pass mints some and is then refused', async () => {
    seedAccount();
    setSetting('icloud_pool_target', '5');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify(body),
      });
      if (u.includes('/v2/hme/list')) return json({ success: true, result: { hmeEmails: [] } });
      calls++;
      // Let the first address through, then refuse.
      if (calls > 2) return json({ success: false, error: { errorMessage: 'Rate limited' } });
      if (u.includes('/generate')) return json({ success: true, result: { hme: 'ok1@icloud.com' } });
      return json({ success: true, result: { hme: { hme: 'ok1@icloud.com', anonymousId: 'anon-ok1', label: 'mail-hub', note: '', isActive: true } } });
    }));

    const result = await runRefillOnce();

    expect(result.created).toBe(1);
    // Clearing on any success at all would erase the backoff set moments
    // earlier, and the next tick would go straight back at Apple with no wait.
    const row = getDb().prepare(
      `SELECT pool_cooldown_until FROM icloud_accounts WHERE id = 'acc-1'`,
    ).get() as { pool_cooldown_until: string | null };
    expect(row.pool_cooldown_until).toBeTruthy();
  });

  it('never mints more than the per-tick cap however high the target is set', async () => {
    seedAccount();
    // The settings route allows up to 10000, and every mint permanently spends
    // one of the Apple ID's 750 lifetime slots.
    setSetting('icloud_pool_target', '500');
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify(body),
      });
      if (u.includes('/v2/hme/list')) return json({ success: true, result: { hmeEmails: [] } });
      if (u.includes('/generate')) return json({ success: true, result: { hme: `cap${++n}@icloud.com` } });
      return json({ success: true, result: { hme: { hme: `cap${n}@icloud.com`, anonymousId: `anon-cap${n}`, label: 'mail-hub', note: '', isActive: true } } });
    }));

    const result = await runRefillOnce();

    expect(result.created).toBe(5);
  });
});

describe('refill scheduler timer hygiene', () => {
  it('does not leave a second timer chain when rescheduled mid-tick', async () => {
    vi.useFakeTimers();
    // No account rows, so a tick is a trivial no-op that still exercises arm's
    // finally() re-arm path. Count setTimeout calls that arm the refill timer.
    let armCount = 0;
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      // The refill interval is minutes; ignore the microtask-ish 0ms timers
      // vitest/promises schedule internally.
      if ((ms ?? 0) >= 60_000) armCount++;
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);

    startIcloudPool();          // arm #1 (plus an immediate first pass)
    await vi.advanceTimersByTimeAsync(0);
    const afterStart = armCount;

    rescheduleIcloudPool('interval changed');  // clears #1, arms #2
    const afterReschedule = armCount;
    expect(afterReschedule).toBe(afterStart + 1);

    // Fire the current chain a few times; each tick must re-arm exactly once,
    // never spawning a parallel chain. Before the generation guard, a
    // reschedule that landed during an in-flight tick left two chains and this
    // count would climb by 2 per interval.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    const afterOneInterval = armCount;
    expect(afterOneInterval).toBe(afterReschedule + 1);

    stopIcloudPool();
    const afterStop = armCount;
    // A tick that was pending when we stopped must not re-arm.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(armCount).toBe(afterStop);
  });
});
