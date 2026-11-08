// Account login/registration (2026-11-04) — a third identity layer,
// above the bar identity, following the exact separation principle
// CLAUDE.md already established for bar-vs-room: this module's own
// tables (src/accountsSchema.ts) and session tokens are never merged
// into bar_players/bar_sessions. The only link is `bar_players.account_id`
// (NULL for a guest) and `account_characters` (account_id -> the one bar
// identity it currently controls).
//
// Session delivery: a server-generated random token, written to an
// HttpOnly, Secure (in production), SameSite=Lax cookie — never
// localStorage, never a URL param, per the explicit requirement that
// account auth never travels the same way the existing bar/room/poker/
// domino session_secrets already do (those remain exactly as they are;
// this is a new, separate credential for a new, separate thing). A
// non-production (test/dev) run still sets the cookie but without
// `Secure`, since a plain `http://localhost` request can't carry a
// Secure cookie at all — see src/server.ts's cookie options.
//
// Multi-device policy, the user's own explicit product decision
// (2026-11-04, recorded here and in CLAUDE.md): a NEW login for an
// account immediately invalidates every OTHER account_sessions row for
// that account_id, in the same transaction that creates the new one.
// Multiple tabs in the SAME browser share one cookie, so they share one
// token — never logged out of each other. A second device logging in
// kicks every other device's account session, but the underlying bar
// identity (character, stamina, held items, position) is untouched and
// immediately usable from the new device — see `takeOverCharacter`
// below for how an in-progress game seat specifically is handled.

import type Database from "better-sqlite3";
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { logAction, transact } from "./actionLog.ts";
import * as bar from "./bar.ts";
import { BarError } from "./bar.ts";

export class AccountError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---- Password hashing — scrypt (Node's own built-in, no new dependency),
// N=16384/r=8/p=1 (≈80ms on a shared-cpu-1x Fly machine, measured
// directly — slow enough to meaningfully throttle offline guessing,
// fast enough not to be its own DoS on a 256MB box), 16-byte random salt
// per password, 64-byte derived key. Encoded as one self-describing
// string (`scrypt:N:r:p:saltHex:hashHex`) so a future parameter change
// never breaks verifying an older hash — CLAUDE.md's own "a schema
// change needs a real migration" principle applied to a value, not a
// column: nothing here assumes every stored hash used today's params. ----
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const n = Number(nStr), r = Number(rStr), p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  // Constant-time compare — a password check is exactly the place a
  // timing side-channel would matter, even though nothing else in this
  // codebase's existing session_secret comparisons (bar.ts/rooms.ts) uses
  // one: those compare server-generated random tokens where an attacker
  // gains nothing from timing a byte-by-byte guess (they'd need to guess
  // the whole 24-byte secret regardless of which byte differs first); a
  // password is attacker-chosen and typically low-entropy, so a timing
  // leak on password comparison is a real, practical risk in a way a
  // session-secret comparison isn't.
  return timingSafeEqual(actual, expected);
}

// ---- Username rules: normalized (trimmed, lowercased) for the uniqueness
// check and for login lookup, but the originally-typed casing is what's
// stored and ever displayed back — CLAUDE.md's new account section:
// nicknames stay separate from login usernames and allow reuse; usernames
// do not. ----
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function validateUsername(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 24) {
    throw new AccountError("username must be 3-24 characters", "bad_username", 400);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new AccountError("username may only contain letters, numbers, and underscores", "bad_username", 400);
  }
  return trimmed;
}

// 2026-11-08 (the user's own explicit instruction): a real-time
// availability check as the user types a username, distinct from
// register()'s own throw-on-first-problem validation above. This one
// must never throw for an ordinary "not valid yet" input (a user mid-
// keystroke, or genuinely too short) — the client needs a STATUS to
// show inline, not an HTTP error to catch — so it reuses validateUsername's
// exact same rules via a local try/catch rather than duplicating the
// length/character-class checks, which would risk the two silently
// drifting apart (CLAUDE.md's own long-standing worry about exactly this
// kind of duplication). An empty input is deliberately its own status
// ("empty", never "available" — the user's own explicit requirement that
// an empty field must not claim availability), checked before calling
// validateUsername so a blank field never has to format-reject itself.
export type UsernameAvailability =
  | { status: "available" }
  | { status: "taken" }
  | { status: "invalid"; message: string }
  | { status: "empty" };

