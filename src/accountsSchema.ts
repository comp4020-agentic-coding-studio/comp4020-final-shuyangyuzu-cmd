import type Database from "better-sqlite3";
import { addColumnIfMissing } from "./db.ts";

/** Account tables (2026-11-04). Separate from bar_players/bar_sessions
 * exactly the way the bar identity layer is already kept separate from a
 * game room's own player/session tables (CLAUDE.md: "The bar is a
 * separate identity layer, never merged with a game room's") — an
 * account is a THIRD layer, on top of the bar identity, not a merge of
 * anything that already exists. `bar_players.account_id` (added below)
 * is the only link: which bar identity (nickname, color, skin, position,
 * stamina, held items — everything already in that table) a given
 * logged-in account is currently controlling. A guest bar identity has
 * `account_id IS NULL` and is completely unaffected by any of this.
 *
 * `accounts`: one row per registered user. `username_normalized` (lower-
 * cased, trimmed) carries the UNIQUE constraint — concurrent registration
 * races are resolved by the database itself, not by a check-then-insert
 * race in application code. `password_hash` is a full scrypt-encoded
 * string (algorithm/params/salt/hash together, see src/accounts.ts's
 * hashPassword) — never a bare hash with parameters assumed elsewhere.
 *
 * `account_sessions`: a server-generated random session token, delivered
 * only via an HttpOnly cookie in production (never localStorage, never a
 * URL) — see src/accounts.ts. One row per currently-valid login. A new
 * login for the same account deletes every other row for that account_id
 * in the same transaction that inserts the new one (the user's own
 * explicit "new login replaces old" decision) rather than allowing many
 * concurrent valid tokens per account.
 */
export function migrateAccounts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions(account_id);

    -- One row per account, naming which bar identity it currently
    -- controls (mirrors bar_players.account_id below; kept as its own
    -- table rather than only a column on bar_players so "does this
    -- account already have a character" is a single indexed lookup by
    -- account_id without scanning bar_players).
    CREATE TABLE IF NOT EXISTS account_characters (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      bar_player_id TEXT NOT NULL UNIQUE REFERENCES bar_players(id)
    );

    -- Rate limiting for login/register attempts, persisted (not just
    -- in-memory) so a restart doesn't reset an attacker's budget — this
    -- table is small and short-lived by construction (rows older than
    -- the window are irrelevant and pruned opportunistically), unlike
    -- e.g. bar_speech's in-memory-only rate limit, because auth attempts
    -- specifically need to survive the Fly auto-stop/restart cycle this
    -- app already lives under.
    CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_attempts_bucket_idx ON auth_attempts(bucket, at);
  `);
  // bar_players already exists on any already-deployed volume (CLAUDE.md's
  // migration rule) — addColumnIfMissing, not a wider CREATE TABLE.
  // NULL means "a guest, not controlled by any account" — the default
  // for every row that existed before this feature, and for every new
  // guest join from now on.
  addColumnIfMissing(db, "bar_players", "account_id", "TEXT");
}
