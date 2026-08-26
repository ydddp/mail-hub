import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { getDb, getRow, logActivity } from '../db.js';
import type { AdminEnv } from './admin.js';
import { IcloudClient, IcloudDefinitiveRejection, MAILHUB_HME_LABEL, MAILHUB_HME_NOTE } from '../providers/icloud-client.js';
import { testConnection } from '../providers/imap-core.js';
import { parseCookieBlob } from '../providers/icloud-cookie.js';
import { fetchHmeMessage, fetchHmeMessages, getAccountById } from '../providers/icloud.js';
import { beginSrpLogin, completeSrpLogin, deleteTrustToken, listTrustedPhones, markAccountDeleted, sendSmsCode } from '../providers/icloud-auth.js';
import { errorMessage } from '../errors.js';
import { createLogger } from '../logger.js';

export const icloudRoutes = new Hono<AdminEnv>();
const log = createLogger('icloud-route');

icloudRoutes.use('/icloud/*', async (c, next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
});

// Secrets never leave the server: cookies and the app-specific password are
// write-only, matching how imap_accounts.password is handled.
const PUBLIC_COLUMNS = `id, apple_id, region, auth_mode, hme_service_url,
  imap_host, imap_port, imap_user, imap_tls, status, last_error,
  last_checked_at, created_at`;

icloudRoutes.get('/icloud/accounts', (c) => {
  const rows = getDb().prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM icloud_accounts ORDER BY created_at DESC`,
  ).all();
  return c.json({ accounts: rows });
});

icloudRoutes.post('/icloud/accounts', async (c) => {
  const body = await c.req.json<{
    appleId?: string; region?: string; cookies?: string;
    imapUser?: string; imapPassword?: string; imapHost?: string; imapPort?: number;
  }>();

  if (!body.appleId || !body.cookies) {
    return c.json({ error: 'appleId and cookies are required' }, 400);
  }

  // Accept the whole clipboard — cURL in any dialect, PowerShell, a cookie
  // extension's JSON, or the bare header — and reject here rather than letting
  // a half-copied paste fail an hour later as "session not valid".
  const parsed = parseCookieBlob(body.cookies);
  if (parsed.missing.length) {
    return c.json({
      error: `Could not find ${parsed.missing.join(' and ')} in what you pasted. Copy a request made to icloud.com after signing in — the /reportStats one is missing X-APPLE-WEBAUTH-USER, so pick an hme or maildomainws request instead.`,
      found: parsed.names,
      missing: parsed.missing,
    }, 400);
  }

  const id = randomUUID();
  // status starts 'pending', not the schema default 'active': neither half has
  // been proven yet. getAccountById and the refill/dispatch queries all take
  // only 'active'/'degraded', so a pending account mints nothing and dispatches
  // nothing until /test flips it — which is what stops a good cookie paired
  // with a wrong IMAP password from serving inboxes whose every poll fails.
  getDb().prepare(
    `INSERT INTO icloud_accounts
       (id, apple_id, region, auth_mode, cookies, imap_user, imap_password, imap_host, imap_port, status)
     VALUES (?, ?, ?, 'cookie', ?, ?, ?, COALESCE(?, 'imap.mail.me.com'), COALESCE(?, 993), 'pending')`,
  ).run(
    id,
    body.appleId,
    body.region === 'china' ? 'china' : 'global',
    parsed.cookies,
    body.imapUser ?? body.appleId,
    body.imapPassword ?? '',
    body.imapHost ?? null,
    body.imapPort ?? null,
  );

  logActivity('green', `Added iCloud account ${body.appleId}`);
  const account = getRow(getDb(), `SELECT ${PUBLIC_COLUMNS} FROM icloud_accounts WHERE id = ?`, id);
  return c.json({ account });
});

icloudRoutes.delete('/icloud/accounts/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  // Read the Apple ID up front: its on-disk trust token has to be erased along
  // with the row, and once the row is gone there is no way to recompute the
  // file path.
  const acc = getRow<{ apple_id: string }>(
    db, `SELECT apple_id FROM icloud_accounts WHERE id = ?`, id,
  );

  // An address handed to a live inbox is not ours to drop: deleting the row
  // orphans that inbox and permanently burns the alias, since nothing is left
  // to tell us the Apple ID still owns it.
  const held = getRow<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM icloud_addresses WHERE account_id = ? AND state = 'assigned'`,
    id,
  )?.c ?? 0;
  if (held > 0 && c.req.query('force') !== '1') {
    return c.json({
      error: `${held} address(es) are still assigned to live inboxes. Close those inboxes first, or repeat with ?force=1 to delete anyway.`,
      assigned: held,
    }, 409);
  }

  if (!acc) return c.json({ error: 'Account not found' }, 404);

  // The row must remain available for a retry until its 2FA-bypass credential
  // is gone. rmSync(force) already treats an absent token as success.
  try {
    deleteTrustToken(acc.apple_id);
  } catch (e) {
    return c.json({ error: `Could not erase the iCloud trust token: ${errorMessage(e)}` }, 500);
  }
  markAccountDeleted(acc.apple_id);

  db.prepare(`DELETE FROM icloud_addresses WHERE account_id = ?`).run(id);
  const result = db.prepare(`DELETE FROM icloud_accounts WHERE id = ?`).run(id);
  if (result.changes === 0) return c.json({ error: 'Account not found' }, 404);
  // The trust token is a 2FA-bypass credential; it must not outlive the account.
  // markAccountDeleted covers the race where an SRP sign-in for the same Apple
  // ID is in flight: the icloudjs library writes a fresh token file when its
  // awaitReady resolves, which can land after this delete, so the sign-in's own
  // completion re-erases it. Delete always wins.
  logActivity('rose', `Removed iCloud account ${id}`);
  return c.json({ ok: true });
});