export function checkUsernameAvailability(db: Database.Database, usernameInput: string): UsernameAvailability {
  if (usernameInput.trim().length === 0) return { status: "empty" };
  let trimmed: string;
  try {
    trimmed = validateUsername(usernameInput);
  } catch (e) {
    return { status: "invalid", message: e instanceof AccountError ? e.message : "invalid username" };
  }
  const normalized = normalizeUsername(trimmed);
  const existing = db.prepare(`SELECT 1 FROM accounts WHERE username_normalized = ?`).get(normalized);
  return existing ? { status: "taken" } : { status: "available" };
}

function validatePassword(password: string): void {
  // Deliberately permissive on composition (letting a password manager
  // generate/paste anything) and only checks length — CLAUDE.md's own
  // explicit requirement "allow pasting passwords and be compatible with
  // password managers" rules out character-class requirements that often
  // reject generator output or are themselves weaker guidance than
  // length alone.
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw new AccountError("password must be 8-256 characters", "bad_password", 400);
  }
}

// ---- Persisted sliding-window rate limit (src/accountsSchema.ts's
// auth_attempts table) — persisted rather than in-memory specifically
// because this app runs under Fly's auto_stop_machines (CLAUDE.md
// elsewhere): an in-memory limiter resets every time the machine spins
// back up from idle, which an attacker could trivially exploit by
// spacing requests across restarts. Bucketed by a caller-supplied string
// (normalized username for login, a coarse signal for register) rather
// than IP — this app has no reverse-proxy-supplied real IP available
// (Fly terminates TLS in front of it, per fly.toml's own comment) to
// bucket by safely without risking trusting a spoofable header. ----
const AUTH_RATE_LIMIT_COUNT = Number(process.env.AUTH_RATE_LIMIT_COUNT ?? 10);
const AUTH_RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60000);

function checkRateLimit(db: Database.Database, bucket: string): void {
  const now = Date.now();
  const cutoff = now - AUTH_RATE_LIMIT_WINDOW_MS;
  db.prepare(`DELETE FROM auth_attempts WHERE bucket = ? AND at <= ?`).run(bucket, cutoff);
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE bucket = ? AND at > ?`).get(bucket, cutoff) as {
    n: number;
  }).n;
  if (count >= AUTH_RATE_LIMIT_COUNT) {
    throw new AccountError("too many attempts — wait a moment and try again", "rate_limited", 429);
  }
  db.prepare(`INSERT INTO auth_attempts (bucket, at) VALUES (?, ?)`).run(bucket, now);
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Deletes every OTHER account_sessions row for this account — the
 * user's own explicit "new login replaces old" decision — and inserts
 * the new one, all inside the caller's transaction. Returns the new
 * token. Does NOT touch anything about the bar identity/game state this
 * account controls; see `takeOverCharacter` for that, called separately
 * by the login/register routes after this returns. */
function issueSession(db: Database.Database, accountId: string): string {
  const token = newToken();
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM account_sessions WHERE account_id = ?`).run(accountId);
  db.prepare(`INSERT INTO account_sessions (token, account_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)`).run(
    token,
    accountId,
    now,
    now,
  );
  return token;
}

export interface AccountSessionInfo {
  accountId: string;
  username: string;
}

/** Verifies an account session token and returns who it belongs to.
 * Throws `unauthorized` for a missing/invalid/revoked token — the same
 * shape every other requireXSession in this codebase throws, so
 * src/server.ts's existing app.onError handles it without a new case,
 * once AccountError is added to that instanceof list. */
// 30 days — matches the cookie's own maxAge (src/accountRoutes.ts), so a
// session that outlives its cookie never has a chance to be presented
// anyway; this is the server-side enforcement that doesn't depend on
// the browser actually honoring the cookie's expiry. Evaluated lazily on
// every read, the same "now minus last activity, recomputed fresh, no
// sweep" shape this codebase already uses for the lobby disconnect grace
// and every other time-based expiry (CLAUDE.md) — a session simply stops
// verifying once its own window passes, nothing else has to notice or
// clean it up for that to become true.
const ACCOUNT_SESSION_MAX_AGE_MS = Number(process.env.ACCOUNT_SESSION_MAX_AGE_MS ?? 30 * 24 * 60 * 60 * 1000);

