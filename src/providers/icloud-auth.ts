import { randomUUID } from 'crypto';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, format, join } from 'path';
import iCloudService from 'icloudjs';
import { isNativeError } from 'node:util/types';
import { config } from '../config.js';
import { getDb, getRow } from '../db.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../errors.js';
import { parseCookieBlob } from './icloud-cookie.js';

const log = createLogger('icloud-auth');

/**
 * icloudjs ships a CommonJS build that puts the class on `exports.default`.
 * Node's ESM interop hands a default import the whole `module.exports` wrapper
 * instead of that class, so it has to be unwrapped by hand — otherwise `new
 * IcloudService()` is "not a constructor" in production while every test
 * passes, because bundlers do the unwrapping for you.
 */
const IcloudService = (iCloudService as unknown as { default?: typeof iCloudService }).default
  ?? iCloudService;

/** Sessions are pushed a code by Apple; five minutes is plenty to type it. */
const SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Apple IDs whose account row was just deleted, mapped to the delete instant.
 *
 * Deleting an account erases its on-disk trust token (a 2FA-bypass credential),
 * but an SRP sign-in for the same Apple ID can be mid-flight: it awaits Apple,
 * and the icloudjs library writes a fresh trust-token file the moment awaitReady
 * resolves — which can land AFTER the delete already ran, resurrecting the file
 * with no account row left to own or clean it. Recording the delete here lets
 * the sign-in's own completion notice "this account was deleted while I was in
 * flight" and erase the file it just caused, so delete always wins.
 *
 * In memory on purpose: the only thing it has to outlive is an in-flight
 * request, and a restart drops every pending SRP client too, so there is
 * nothing left to resurrect the file after one.
 */
const recentlyDeletedAppleIds = new Map<string, number>();
const DELETE_TOMBSTONE_TTL_MS = SESSION_TTL_MS * 2;

/** Record that an account was deleted, so an in-flight sign-in erases any trust
 *  token file the library writes after the delete. Called by the DELETE route
 *  alongside deleteTrustToken(). */
export function markAccountDeleted(appleId: string): void {
  const now = Date.now();
  for (const [key, at] of recentlyDeletedAppleIds) {
    if (now - at > DELETE_TOMBSTONE_TTL_MS) recentlyDeletedAppleIds.delete(key);
  }
  recentlyDeletedAppleIds.set(appleId.toLowerCase(), now);
}

/** True if the Apple ID was deleted within the tombstone window; a sign-in that
 *  completes after a concurrent delete uses this to refuse to leave its token
 *  file behind. */
function wasDeletedInFlight(appleId: string): boolean {
  const at = recentlyDeletedAppleIds.get(appleId.toLowerCase());
  if (at === undefined) return false;
  return Date.now() - at <= DELETE_TOMBSTONE_TTL_MS;
}

/** Test-only: clear the delete tombstones so one test's delete cannot bleed
 *  into the next (the window is minutes, longer than a test run). */
export function __resetDeleteTombstonesForTest(): void {
  recentlyDeletedAppleIds.clear();
}

/**
 * The live SRP client between `authenticate()` and `provideMfaCode()`.
 *
 * It holds Apple's session secrets in memory and cannot be serialised into
 * SQLite, so the session row records status only. A restart in this window
 * loses the attempt and the administrator clicks sign in again — Apple pushes a
 * fresh code. That is not a per-restart 2FA tax: the steady state is the
 * trusted path below, which never asks for a code at all.
 */
const pending = new Map<string, {
  service: InstanceType<typeof IcloudService>;
  accountId: string;
  appleId: string;
  expiresAt: number;
  /** Set once a code has been requested by SMS, so completion knows which
   *  endpoint verified it — the device and phone paths are different URLs. */
  phoneId?: number;
}>();

/** Beside the SQLite file, so the token follows the data it belongs to. */
function dataDirectory(): string {
  return join(dirname(config.dbPath), 'icloud-auth');
}

/**
 * Where icloudjs looks for an account's trust token.
 *
 * Reproduces `iCloudAuthenticationStore`'s own formula verbatim — base name
 * plus `-` plus base64 of the lowercased account — because the whole point is
 * that the library reads this exact path and nothing else.
 */
export function trustTokenPath(appleId: string): string {
  const base = format({ dir: dataDirectory(), base: '.trust-token' });
  return `${base}-${Buffer.from(appleId.toLowerCase()).toString('base64')}`;
}

