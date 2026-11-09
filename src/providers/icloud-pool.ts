import { allRows, DEFAULT_SETTINGS, getDb, getRow, getSetting } from '../db.js';
import { createLogger } from '../logger.js';
import { errorMessage, UpstreamHttpError } from '../errors.js';
import { IcloudClient, MAILHUB_HME_LABEL, MAILHUB_HME_NOTE } from './icloud-client.js';
import { clearCooldown, inCooldown, reconcileAccount, setCooldown } from './icloud.js';
import { beginSrpLogin } from './icloud-auth.js';

const log = createLogger('icloud-pool');

/**
 * How long to stand down after Apple refuses a mint.
 *
 * Apple's failure taxonomy is unknown — neither reference implementation parses
 * it — so every refusal gets the same backoff and the original text is kept.
 * Once real logs exist the wording will justify splitting rate limiting from
 * quota exhaustion; inventing that branch now would be building on a guess.
 */
const COOLDOWN_MS = 45 * 60 * 1000;

interface RefillAccount {
  id: string;
  status: string;
  region: string;
  cookies: string;
  hme_service_url: string;
  auth_mode: string;
  password: string;
}

/**
 * 401/403/421 from Apple mean the session died — a credential problem, not a
 * rate limit. The 45-minute mint backoff exists for quota refusals; a dead
 * cookie needs the account marked 'degraded' so the operator (or the silent
 * renewal below) goes and fixes the credential instead of the pool silently
 * skipping mints until it drains.
 */
function isSessionError(e: unknown): boolean {
  return e instanceof UpstreamHttpError && [401, 403, 421].includes(e.status);
}

function degradeAccount(accountId: string, error: unknown): void {
  // Only 'active' can degrade: 'error' is the read half, which a dead cookie
  // neither causes nor cures, and its text must survive for the operator.
  const result = getDb().prepare(
    `UPDATE icloud_accounts SET status = 'degraded', last_error = ? WHERE id = ? AND status = 'active'`,
  ).run(errorMessage(error), accountId);
  if (result.changes === 1) {
    log.warn('iCloud account session degraded; operator action required', {
      accountId,
      error: error,
      operatorAction: 'Refresh the cookie or complete an SRP sign-in',
    });
  }
}

/**
 * One silent-renewal attempt per degradation, not per tick.
 *
 * beginSrpLogin without a live trust token makes Apple push a 2FA prompt to
 * the owner's devices; retrying every tick would buzz their phone four times
 * an hour until someone typed a code. The set clears when the account is seen
 * active again, so the next degradation gets exactly one fresh attempt.
 */
const renewalAttempted = new Set<string>();

/** Test hook: the set is process-level state, like the Outlook token cache. */
export function resetRenewalAttempts(): void {
  renewalAttempted.clear();
}

/** True when the account came back 'active' and the pass may continue with it. */
async function tryRenewSession(account: RefillAccount): Promise<boolean> {
  if (account.auth_mode !== 'srp' || !account.password) return false;
  if (renewalAttempted.has(account.id)) return false;
  renewalAttempted.add(account.id);
  try {
    const { needsMfa } = await beginSrpLogin(account.id);
    if (needsMfa) {
      // Apple wants a code and no human is present. The stored password alone
      // cannot finish this; leave the account degraded and say why, instead of
      // letting refills silently skip it until the pool runs dry.
      log.warn('iCloud silent renewal needs a 2FA code', { accountId: account.id });
      getDb().prepare(
        `UPDATE icloud_accounts SET last_error = ? WHERE id = ? AND status = 'degraded'`,
      ).run('SRP renewal needs a 2FA code — sign in from the admin iCloud page', account.id);
      return false;
    }
    // persistSession inside beginSrpLogin has already flipped the account back
    // to 'active' and stored the fresh cookies.
    renewalAttempted.delete(account.id);
    log.info('iCloud session renewed silently', { accountId: account.id });
    return true;
  } catch (e) {
    log.warn('iCloud silent renewal failed', { accountId: account.id, error: e });
    getDb().prepare(
      `UPDATE icloud_accounts SET last_error = ? WHERE id = ? AND status = 'degraded'`,
    ).run(`SRP renewal failed: ${errorMessage(e)}`, account.id);
    return false;
  }
}

/**
 * Ceiling on how many addresses one tick may mint.
 *
 * `icloud_pool_target` is operator-settable and the settings route clamps it at
 * 10000, but every mint permanently spends one of an Apple ID's 750 lifetime
 * slots. Without a per-tick bound, one fat-fingered setting drains the account
 * in a single pass and nothing can give the slots back.
 */