interface AuthRow {
  id: string; region: string; cookies: string; hme_service_url: string;
  imap_host: string; imap_port: number; imap_user: string; imap_password: string; imap_tls: number;
}

function loadAuth(id: string): AuthRow | undefined {
  return getRow<AuthRow>(
    getDb(),
    `SELECT id, region, cookies, hme_service_url,
            imap_host, imap_port, imap_user, imap_password, imap_tls
       FROM icloud_accounts WHERE id = ?`,
    id,
  );
}

/**
 * Point at the cause, not just the rejection.
 *
 * iCloud's IMAP refuses for three reasons that look identical in the protocol
 * response, and only one of them is "wrong password". The other two are
 * invisible unless someone tells you: the login has to be the @icloud.com
 * mailbox rather than the Apple ID (they differ whenever the Apple ID is a
 * gmail or outlook address), and a regular account password is always refused
 * because iCloud only accepts app-specific ones.
 */
function imapHint(account: AuthRow, error?: string): string {
  const authFailed = /authentication rejected|AUTHENTICATIONFAILED|LOGIN failed|Invalid credentials/i.test(error ?? '');
  if (!authFailed) return '';

  const domain = account.imap_user.split('@')[1]?.toLowerCase() ?? '';
  const host = account.imap_host.toLowerCase();
  const hints: string[] = [];

  // Hide My Email delivers to whatever address the owner verified, which is
  // frequently not an Apple mailbox — so pointing at Apple's IMAP is itself the
  // mistake, and telling them to find an @icloud.com address would be wrong.
  if (host.includes('me.com') && !/^(icloud|me|mac)\.com$/.test(domain)) {
    hints.push(`the host is Apple's but the mailbox is ${account.imap_user}; if Hide My Email forwards there, point the host at that provider instead (gmail.com → imap.gmail.com, outlook/hotmail → outlook.office365.com)`);
  }

  if (host.includes('gmail')) {
    hints.push('Gmail needs an App Password from myaccount.google.com → Security → App passwords, which only appears once 2-Step Verification is on; the normal account password is always rejected');
  } else if (host.includes('me.com')) {
    hints.push('iCloud needs an app-specific password from appleid.apple.com → Sign-In and Security → App-Specific Passwords, and iCloud Mail has to be switched on or there is no mailbox to log in to');
  } else {
    hints.push('most providers reject the normal account password over IMAP and require an app-specific one');
  }

  return ` — ${hints.join('; ')}`;
}

/**
 * Test both halves, because an account needs both to be useful.
 *
 * The cookie mints addresses; the app-specific password reads their mail. A
 * check that only exercised the cookie would report a healthy account whose
 * every poll then fails, and the operator would have no idea which credential
 * to go fix.
 */