/**
 * Hand the stored trust token to the library the only way it accepts one.
 *
 * `authenticate()` calls `authStore.loadTrustToken()` unconditionally, which
 * overwrites whatever is on the object with the contents of this file. Setting
 * `authStore.trustToken` from the database therefore does nothing; the file has
 * to be written first. An empty file is written when no token is stored, so a
 * stale one from a previous account state can never be replayed.
 */
function seedTrustToken(appleId: string, trustToken: string): void {
  mkdirSync(dataDirectory(), { recursive: true });
  writeFileSync(trustTokenPath(appleId), trustToken, 'utf8');
}

/**
 * Erase an account's on-disk trust token.
 *
 * The token is a 2FA-bypass credential: combined with the Apple ID password it
 * signs in silently. Deleting the account row without this would leave it
 * beside the database indefinitely, so account removal must call it. Missing
 * file is success — there is nothing to protect.
 */
export function deleteTrustToken(appleId: string): void {
  rmSync(trustTokenPath(appleId), { force: true });
}

function deleteTrustTokenBestEffort(appleId: string): boolean {
  try {
    deleteTrustToken(appleId);
    return true;
  } catch (e) {
    log.warn('could not erase iCloud trust token after account was deleted mid-flight', {
      appleId,
      error: e,
    });
    return false;
  }
}

interface SrpAccountRow {
  id: string;
  apple_id: string;
  password: string;
  trust_token: string;
}

function loadAccount(accountId: string): SrpAccountRow {
  const account = getRow<SrpAccountRow>(
    getDb(),
    `SELECT id, apple_id, password, trust_token FROM icloud_accounts WHERE id = ?`,
    accountId,
  );
  if (!account) throw new Error(`iCloud account ${accountId} not found`);
  if (!account.apple_id) throw new Error('This iCloud account has no Apple ID saved');
  if (!account.password) {
    throw new Error('No Apple ID password is stored for this account; save one before signing in over SRP');
  }
  return account;
}

/**
 * Keep an Apple hiccup from killing the process.
 *
 * icloudjs starts two async steps without awaiting them — `_getiCloudCookies()`
 * inside `authenticate()`, and `_getTrustToken().then(_getiCloudCookies)`
 * inside `provideMfaCode()` — and rethrows inside both. The failure is reported
 * through `awaitReady` first, which every caller here awaits, but the floating
 * promise then rejects with nobody listening, and Node's default for an
 * unhandled rejection is to terminate. One failed upstream call during an
 * administrator's sign-in must not take the whole service down.
 *
 * The typeof guard means a future rename degrades to the library's own
 * behaviour instead of throwing during construction.
 */
function absorbFloatingRejections(service: object): void {
  const target = service as Record<string, unknown>;
  for (const method of ['_getTrustToken', '_getiCloudCookies']) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function patched(this: unknown, ...args: unknown[]): Promise<unknown> {
      return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args)
        .catch(() => { /* already surfaced on awaitReady */ });
    };
  }
}

function newService(account: SrpAccountRow): InstanceType<typeof IcloudService> {
  seedTrustToken(account.apple_id, account.trust_token);
  const service = new IcloudService({
    // Both are passed here AND to authenticate(): the library reaches for
    // require('keytar') the moment either is missing, and that native module
    // does not load in a container.
    username: account.apple_id,
    password: account.password,
    // Doubles as Apple's `rememberMe` in the sign-in body (icloudjs
    // build/index.js:171): false would ask Apple NOT to remember this session,
    // undermining the trust token this whole flow exists to earn. The keychain
    // write it also enables is wrapped in the library's own try/catch
    // (build/index.js:273), so a container without keytar only logs a warning.
    saveCredentials: true,
    // Without this Apple issues no trust token and every sign-in needs a code.
    trustDevice: true,
    authMethod: 'srp',
    dataDirectory: dataDirectory(),
    logger: (level: number, ...args: unknown[]) => {
      // 2 is the library's Warning level; below that it narrates every state
      // change, which is noise on a path an administrator triggers by hand.
      const detail = args.flatMap((arg) => {
        if (typeof arg === 'string') return [arg];
        // The real library passes the keychain exception as an Error. Inspect
        // only its own message data; never run third-party conversion hooks.
        const message = isNativeError(arg) ? Object.getOwnPropertyDescriptor(arg, 'message')?.value : undefined;
        return typeof message === 'string' ? [message] : [];
      }).join(' ');
      // Explicit credentials keep authentication independent of the host
      // keychain, which is unavailable on the headless Linux deployment.
      const unavailableKeychain = detail.includes('Unable to save account credentials:')
        && detail.includes('libsecret-1.so.0');
      if (level >= 2 && !unavailableKeychain) log.warn('icloudjs', { accountId: account.id, libraryLevel: level });
    },
  });
  absorbFloatingRejections(service);
  return service;
}