const MAX_MINTS_PER_TICK = 5;

/** Guards against a slow tick overlapping the next one and double-minting. */
let running = false;

export async function runRefillOnce(): Promise<{ created: number; skipped: number; errors: string[] }> {
  if (running) return { created: 0, skipped: 0, errors: ['refill already running'] };
  running = true;
  try {
    return await refillPass();
  } finally {
    running = false;
  }
}

async function refillPass(): Promise<{ created: number; skipped: number; errors: string[] }> {
  // An operator who turned this off wants Apple left alone, not merely a
  // smaller pool — the switch is checked per pass so it takes effect at the
  // next tick rather than at the next restart.
  if (getSetting('icloud_pool_enabled', DEFAULT_SETTINGS.icloud_pool_enabled) === '0') {
    return { created: 0, skipped: 0, errors: [] };
  }
  const db = getDb();
  const target = Number(getSetting('icloud_pool_target', DEFAULT_SETTINGS.icloud_pool_target)) || 10;

  const accounts = allRows<RefillAccount>(
    db,
    `SELECT id, status, region, cookies, hme_service_url, auth_mode, password
       FROM icloud_accounts
      WHERE status IN ('active', 'degraded')`,
  );

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  const countFree = db.prepare(
    `SELECT COUNT(*) AS c FROM icloud_addresses WHERE account_id = ? AND state = 'free'
      AND (upstream_active IS NULL OR upstream_active = 1)`,
  );

  for (const account of accounts) {
    // 'degraded' means the cookie expired. Such an account still serves the
    // addresses already in its pool, but minting is precisely what an expired
    // cookie cannot do. When the account signed in over SRP and left its
    // password, the stored trust token can usually buy a fresh session with no
    // human involved — that is the entire reason the password is stored. Only
    // when that fails (or is impossible) is the account passed over.
    if (account.status !== 'active') {
      if (!(await tryRenewSession(account))) { skipped++; continue; }
      const fresh = getRow<RefillAccount>(
        db,
        `SELECT id, status, region, cookies, hme_service_url, auth_mode, password
           FROM icloud_accounts WHERE id = ?`,
        account.id,
      );
      if (!fresh || fresh.status !== 'active') { skipped++; continue; }
      Object.assign(account, fresh);
    } else {
      // Seen healthy: the next degradation deserves a fresh renewal attempt.
      renewalAttempted.delete(account.id);
    }
    if (inCooldown(account.id)) { skipped++; continue; }

    // A pool already at target needs neither minting nor reconciliation —
    // reconciling exists to stop double-minting, so with no mint coming there
    // is nothing to ask Apple. Skipping the call matters beyond politeness:
    // every tick against a full pool would otherwise burn a request per
    // account, forever.
    if ((countFree.get(account.id) as { c: number }).c >= target) continue;

    const client = new IcloudClient({
      cookies: account.cookies,
      region: account.region,
      serviceUrl: account.hme_service_url || undefined,
    });

    // Reconcile first: an address Apple already holds for us is free to adopt,
    // and minting on top of it would spend a slot for nothing.
    try {
      const { adopted, unowned } = await reconcileAccount(account.id, client);
      if (adopted.length) log.info('adopted iCloud addresses from Apple', { accountId: account.id, count: adopted.length });
      if (unowned.length) log.warn('unmarked iCloud addresses left alone', { accountId: account.id, addresses: unowned });
    } catch (e) {
      // A failed LIST says nothing about the mint quota, so it must not spend
      // the 45-minute mint backoff — the next tick simply tries again. A dead
      // session is a different thing entirely and is marked as such.
      const message = errorMessage(e);
      errors.push(message);
      if (isSessionError(e)) degradeAccount(account.id, e);
      else log.info('iCloud reconcile failed; will retry next tick', { accountId: account.id, error: e });
      continue;
    }

    const free = countFree.get(account.id) as { c: number };

    const insert = db.prepare(
      // Reserve returns identity only. Activity remains unknown until LIST.
      `INSERT INTO icloud_addresses (hme, account_id, anonymous_id, upstream_active, upstream_checked_at)
       VALUES (?, ?, ?, NULL, NULL)`,
    );

    const wanted = Math.max(0, target - free.c);
    const budget = Math.min(wanted, MAX_MINTS_PER_TICK);

    let minted = 0;
    let refused = false;
    for (let i = 0; i < budget; i++) {
      try {
        const candidate = await client.generate();
        const reserved = await client.reserve(candidate, MAILHUB_HME_LABEL, MAILHUB_HME_NOTE);
        insert.run(reserved.hme, account.id, reserved.anonymousId);
        minted++;
      } catch (e) {
        const message = errorMessage(e);
        errors.push(message);
        // A dead session is a credential problem: degrade so renewal or the
        // operator fixes it. Anything else is treated as Apple refusing to
        // mint, which is what the long backoff is for.
        if (isSessionError(e)) degradeAccount(account.id, e);
        else setCooldown(account.id, COOLDOWN_MS, message);
        refused = true;
        break;
      }
    }

    if (minted > 0) {
      created += minted;
      log.info('minted iCloud addresses', { accountId: account.id, count: minted });
    }
    // Clearing unconditionally would erase the backoff set moments earlier
    // whenever a pass minted something before Apple refused — two of five, say —
    // and the next tick would go straight back at Apple with no wait at all.
    if (minted > 0 && !refused) clearCooldown(account.id);

    if (wanted > budget) {
      log.info('refill capped for this tick', {
        accountId: account.id, wanted, minted, cap: MAX_MINTS_PER_TICK,
      });
    }
  }

  return { created, skipped, errors };
}