icloudRoutes.post('/icloud/accounts/:id/test', async (c) => {
  const account = loadAuth(c.req.param('id'));
  if (!account) return c.json({ error: 'Account not found' }, 404);

  let serviceUrl = '';
  let hmeError: string | undefined;
  let forwardTo = '';
  try {
    const client = new IcloudClient({ cookies: account.cookies, region: account.region });
    serviceUrl = await client.validate();
    // Where the aliases actually deliver. Nothing else tells the operator which
    // mailbox to point the IMAP half at, and assuming the Apple ID's own
    // address is wrong whenever that address belongs to another provider.
    forwardTo = (await client.listWithForwarding()).selectedForwardTo;
  } catch (e) {
    hmeError = errorMessage(e);
  }

  let imapError: string | undefined;
  if (!account.imap_password) {
    imapError = 'No app-specific password saved; mail for these addresses cannot be read';
  } else {
    const result = await testConnection({
      poolKey: `icloud-test:${account.id}`,
      host: account.imap_host,
      port: account.imap_port,
      user: account.imap_user,
      password: account.imap_password,
      tls: account.imap_tls === 1,
    });
    if (!result.ok) imapError = `${result.error ?? 'connection failed'}${imapHint(account, result.error)}`;
  }

  const ok = !hmeError && !imapError;
  const combined = [hmeError && `Hide My Email: ${hmeError}`, imapError && `IMAP: ${imapError}`]
    .filter(Boolean).join(' | ');

  // The two halves fail independently and cost different things. A cookie
  // expires within hours, but that only stops MINTING — every address already
  // in the pool still delivers, and reading them needs nothing from Apple.
  // Marking the whole account unusable there would strand a full pool and make
  // an ordinary session timeout look like an outage.
  const status = imapError ? 'error' : (hmeError ? 'degraded' : 'active');

  getDb().prepare(
    `UPDATE icloud_accounts
        SET hme_service_url = COALESCE(NULLIF(?, ''), hme_service_url),
            status = ?, last_error = ?, last_checked_at = datetime('now')
      WHERE id = ?`,
  ).run(serviceUrl, status, combined || null, account.id);

  // A mismatch here is the most common reason the IMAP half fails, and it is
  // invisible from the protocol error alone.
  const forwardMismatch = forwardTo && account.imap_user
    && forwardTo.toLowerCase() !== account.imap_user.toLowerCase()
    ? `Hide My Email delivers to ${forwardTo}, but the IMAP login is ${account.imap_user}. Set the mailbox address to ${forwardTo} and use that provider's IMAP host if it is not Apple's.`
    : undefined;

  return c.json({
    ok,
    serviceUrl: serviceUrl || account.hme_service_url,
    forwardTo,
    forwardMismatch,
    hmeError,
    imapError,
  });
});

/**
 * Replace an expired cookie in place.
 *
 * Sessions expire, and forcing a delete-and-recreate would throw away the
 * account's whole address pool with it — every one of those aliases is a
 * permanently spent slot from the 750 an Apple ID ever gets.
 */
icloudRoutes.post('/icloud/accounts/:id/cookies', async (c) => {
  const account = loadAuth(c.req.param('id'));
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const body = await c.req.json<{ cookies?: string }>().catch(() => ({} as { cookies?: string }));
  if (!body.cookies) return c.json({ error: 'cookies is required' }, 400);

  const parsed = parseCookieBlob(body.cookies);
  if (parsed.missing.length) {
    return c.json({
      error: `Could not find ${parsed.missing.join(' and ')} in what you pasted. Copy a request made to icloud.com after signing in — the /reportStats one is missing X-APPLE-WEBAUTH-USER, so pick an hme or maildomainws request instead.`,
      found: parsed.names,
      missing: parsed.missing,
    }, 400);
  }

  // The partition host is tied to the session, so a new cookie invalidates the
  // cached one; clearing it makes the next call rediscover rather than fail.
  //
  // 'degraded' means exactly one thing — the cookie had expired — and a fresh
  // one is the cure. Leaving the status alone would keep the refill task
  // skipping this account forever, since it only mints for 'active' ones, and
  // the pool would drain with nothing saying why. 'error' is left as it is:
  // that one is the read half, which a new cookie does not touch.
  // last_error follows the same rule as status: only the cured half's record
  // goes. When status is 'error' the text describes the IMAP half, which a new
  // cookie does not touch — clearing it would leave an 'error' account with
  // nothing saying why.
  getDb().prepare(
    `UPDATE icloud_accounts
        SET cookies = ?,
            hme_service_url = '',
            last_error = CASE WHEN status = 'degraded' THEN NULL ELSE last_error END,
            status = CASE WHEN status = 'degraded' THEN 'active' ELSE status END
      WHERE id = ?`,
  ).run(parsed.cookies, account.id);

  logActivity('green', `Refreshed iCloud cookie for ${account.id.slice(0, 8)}`);
  return c.json({ ok: true, found: parsed.names });
});