/**
 * Persist what the sign-in produced.
 *
 * The cookies feed `IcloudClient` exactly as a pasted header does, so
 * everything downstream of authentication is unchanged by SRP.
 */
/**
 * Bank the trust token the instant Apple issues one.
 *
 * The 2FA code is spent by the time we get here, and the token is what buys
 * the next sign-in a silent 200 instead of another code. Anything that fails
 * afterwards — no cookies came back, the network dropped, the process died —
 * would otherwise throw the token away and put the account straight back on
 * the treadmill this whole mechanism exists to end. Saving it is therefore its
 * own write, before anything that can throw.
 */
function bankTrustToken(accountId: string, service: InstanceType<typeof IcloudService>): void {
  const trustToken = service.authStore?.trustToken ?? '';
  if (!trustToken) return;
  getDb().prepare(
    `UPDATE icloud_accounts SET trust_token = ?, auth_mode = 'srp' WHERE id = ?`,
  ).run(trustToken, accountId);
}

function persistSession(accountId: string, service: InstanceType<typeof IcloudService>): void {
  bankTrustToken(accountId, service);

  const raw = String(service.authStore.getHeaders().Cookie ?? '').trim();
  if (!raw) {
    throw new Error('Apple accepted the sign-in but returned no session cookies');
  }
  // Same bar a pasted cookie has to clear: without both WEBAUTH cookies the
  // session cannot call the HME service, and storing it anyway surfaces an hour
  // later as "session not valid" with nothing pointing back at this sign-in.
  const parsed = parseCookieBlob(raw);
  if (parsed.missing.length) {
    throw new Error(
      `Apple accepted the sign-in but the session is missing ${parsed.missing.join(' and ')}; the account is left unchanged`,
    );
  }
  const trustToken = service.authStore.trustToken ?? '';
  const serviceUrl = service.accountInfo?.webservices?.premiummailsettings?.url ?? '';

  // NULLIF keeps a previously stored value when this sign-in did not produce
  // one: a trusted re-auth returns cookies without minting a new trust token,
  // and blanking the old one would put the account back on the 2FA treadmill.
  //
  // Status moves only from 'degraded' to 'active': a fresh session cures an
  // expired cookie and nothing else. 'error' means the READ half is broken —
  // /test computed that from IMAP, which this sign-in never touched — so
  // writing 'active' here would put an account whose every poll fails back
  // into dispatch. Same guard as the pasted-cookie route.
  getDb().prepare(
    `UPDATE icloud_accounts
        SET auth_mode = 'srp',
            cookies = ?,
            trust_token = COALESCE(NULLIF(?, ''), trust_token),
            hme_service_url = COALESCE(NULLIF(?, ''), hme_service_url),
            last_error = CASE WHEN status = 'degraded' THEN NULL ELSE last_error END,
            status = CASE WHEN status = 'degraded' THEN 'active' ELSE status END,
            last_checked_at = datetime('now')
      WHERE id = ?`,
  ).run(parsed.cookies, trustToken, serviceUrl, accountId);
}

/**
 * Enforce "delete wins" after a sign-in that raced a concurrent account delete.
 *
 * persistSession only writes the DB (a no-op once the row is gone), but the
 * icloudjs library writes a trust-token FILE when awaitReady resolves — which
 * can happen after the delete already erased it. If this Apple ID was deleted
 * while the sign-in was in flight, erase the file the library just wrote so the
 * 2FA-bypass credential does not outlive the account.
 */
function eraseTokenIfDeletedInFlight(appleId: string): void {
  if (!wasDeletedInFlight(appleId)) return;
  if (!deleteTrustTokenBestEffort(appleId)) return;
  log.warn('iCloud sign-in completed for an account deleted mid-flight; erased its trust token', { appleId });
}