let timer: ReturnType<typeof setTimeout> | undefined;

function intervalMs(): number {
  const minutes = Number(getSetting('icloud_pool_interval_minutes', DEFAULT_SETTINGS.icloud_pool_interval_minutes)) || 15;
  return Math.max(1, minutes) * 60 * 1000;
}

/**
 * Set while the scheduler is meant to be running.
 *
 * A tick that is already in flight when stop is called would otherwise re-arm
 * from its own `finally`, resurrecting a scheduler the caller just shut down —
 * and in tests that means a timer firing into a closed database.
 */
let enabled = false;

/**
 * Bumped by every scheduler-control action (start/reschedule/stop).
 *
 * A refill tick captures the value live when it was armed. When that tick's
 * `finally` re-arms, it only does so if its captured value still matches — so
 * a tick that was in flight across a reschedule or stop no longer re-arms a
 * chain the control action already replaced or tore down. Without this, a
 * reschedule during an awaiting tick leaves two live timer chains, one of them
 * untracked and able to fire after stopIcloudPool().
 */
let generation = 0;

function arm(): void {
  if (!enabled) return;
  const armedGeneration = generation;
  timer = setTimeout(() => {
    void runRefillOnce()
      .catch((e: unknown) => log.error('iCloud refill failed', { error: e }))
      // arm() reads a setting and can throw; letting that escape here would
      // kill the interval permanently with nothing left to restart it.
      .finally(() => {
        // A reschedule or stop that happened while this tick ran already armed
        // (or deliberately did not arm) the current chain; re-arming here would
        // duplicate it.
        if (armedGeneration !== generation) return;
        try { arm(); } catch (e) {
          log.error('iCloud refill failed to reschedule', { error: e });
        }
      });
  }, intervalMs());
  // A refill tick must never hold the process open at shutdown.
  timer.unref?.();
}

export function startIcloudPool(): void {
  if (enabled) return;
  enabled = true;
  generation++;
  // First pass now, exactly as cleanupExpired runs at boot: a 15-minute timer
  // never fires under a dev watcher that restarts more often than that, and an
  // operator who just brought the service up should not wait a full interval
  // to see the pool move. Restart hammering is bounded by the DB-persisted
  // cooldown and the at-target early exit, both of which survive the restart.
  void runRefillOnce()
    .catch((e: unknown) => log.error('iCloud refill failed', { error: e }));
  arm();
}

/**
 * Re-arm the timer when the interval setting changes, mirroring
 * rescheduleBackup — without this the old interval keeps running until the
 * next restart, and nothing tells the operator their change did not take.
 */
export function rescheduleIcloudPool(reason = 'settings updated'): void {
  if (!enabled) return;
  // Bumping the generation orphans any tick currently awaiting Apple, so its
  // finally() will not add a second timer chain on top of the one armed here.
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  arm();
  log.info('iCloud refill rescheduled', { reason });
}

export function stopIcloudPool(): void {
  enabled = false;
  // An in-flight tick checks this on re-arm and stands down instead of
  // resurrecting the scheduler the caller just shut down.
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