export function verifyAccountSession(db: Database.Database, token: string | undefined): AccountSessionInfo {
  if (!token) throw new AccountError("not logged in", "unauthorized", 401);
  const row = db
    .prepare(
      `SELECT s.account_id AS accountId, a.username AS username, s.created_at AS createdAt FROM account_sessions s
       JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`,
    )
    .get(token) as (AccountSessionInfo & { createdAt: string }) | undefined;
  if (!row) throw new AccountError("your session has ended — please log in again", "unauthorized", 401);
  if (Date.now() - new Date(row.createdAt).getTime() > ACCOUNT_SESSION_MAX_AGE_MS) {
    db.prepare(`DELETE FROM account_sessions WHERE token = ?`).run(token);
    throw new AccountError("your session has ended — please log in again", "unauthorized", 401);
  }
  db.prepare(`UPDATE account_sessions SET last_seen_at = ? WHERE token = ?`).run(new Date().toISOString(), token);
  return { accountId: row.accountId, username: row.username };
}

/** The bar identity this account currently controls, or null if it has
 * none yet (a brand-new account that declined guest migration — the
 * caller then creates a fresh one via bar.joinBar + bindCharacter, the
 * same as any other first-time join). */
export function characterFor(db: Database.Database, accountId: string): { barPlayerId: string } | null {
  const row = db.prepare(`SELECT bar_player_id AS barPlayerId FROM account_characters WHERE account_id = ?`).get(
    accountId,
  ) as { barPlayerId: string } | undefined;
  return row ?? null;
}

/** Binds an account to a bar identity — called once, either right after
 * a brand-new account creates its brand-new character, or once at
 * signup-time guest migration. Never called again for the same account
 * afterward (an account keeps the same character for its whole
 * lifetime, by the user's own design: "登录已有账号不得覆盖其角色"). */
function bindCharacter(db: Database.Database, accountId: string, barPlayerId: string): void {
  db.prepare(`INSERT INTO account_characters (account_id, bar_player_id) VALUES (?, ?)`).run(accountId, barPlayerId);
  db.prepare(`UPDATE bar_players SET account_id = ? WHERE id = ?`).run(accountId, barPlayerId);
}

export interface RegisterResult {
  accountId: string;
  username: string;
  token: string;
  barPlayerId: string;
  /** Only present when this registration created a brand-new character
   * (no guest migration) — the caller (src/server.ts) still needs a
   * fresh session_secret, color, and spawn position the same way
   * bar.joinBar already returns them for an ordinary guest join. */
  freshBarSecret: string | null;
  /** This account's first batch of recovery codes, plaintext, shown to
   * the user exactly once — the client's own responsibility to display
   * clearly and never fetch again (there is nothing to fetch; only the
   * hash is ever stored). */
  recoveryCodes: string[];
}

/** Registers a brand-new account. `migrateGuest`, if provided, is the
 * CURRENT browser's own existing bar playerId/sessionSecret — proof the
 * caller actually controls that guest character right now, verified
 * with the exact same requireBarSession check every other bar action
 * already uses, never trusted from an unverified request body alone.
 * Binding is one-time and transactional: a guest character already
 * bound to a different account cannot be claimed again (the UNIQUE
 * constraint on account_characters.bar_player_id enforces this even
 * under a race — two signups racing to claim the same stale guest
 * session can't both win). */