function recordSession(sessionId: string, accountId: string, status: string, error?: string): void {
  getDb().prepare(
    `INSERT INTO icloud_auth_sessions (id, account_id, status, error, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))`,
  ).run(sessionId, accountId, status, error ?? null);
}

function updateSession(sessionId: string, status: string, error?: string): void {
  getDb().prepare(
    `UPDATE icloud_auth_sessions
        SET status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(status, error ?? null, sessionId);
}

/** Abandoned attempts would otherwise hold their client object for the process's life. */
function prunePending(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

/**
 * Run the SRP handshake, stopping at the 2FA prompt only if Apple asks for one.
 *
 * With a valid trust token Apple answers 200 instead of 409 and the whole
 * exchange finishes here — that is the renewal path, and it is why a trust
 * token replaces the cookie treadmill rather than merely shortening it.
 */
export async function beginSrpLogin(accountId: string): Promise<{ sessionId: string; needsMfa: boolean }> {
  prunePending();
  const account = loadAccount(accountId);
  const service = newService(account);

  // awaitReady rejects when authentication fails. Attaching a handler up front
  // keeps a failure from surfacing as an unhandled rejection on the MFA path,
  // where nothing awaits it until the code arrives.
  service.awaitReady.catch(() => { /* surfaced by the awaits below */ });

  await service.authenticate(account.apple_id, account.password);

  const sessionId = randomUUID();
  if (String(service.status) === 'MfaRequested') {
    recordSession(sessionId, accountId, 'pending_mfa');
    pending.set(sessionId, { service, accountId, appleId: account.apple_id, expiresAt: Date.now() + SESSION_TTL_MS });
    return { sessionId, needsMfa: true };
  }

  // The cookie jar is fetched without being awaited inside authenticate(), so
  // reading it before awaitReady resolves would find it empty.
  await service.awaitReady;
  persistSession(accountId, service);
  eraseTokenIfDeletedInFlight(account.apple_id);
  recordSession(sessionId, accountId, 'completed');
  log.info('iCloud SRP sign-in renewed without a code', { accountId });
  return { sessionId, needsMfa: false };
}

export async function completeSrpLogin(
  sessionId: string,
  code: string,
  accountId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = getRow<{ account_id: string; status: string; expired: number }>(
    getDb(),
    `SELECT account_id, status,
            CASE WHEN datetime(expires_at) < datetime('now') THEN 1 ELSE 0 END AS expired
       FROM icloud_auth_sessions WHERE id = ?`,
    sessionId,
  );
  if (!session) {
    return { ok: false, error: 'That sign-in session no longer exists; start the sign-in again' };
  }

  // The session is bound to the account that began it. Completing it under
  // another account's URL would persist the result to the wrong place in the
  // caller's eyes — refuse rather than silently write to whichever account the
  // session happens to belong to.
  if (session.account_id !== accountId) {
    return { ok: false, error: 'That sign-in session belongs to a different account' };
  }

  // A completed session has already spent its code and written its result;
  // replaying it must not re-run any of that.
  if (session.status === 'completed') {
    return { ok: false, error: 'That sign-in session is already completed; start a new sign-in if needed' };
  }

  // Expiry is checked before the code is sent on purpose: Apple allows only a
  // handful of attempts per pushed code, so posting one against a dead session
  // would spend an attempt to learn nothing.
  if (session.expired) {
    pending.delete(sessionId);
    updateSession(sessionId, 'failed', 'expired');
    return { ok: false, error: 'That sign-in session has expired; start the sign-in again' };
  }

  const entry = pending.get(sessionId);
  if (!entry) {
    updateSession(sessionId, 'failed', 'lost');
    return {
      ok: false,
      error: 'The sign-in attempt was lost, most likely because the server restarted; start the sign-in again',
    };
  }

  try {
    updateSession(sessionId, 'completing');
    if (entry.phoneId !== undefined) {
      // A code that arrived by SMS is verified at a different endpoint; posting
      // it to the trusted-device one is simply rejected.
      await verifySmsCode(sessionId, entry.phoneId, code);
    } else {
      await entry.service.provideMfaCode(code);
      // The trust token and cookie jar are fetched after provideMfaCode returns.
      await entry.service.awaitReady;
    }
    persistSession(entry.accountId, entry.service);
    eraseTokenIfDeletedInFlight(entry.appleId);
    updateSession(sessionId, 'completed');
    log.info('iCloud SRP sign-in completed', { accountId: entry.accountId });
    return { ok: true };
  } catch (e) {
    // The code has already been consumed at this point, so salvage whatever
    // Apple did hand over. A token banked here saves the operator from being
    // asked for a second code purely because the step after it failed.
    try { bankTrustToken(entry.accountId, entry.service); } catch { /* best effort */ }
    eraseTokenIfDeletedInFlight(entry.appleId);
    const message = errorMessage(e);
    updateSession(sessionId, 'failed', message);
    return { ok: false, error: message };
  } finally {
    pending.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// SMS delivery
//
// icloudjs only implements verify/trusteddevice/securitycode, which pushes the
// code to a signed-in Apple device. That is useless to an operator who has no
// Apple hardware to hand — a perfectly ordinary situation when the Apple ID was
// created from a browser. Apple's own web flow offers the trusted phone
// numbers as an alternative, so those endpoints are called directly here using
// the MFA headers icloudjs already assembled.
// ---------------------------------------------------------------------------

const APPLE_AUTH = 'https://idmsa.apple.com/appleauth/auth';

export interface TrustedPhone {
  id: number;
  /** Masked by Apple, e.g. "+81 ••• ••• ••34" — safe to show. */
  numberWithDialCode: string;
}

interface MfaCapableService {
  authStore: { getMfaHeaders(): Record<string, string> };
}

function mfaHeaders(service: unknown): Record<string, string> {
  return (service as MfaCapableService).authStore.getMfaHeaders();
}

/** The numbers Apple is willing to text, as offered to its own web client. */
export async function listTrustedPhones(sessionId: string): Promise<TrustedPhone[]> {
  const entry = pending.get(sessionId);
  if (!entry) return [];
  try {
    const res = await fetch(APPLE_AUTH, { headers: mfaHeaders(entry.service) });
    if (!res.ok) return [];
    const body = await res.json() as {
      trustedPhoneNumbers?: TrustedPhone[];
      trustedPhoneNumber?: TrustedPhone;
    };
    // Apple returns the list when several are enrolled and a bare object when
    // only one is, so both shapes have to be accepted.
    return body.trustedPhoneNumbers ?? (body.trustedPhoneNumber ? [body.trustedPhoneNumber] : []);
  } catch (e) {
    log.warn('could not read trusted phone numbers', { error: e });
    return [];
  }
}

/** Ask Apple to text the code to one of those numbers. */
export async function sendSmsCode(sessionId: string, phoneId: number): Promise<{ ok: boolean; error?: string }> {
  const entry = pending.get(sessionId);
  if (!entry) return { ok: false, error: 'That sign-in session was lost; start the sign-in again' };
  try {
    const res = await fetch(`${APPLE_AUTH}/verify/phone`, {
      method: 'PUT',
      headers: { ...mfaHeaders(entry.service), 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: { id: phoneId }, mode: 'sms' }),
    });
    if (res.status !== 200 && res.status !== 204) {
      return { ok: false, error: `Apple refused to send the code (HTTP ${res.status})` };
    }
    entry.phoneId = phoneId;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Verify a code that arrived by SMS.
 *
 * The two steps after verification — claiming the trust token and exchanging it
 * for cookies — live on icloudjs as TypeScript-private methods, which erase at
 * runtime. Reaching for them is deliberate and load-bearing: without them the
 * SMS path would verify successfully and then produce no session at all. If a
 * future version renames them this throws loudly rather than silently skipping,
 * which is why the failure is not swallowed.
 */
export async function verifySmsCode(sessionId: string, phoneId: number, code: string): Promise<void> {
  const entry = pending.get(sessionId);
  if (!entry) throw new Error('That sign-in session was lost; start the sign-in again');

  const res = await fetch(`${APPLE_AUTH}/verify/phone/securitycode`, {
    method: 'POST',
    headers: { ...mfaHeaders(entry.service), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phoneNumber: { id: phoneId },
      securityCode: { code },
      mode: 'sms',
    }),
  });

  if (res.status !== 200 && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apple rejected the code (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const svc = entry.service as unknown as {
    _getTrustToken?: () => Promise<void>;
    _getiCloudCookies?: () => Promise<void>;
  };
  if (typeof svc._getTrustToken !== 'function' || typeof svc._getiCloudCookies !== 'function') {
    throw new Error('icloudjs no longer exposes the post-verification steps; the SMS path needs updating');
  }
  await svc._getTrustToken();
  await svc._getiCloudCookies();
}