/**
 * Sign in with the Apple ID password instead of a pasted cookie.
 *
 * Apple pushes a six-digit code to the owner's trusted devices on the first
 * sign-in only; after that the stored trust token makes Apple answer 200 where
 * it answered 409, and this endpoint alone completes the whole exchange. That
 * is the difference between a credential that dies in hours and one that lasts
 * weeks.
 *
 * Known limitation: the in-flight SRP state is a live client object that cannot
 * be serialised, so it lives in an in-memory map beside the session row. A
 * restart between begin and complete loses the attempt and this endpoint is
 * called again — Apple pushes a fresh code. Sessions expire after five minutes
 * regardless.
 */
icloudRoutes.post('/icloud/accounts/:id/srp/begin', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
  let previous: { password: string; auth_mode: string } | undefined;

  // The password has to be stored, not merely used: silent renewal repeats the
  // SRP handshake later with no human present. It is write-only, exactly as the
  // cookie and the app-specific password already are.
  if (body.password) {
    previous = getRow<{ password: string; auth_mode: string }>(
      getDb(), `SELECT password, auth_mode FROM icloud_accounts WHERE id = ?`, id,
    );
    if (!previous) return c.json({ error: 'Account not found' }, 404);
    const updated = getDb().prepare(
      `UPDATE icloud_accounts SET password = ?, auth_mode = 'srp' WHERE id = ?`,
    ).run(body.password, id);
    if (updated.changes === 0) return c.json({ error: 'Account not found' }, 404);
  }

  try {
    const result = await beginSrpLogin(id);
    logActivity('green', result.needsMfa
      ? `iCloud SRP sign-in awaiting 2FA code for ${id.slice(0, 8)}`
      : `iCloud SRP session renewed for ${id.slice(0, 8)}`);
    // Only the session handle and whether a code is needed — never the
    // password, the trust token, or the cookies they produced.
    return c.json(result);
  } catch (e) {
    if (previous) {
      getDb().prepare(
        `UPDATE icloud_accounts SET password = ?, auth_mode = ? WHERE id = ?`,
      ).run(previous.password, previous.auth_mode, id);
    }
    return c.json({ error: errorMessage(e) }, 400);
  }
});

/**
 * Offer SMS as well as the device push.
 *
 * icloudjs only knows how to verify a code pushed to a signed-in Apple device,
 * which is no help to an operator with no Apple hardware to hand — an ordinary
 * situation when the Apple ID was made in a browser. Apple's own web flow lists
 * the trusted phone numbers, so they are offered here too.
 */
icloudRoutes.get('/icloud/srp/:sessionId/phones', async (c) => {
  const phones = await listTrustedPhones(c.req.param('sessionId'));
  // Apple masks the digits itself, so what comes back is safe to display.
  return c.json({ phones });
});

icloudRoutes.post('/icloud/srp/:sessionId/sms', async (c) => {
  const body = await c.req.json<{ phoneId?: number }>().catch(() => ({} as { phoneId?: number }));
  if (typeof body.phoneId !== 'number') return c.json({ error: 'phoneId is required' }, 400);
  const result = await sendSmsCode(c.req.param('sessionId'), body.phoneId);
  return c.json(result, result.ok ? 200 : 400);
});

icloudRoutes.post('/icloud/accounts/:id/srp/complete', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ sessionId?: string; code?: string }>()
    .catch(() => ({} as { sessionId?: string; code?: string }));
  if (!body.sessionId || !body.code) {
    return c.json({ error: 'sessionId and code are required' }, 400);
  }

  // The URL's account id rides along so a session can only be completed under
  // the account that began it — completeSrpLogin refuses a mismatch.
  const result = await completeSrpLogin(body.sessionId, body.code, id);
  if (!result.ok) return c.json({ error: result.error }, 400);

  logActivity('green', `iCloud SRP sign-in completed for ${id.slice(0, 8)}`);
  return c.json({ ok: true });
});