export function register(
  db: Database.Database,
  usernameInput: string,
  password: string,
  migrateGuest: { playerId: string; sessionSecret: string } | null,
): RegisterResult {
  const username = validateUsername(usernameInput);
  validatePassword(password);
  const normalized = normalizeUsername(username);
  // Bucketed by the normalized username being registered, not a single
  // global bucket — this app has no real client IP available to bucket
  // by (Fly terminates TLS in front of it with no forwarded-IP header
  // this codebase already trusts anywhere else), and a single shared
  // "register" bucket would let a handful of signups from anywhere
  // briefly lock out every OTHER legitimate signup too, which is its own
  // denial-of-service. Bucketing by username at least rate-limits
  // repeated attempts to claim one specific name.
  checkRateLimit(db, `register:${normalized}`);

  return transact(db, () => {
    const existing = db.prepare(`SELECT 1 FROM accounts WHERE username_normalized = ?`).get(normalized);
    if (existing) {
      // 2026-11-07 correction (user's own explicit instruction): a
      // registration conflict gets its own distinct, explicit message —
      // "此用户名已被使用" ("this username is already in use") — rather
      // than reusing login's generic wording. This is deliberately a
      // DIFFERENT decision from login's own invalid_credentials below,
      // not an inconsistency: registration time is exactly when a user
      // is actively choosing a name and needs to know unambiguously
      // whether THIS SPECIFIC name is free, which is the entire point of
      // a registration form offering that feedback (every mainstream
      // signup flow does the same) — unlike login, where confirming an
      // account exists before even checking the password would leak
      // information with no corresponding legitimate need from the
      // caller. The code (username_taken, 409) was already distinct from
      // login's (invalid_credentials, 401) before this change; only the
      // wording is sharpened here to say plainly that the name is taken
      // rather than vaguely "unavailable".
      throw new AccountError("this username is already taken", "username_taken", 409);
    }

    if (migrateGuest) {
      // Real proof this browser controls that guest character right now
      // — the SAME check every bar action already runs, not a new or
      // weaker one for this one-time binding.
      bar.requireBarSession(db, migrateGuest.playerId, migrateGuest.sessionSecret);
      const alreadyBound = db.prepare(`SELECT 1 FROM bar_players WHERE id = ? AND account_id IS NOT NULL`).get(
        migrateGuest.playerId,
      );
      if (alreadyBound) {
        throw new AccountError("that character is already linked to another account", "already_linked", 409);
      }
    }

    const accountId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO accounts (id, username, username_normalized, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      accountId,
      username,
      normalized,
      hashPassword(password),
      now,
    );

    let barPlayerId: string;
    let freshBarSecret: string | null;
    if (migrateGuest) {
      barPlayerId = migrateGuest.playerId;
      freshBarSecret = null; // the browser already holds this character's real bar session_secret
      bindCharacter(db, accountId, barPlayerId);
    } else {
      // A brand-new account with no migration starts a brand-new
      // character — the user's own explicit rule: "新注册账号默认创建
      // 新角色", never silently inheriting whatever guest session
      // happens to be sitting in this browser's localStorage.
      //
      // Truncated to bar.ts's own 20-character nickname limit — a real
      // bug caught via actual browser verification at the 390×844
      // viewport: a username up to 24 characters (this module's own
      // limit) passed straight through as the initial nickname used to
      // throw bar.joinBar's unrelated, narrower "nickname must be 1–20
      // characters" error, failing the whole registration for no reason
      // the user could see coming from the signup form itself (which
      // only validates the 24-character username field). The nickname
      // is just a display default here anyway — the character-edit form
      // already lets anyone change it afterward.
      const joined = bar.joinBar(db, username.slice(0, 20), "red", "warm");
      barPlayerId = joined.playerId;
      freshBarSecret = joined.sessionSecret;
      bindCharacter(db, accountId, barPlayerId);
    }

    const token = issueSession(db, accountId);
    const recoveryCodes = generateRecoveryCodes(db, accountId);
    logAction(db, {
      action: "account_register",
      outcome: "ok",
      verified: true,
      actor: { kind: "account", id: accountId, nickname: username },
      detail: { migratedGuest: !!migrateGuest },
    });
    return { accountId, username, token, barPlayerId, freshBarSecret, recoveryCodes };
  });
}

export interface LoginResult {
  accountId: string;
  username: string;
  token: string;
  barPlayerId: string | null;
}

/** Verifies credentials and issues a new session token, revoking every
 * other device's token for this account in the same transaction (the
 * user's own explicit multi-device policy). Does NOT touch game-seat
 * takeover — src/server.ts's login route calls `takeOverCharacter`
 * separately, after this returns, once it has the bar identity's own
 * fresh session_secret ready to report back to the new device. */