icloudRoutes.get('/icloud/addresses', (c) => {
  const rows = getDb().prepare(
    `SELECT hme, account_id, anonymous_id, state, assigned_inbox_id, assigned_at, use_count, created_at
       FROM icloud_addresses ORDER BY created_at DESC`,
  ).all();
  return c.json({ addresses: rows });
});

interface RetireRow {
  anonymous_id: string;
  state: string;
  region: string;
  cookies: string;
  hme_service_url: string;
}

/**
 * Deactivate a burned address at Apple and take it out of rotation for good.
 *
 * This is the only place Apple-side deactivation belongs. Release and expiry
 * deliberately return an address to `free` and never call Apple, because
 * recycling is the entire premise of the pool — an Apple ID only ever gets 750
 * addresses. Once a target has blocked one, though, the slot is spent either
 * way, and handing it to the next tenant only burns their registration too.
 *
 * Apple is called BEFORE the local write, and a failure leaves the row exactly
 * as it was. The other order is worse than a failed request: a row marked
 * `retired` while the alias is still forwarding is a lie nothing will ever
 * retry, so the address would keep delivering a burned target's mail forever
 * with no record that it should not.
 */
/**
 * Read an address's mail directly, without an inbox.
 *
 * The tenant-facing route deliberately hides anything older than the inbox it
 * is asked about, which is right for a tenant and useless for an operator
 * diagnosing "did this address ever receive anything". Outlook has the same
 * pair for the same reason. Admin-only, like everything else on this router.
 */
icloudRoutes.get('/icloud/addresses/:hme/messages', async (c) => {
  const hme = c.req.param('hme');
  const row = getRow<{ account_id: string }>(
    getDb(), `SELECT account_id FROM icloud_addresses WHERE hme = ?`, hme,
  );
  if (!row) return c.json({ error: 'Address not found' }, 404);

  const account = getAccountById(row.account_id);
  if (!account) return c.json({ error: 'The Apple ID behind this address is not usable' }, 409);

  try {
    const messages = await fetchHmeMessages(account, hme);
    return c.json({ messages });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

icloudRoutes.get('/icloud/addresses/:hme/messages/:uid', async (c) => {
  const hme = c.req.param('hme');
  const row = getRow<{ account_id: string }>(
    getDb(), `SELECT account_id FROM icloud_addresses WHERE hme = ?`, hme,
  );
  if (!row) return c.json({ error: 'Address not found' }, 404);

  const account = getAccountById(row.account_id);
  if (!account) return c.json({ error: 'The Apple ID behind this address is not usable' }, 409);

  try {
    // The recipient check still applies: an id names a message anywhere in the
    // shared forwarding mailbox, including the operator's own private mail.
    const message = await fetchHmeMessage(account, hme, c.req.param('uid'));
    return c.json({ message });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 404);
  }
});

icloudRoutes.post('/icloud/addresses/:hme/retire', async (c) => {
  const hme = c.req.param('hme');
  const db = getDb();

  const row = getRow<RetireRow>(
    db,
    `SELECT a.anonymous_id, a.state,
            COALESCE(acc.region, 'global') AS region,
            COALESCE(acc.cookies, '') AS cookies,
            COALESCE(acc.hme_service_url, '') AS hme_service_url
       FROM icloud_addresses a
       LEFT JOIN icloud_accounts acc ON acc.id = a.account_id
      WHERE a.hme = ?`,
    hme,
  );
  if (!row) return c.json({ error: 'Address not found' }, 404);

  // A live inbox is still reading this alias. Deactivating it would stop that
  // inbox receiving without anything saying why.
  if (row.state === 'assigned') {
    return c.json({
      error: 'This address is assigned to a live inbox. Close that inbox first, then retire the address.',
    }, 409);
  }

  // Claim BEFORE calling Apple. Dispatch only takes 'free' rows, so flipping
  // the state first closes the race where a dispatch grabbed the address while
  // Apple was deactivating it — the alias ended up dead at Apple but back in
  // rotation locally, silently receiving nothing.
  //
  // The claim matches only the two terminal states, never 'retiring' itself:
  // a second concurrent retire that saw 'retiring' must fail here rather than
  // win the same-value UPDATE (SQLite counts a no-op 'retiring'→'retiring' as
  // changes===1), because if the first request then rolls back to 'free' the
  // second's success write would target a row that is no longer 'retiring' and
  // be silently dropped, stranding a dead alias as dispatchable.
  // A crash between this claim and the final write leaves the row parked in
  // 'retiring'. That is deliberately left alone: dispatch only draws 'free',
  // so a stuck row is out of rotation and can never be handed out — at worst
  // it costs one pool slot, which an operator can inspect. Auto-reclaiming it
  // would risk freeing an alias Apple had already deactivated.
  const claimed = db.prepare(
    `UPDATE icloud_addresses SET state = 'retiring' WHERE hme = ? AND state IN ('free', 'retired')`,
  ).run(hme);
  if (claimed.changes === 0) {
    return c.json({
      error: 'This address is being retired or has been claimed by an inbox. Try again in a moment.',
    }, 409);
  }

  const client = new IcloudClient({
    cookies: row.cookies,
    region: row.region,
    serviceUrl: row.hme_service_url || undefined,
  });

  try {
    await client.deactivate(row.anonymous_id);
  } catch (e) {
    // Only a completed response that explicitly rejects deactivation proves the
    // alias still forwards, so only then is it safe to return the row to the
    // pool. A timeout or malformed/5xx/auth response can land AFTER Apple has
    // already applied the change; returning the alias to 'free' on those would
    // hand a dead address back to dispatch, and the tenant would silently
    // receive nothing. So anything short of a definitive rejection stays
    // fail-closed in 'retiring' (out of rotation), which an operator can
    // inspect. Apple's raw message is still surfaced to the caller.
    if (e instanceof IcloudDefinitiveRejection) {
      db.prepare(`UPDATE icloud_addresses SET state = ? WHERE hme = ? AND state = 'retiring'`)
        .run(row.state, hme);
    } else {
      log.warn('iCloud address retirement is ambiguous; operator action required', {
        address: hme,
        error: errorMessage(e),
        operatorAction: 'Inspect the address and retry retirement after checking Apple',
      });
    }
    return c.json({ error: errorMessage(e) }, 502);
  }

  db.prepare(`UPDATE icloud_addresses SET state = 'retired' WHERE hme = ? AND state = 'retiring'`).run(hme);

  logActivity('rose', `Retired iCloud address ${hme}`);
  return c.json({ ok: true });
});

icloudRoutes.post('/icloud/accounts/:id/generate', async (c) => {
  const account = loadAuth(c.req.param('id'));
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const body = await c.req.json<{ count?: number }>().catch(() => ({ count: 1 }));
  const count = Math.min(Math.max(body.count ?? 1, 1), 5);

  const client = new IcloudClient({
    cookies: account.cookies,
    region: account.region,
    serviceUrl: account.hme_service_url || undefined,
  });

  const insert = getDb().prepare(
    `INSERT INTO icloud_addresses (hme, account_id, anonymous_id) VALUES (?, ?, ?)`,
  );

  const addresses: string[] = [];
  let error: string | undefined;
  for (let i = 0; i < count; i++) {
    try {
      // The client resolves the partition host itself on first use, so a
      // freshly added account works without anyone knowing to press "test".
      const candidate = await client.generate();
      const reserved = await client.reserve(candidate, MAILHUB_HME_LABEL, MAILHUB_HME_NOTE);
      insert.run(reserved.hme, account.id, reserved.anonymousId);
      addresses.push(reserved.hme);
    } catch (e) {
      // Apple's failure taxonomy is unknown, so the raw text is surfaced and
      // stored rather than being classified into an invented error code.
      error = errorMessage(e);
      getDb().prepare(`UPDATE icloud_accounts SET last_error = ? WHERE id = ?`).run(error, account.id);
      break;
    }
  }

  // Cache whatever host the client discovered so later calls skip the lookup.
  if (addresses.length && !account.hme_service_url) {
    try {
      getDb().prepare(`UPDATE icloud_accounts SET hme_service_url = ? WHERE id = ?`)
        .run(client.serviceUrl(), account.id);
    } catch { /* discovery failed earlier; the error above already says so */ }
  }

  if (addresses.length) logActivity('green', `Generated ${addresses.length} iCloud address(es)`);
  return c.json({ created: addresses.length, addresses, error });
});