export function login(db: Database.Database, usernameInput: string, password: string): LoginResult {
  const normalized = normalizeUsername(usernameInput.trim());
  checkRateLimit(db, `login:${normalized}`);
  const row = db.prepare(`SELECT id, username, password_hash AS passwordHash FROM accounts WHERE username_normalized = ?`).get(
    normalized,
  ) as { id: string; username: string; passwordHash: string } | undefined;
  // Same generic failure for "no such account" and "wrong password" —
  // CLAUDE.md: a login failure must never reveal which one it was.
  if (!row || !verifyPassword(password, row.passwordHash)) {
    throw new AccountError("incorrect username or password", "invalid_credentials", 401);
  }
  return transact(db, () => {
    const token = issueSession(db, row.id);
    const character = characterFor(db, row.id);
    logAction(db, {
      action: "account_login",
      outcome: "ok",
      verified: true,
      actor: { kind: "account", id: row.id, nickname: row.username },
    });
    return { accountId: row.id, username: row.username, token, barPlayerId: character?.barPlayerId ?? null };
  });
}

/** Revokes exactly this one session token. Called both for an explicit
 * logout and (implicitly, via issueSession's own DELETE above) by a new
 * login elsewhere — this function itself is only ever the EXPLICIT path,
 * never called from login's own takeover. */
export function logout(db: Database.Database, token: string | undefined): void {
  if (!token) return;
  const row = db.prepare(`SELECT account_id AS accountId FROM account_sessions WHERE token = ?`).get(token) as
    | { accountId: string }
    | undefined;
  db.prepare(`DELETE FROM account_sessions WHERE token = ?`).run(token);
  if (row) {
    logAction(db, { action: "account_logout", outcome: "ok", verified: true, actor: { kind: "account", id: row.accountId } });
  }
}

// ---- Password recovery — recovery codes (2026-11-04, the user's own
// explicit choice over email+link: this app has no email system at all,
// and codes work completely locally with zero external configuration,
// matching where this project actually is). CLAUDE.md's own standing
// rules this design follows: a recovery credential must be unpredictable
// and the server stores only a secure digest of it (never the plaintext
// code — the identical principle password hashing already establishes,
// just SHA-256 rather than scrypt, since a recovery code is already
// high-entropy server-generated randomness, not a human-chosen low-
// entropy password that needs slow hashing to resist offline guessing);
// a used code is invalidated and a fresh batch is issued; resetting a
// password must never be possible from username/nickname/localStorage
// alone — only a real, currently-valid, unused code proves anything here.
//
// 8 codes per batch (a conventional backup-code count — matches what
// most 2FA recovery-code UIs already show users), each formatted
// XXXX-XXXX from a 32-character unambiguous alphabet (CLAUDE.md's own
// room-code alphabet, reused rather than inventing a second one) — 8
// characters of real entropy per code (40 bits), plenty to resist online
// guessing once also rate-limited below, while still being short enough
// to type by hand if printed out.
const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_COUNT = 8;

function generateOneRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return code;
}

function hashRecoveryCode(code: string): string {
  // Normalized the same way the user will realistically type it back in
  // (uppercased, dash-insensitive) before hashing, so "abcd1234",
  // "ABCD-1234", and "abcd-1234" all hash identically — the dash is a
  // display/typing convenience, never part of the actual secret.
  const normalized = code.toUpperCase().replace(/-/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Replaces this account's entire batch of recovery codes with a fresh
 * one (deleting every existing row first, used or not) and returns the
 * plaintext codes — the ONLY time they ever exist outside a hash,
 * exactly like a password at registration. The caller is responsible
 * for showing these to the user exactly once; nothing here logs or
 * otherwise persists the plaintext anywhere. Called at registration
 * (every new account gets a first batch) and again after a successful
 * reset (the just-used code, and every other old code, must stop working
 * once a new batch exists — CLAUDE.md: "使用后失效并提供新的恢复码"). */
function generateRecoveryCodes(db: Database.Database, accountId: string): string[] {
  db.prepare(`DELETE FROM account_recovery_codes WHERE account_id = ?`).run(accountId);
  const codes: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = generateOneRecoveryCode();
    codes.push(code);
    db.prepare(`INSERT INTO account_recovery_codes (id, account_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)`).run(
      randomUUID(),
      accountId,
      hashRecoveryCode(code),
      now,
    );
  }
  return codes;
}

/** Regenerates this account's own recovery codes, requiring the
 * CURRENT password first (CLAUDE.md: "旧账号补设恢复方式必须验证当前密
 * 码") — used both for an account's first batch being re-rolled on
 * request, and is the same primitive `register` and `resetPassword`
 * below build on. Never callable by anyone who doesn't already hold
 * either the current password or (via `resetPassword`) a currently-valid
 * recovery code — recovery codes can never be bootstrapped from nothing. */
export function regenerateRecoveryCodes(db: Database.Database, accountId: string, currentPassword: string): string[] {
  const row = db.prepare(`SELECT password_hash AS passwordHash FROM accounts WHERE id = ?`).get(accountId) as
    | { passwordHash: string }
    | undefined;
  if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
    throw new AccountError("incorrect password", "invalid_credentials", 401);
  }
  return transact(db, () => {
    const codes = generateRecoveryCodes(db, accountId);
    logAction(db, { action: "account_recovery_codes_regenerated", outcome: "ok", verified: true, actor: { kind: "account", id: accountId } });
    return codes;
  });
}

export interface ResetPasswordResult {
  accountId: string;
  username: string;
  token: string;
  barPlayerId: string | null;
  newRecoveryCodes: string[];
}

/** Resets a forgotten password using one currently-valid, unused
 * recovery code — verified by hash, never by comparing to a stored
 * plaintext (there isn't one). CLAUDE.md's required shape, all inside
 * one transaction:
 * - the code is marked used (and therefore can never be presented
 *   again) the INSTANT it verifies, before the password is even
 *   changed — so a crash between these two steps can never leave the
 *   code both "used" and "didn't actually do anything."
 * - every OTHER account_sessions row is deleted (same as a fresh
 *   `issueSession`), so every old browser tab/device's account cookie
 *   stops working the moment this completes — src/accountRoutes.ts's
 *   route layer separately rotates the bar/room session_secret the
 *   same way `takeOverCharacter`/logout already do, for the identical
 *   "旧的 bar/game session 路径也要检查" reason.
 * - a fresh batch of recovery codes replaces the entire old batch
 *   (including the one just consumed and every other still-unused
 *   one) — CLAUDE.md: "恢复码使用后失效并提供新的恢复码."
 * - the account's own character/stamina/held-items/game data is
 *   completely untouched — this only ever writes `password_hash`,
 *   `account_sessions`, and `account_recovery_codes`, never
 *   `account_characters` or anything in `bar_players`. */
export function resetPasswordWithRecoveryCode(
  db: Database.Database,
  usernameInput: string,
  recoveryCode: string,
  newPassword: string,
): ResetPasswordResult {
  const normalized = normalizeUsername(usernameInput.trim());
  // Bucketed by username, the same reasoning login's own rate limit
  // uses — a recovery code is exactly the kind of credential an
  // attacker would try to brute-force against one specific account.
  checkRateLimit(db, `reset:${normalized}`);
  validatePassword(newPassword);

  const account = db.prepare(`SELECT id, username FROM accounts WHERE username_normalized = ?`).get(normalized) as
    | { id: string; username: string }
    | undefined;
  // Same generic failure whether the account doesn't exist or the code
  // is wrong/already used/expired-by-rotation — CLAUDE.md: "错误反馈不
  // 能泄露账号是否存在."
  const genericFailure = () => new AccountError("that recovery code is invalid or has already been used", "invalid_recovery_code", 401);
  if (!account) throw genericFailure();

  const codeHash = hashRecoveryCode(recoveryCode);
  const codeRow = db
    .prepare(`SELECT id FROM account_recovery_codes WHERE account_id = ? AND code_hash = ? AND used_at IS NULL`)
    .get(account.id, codeHash) as { id: string } | undefined;
  if (!codeRow) throw genericFailure();

  return transact(db, () => {
    // Marked used before anything else — see this function's own header
    // for why the ordering matters.
    db.prepare(`UPDATE account_recovery_codes SET used_at = ? WHERE id = ?`).run(new Date().toISOString(), codeRow.id);
    db.prepare(`UPDATE accounts SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), account.id);
    const token = issueSession(db, account.id);
    const newRecoveryCodes = generateRecoveryCodes(db, account.id);
    const character = characterFor(db, account.id);
    logAction(db, {
      action: "account_password_reset",
      outcome: "ok",
      verified: true,
      actor: { kind: "account", id: account.id, nickname: account.username },
    });
    return {
      accountId: account.id,
      username: account.username,
      token,
      barPlayerId: character?.barPlayerId ?? null,
      newRecoveryCodes,
    };
  });
}

export { BarError };
