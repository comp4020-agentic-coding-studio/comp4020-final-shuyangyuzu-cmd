// Regression test for a real bug found deploying playtest-round-1's
// fixes: `CREATE TABLE IF NOT EXISTS rooms (..., closed_at TEXT, ...)` is
// a no-op against a `rooms` table that already exists on disk — it does
// NOT retroactively add a column a later version introduced. Every local
// test always ran against a freshly-created database (`rm -rf data`
// first), so this never showed up until it hit the real, already-
// deployed Fly volume, where every request touching `closed_at` 500'd.
//
// This test builds exactly that pre-existing-schema database by hand —
// the shape the very first deploy created, before `closed_at` or the
// `presence` table existed — and checks that opening it with the
// current `openDb` migrates it in place rather than erroring.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { BAR_SEATS, GAME_TABLES, defaultSpawn } from "../src/barLayout.ts";
import { joinBar } from "../src/bar.ts";
import { register } from "../src/accounts.ts";

it("repositions occupied chairs with their patron, and moves only floor patrons obstructed by the layout", () => {
  const path = join(dir, "seated-layout.db");
  const db = openDb(path);
  const seated = joinBar(db, "Seated", "red", "warm");
  const walker = joinBar(db, "Walker", "blue", "warm");
  const seat = BAR_SEATS[0], table = GAME_TABLES[0];
  db.prepare("UPDATE bar_seats SET x = ?, y = ?, occupied_by = ? WHERE id = ?").run(seat.x, seat.y + 1, seated.playerId, seat.id);
  db.prepare("UPDATE bar_players SET x = ?, y = ? WHERE id = ?").run(seat.x, seat.y + 1, seated.playerId);
  db.prepare("UPDATE bar_players SET x = ?, y = ? WHERE id = ?").run(table.x, table.y, walker.playerId);
  db.close();
  const migrated = openDb(path);
  try {
    expect(migrated.prepare("SELECT x, y FROM bar_players WHERE id = ?").get(seated.playerId)).toEqual({ x: seat.x, y: seat.y });
    expect(migrated.prepare("SELECT occupied_by FROM bar_seats WHERE id = ?").get(seat.id)).toEqual({ occupied_by: seated.playerId });
    expect(migrated.prepare("SELECT x, y FROM bar_players WHERE id = ?").get(walker.playerId)).toEqual(defaultSpawn());
  } finally { migrated.close(); }
});

let dir: string;

it("adds skin tone to an existing bar database without losing its identity", () => {
  const path = join(dir, "old-bar.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE bar_players (
    id TEXT PRIMARY KEY, nickname TEXT NOT NULL, color TEXT NOT NULL,
    x INTEGER NOT NULL, y INTEGER NOT NULL, current_table_id TEXT,
    current_seat_id TEXT, created_at TEXT NOT NULL);
    INSERT INTO bar_players VALUES ('kept', 'Returning', 'blue', 10, 9, NULL, NULL, '2026-10-05');`);
  old.close();
  const migrated = openDb(path);
  expect(migrated.prepare("SELECT id, nickname, skin FROM bar_players WHERE id = 'kept'").get())
    .toEqual({ id: "kept", nickname: "Returning", skin: "warm" });
  migrated.close();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-migration-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function createPreClosedAtSchema(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      host_player_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE sessions (
      player_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      session_secret TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.close();
}

it("adds closed_at to an already-existing rooms table rather than silently skipping it", () => {
  const path = join(dir, "vegas.db");
  createPreClosedAtSchema(path);

  const db = openDb(path);
  const columns = (db.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(columns).toContain("closed_at");
  db.close();
});

it("creates the presence table against a pre-existing database that never had one", () => {
  const path = join(dir, "vegas.db");
  createPreClosedAtSchema(path);

  const db = openDb(path);
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'presence'`)
    .get();
  expect(table).toBeDefined();
  db.close();
});

it("is idempotent: opening an already-migrated database twice doesn't error", () => {
  const path = join(dir, "vegas.db");
  createPreClosedAtSchema(path);

  openDb(path).close();
  expect(() => openDb(path).close()).not.toThrow();
});

// The bar pivot's own migration — built against *today's actual
// production schema* (rooms with closed_at, presence, sessions, events;
// no bar tables, since the bar is new), not the older pre-closed_at one
// above. New tables only (CREATE TABLE IF NOT EXISTS is genuinely
// sufficient here, unlike the closed_at column), but still verified
// against a real pre-existing database rather than assumed safe.
function createPreBarSchema(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, host_player_id TEXT NOT NULL,
      created_at TEXT NOT NULL, closed_at TEXT, state_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE presence (player_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), last_seen_at TEXT NOT NULL);
    CREATE TABLE sessions (player_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), session_secret TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id), type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  db.close();
}

it("adds the bar's tables against today's real production schema without erroring", () => {
  const path = join(dir, "vegas.db");
  createPreBarSchema(path);

  const db = openDb(path);
  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  for (const table of ["bar_players", "bar_sessions", "bar_presence", "tables"]) {
    expect(names).toContain(table);
  }
  db.close();
});

it("seeds the 9 fixed game tables exactly once, even across repeated opens", () => {
  const path = join(dir, "vegas.db");
  createPreBarSchema(path);

  openDb(path).close();
  const db = openDb(path); // second open must not duplicate the seed
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM tables`).get() as { n: number }).n;
  expect(count).toBe(9);
  db.close();
});

// Phase 2 (product-direction-update): bar_seats/table_departures are
// brand-new tables, so `CREATE TABLE IF NOT EXISTS` is genuinely
// sufficient on its own (unlike the closed_at-column bug above) — still
// verified against a real pre-existing database rather than assumed,
// per this file's own established discipline.
it("adds bar_seats and table_departures to a database that predates them, and seeds every real seat exactly once", () => {
  const path = join(dir, "vegas.db");
  createPreBarSchema(path);

  const db = openDb(path);
  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  expect(names).toContain("bar_seats");
  expect(names).toContain("table_departures");

  const seatCount = (db.prepare(`SELECT COUNT(*) AS n FROM bar_seats`).get() as { n: number }).n;
  expect(seatCount).toBeGreaterThan(0); // 5 stools + 4 per dining table, as of this write-up
  db.close();

  const reopened = openDb(path); // reopening must not duplicate the seed
  const again = (reopened.prepare(`SELECT COUNT(*) AS n FROM bar_seats`).get() as { n: number }).n;
  expect(again).toBe(seatCount);
  reopened.close();
});

// Phase 7 (poker away badge): poker_members already exists on any
// already-deployed volume via migratePoker's own CREATE TABLE IF NOT
// EXISTS — adding `away` to that statement changes only a fresh
// database's shape, exactly the same bug class closed_at's own test
// above guards against, now for a table outside src/db.ts's own
// `migrate` function (pokerSchema.ts's migratePoker, called separately).
it("adds the poker away column to an already-existing poker_members table, preserving existing rows", () => {
  const path = join(dir, "vegas.db");
  const old = new Database(path);
  old.exec(`
    CREATE TABLE poker_rooms(id TEXT PRIMARY KEY,mode TEXT NOT NULL,table_id TEXT NOT NULL,host TEXT NOT NULL,state_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE poker_members(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,seat INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(room_id,bar_id));
    INSERT INTO poker_rooms VALUES('old-room','online','texas-1','old-host','{}',0,0);
    INSERT INTO poker_members VALUES('old-room','old-bar-id',0,1);
  `);
  old.close();

  const migrated = openDb(path);
  try {
    const columns = (migrated.prepare("PRAGMA table_info(poker_members)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("away");
    // The pre-existing row survives the migration, with the new column
    // defaulting to 0 (not away) rather than erroring or being dropped.
    expect(migrated.prepare("SELECT room_id, bar_id, seat, active, away FROM poker_members WHERE bar_id = 'old-bar-id'").get())
      .toEqual({ room_id: "old-room", bar_id: "old-bar-id", seat: 0, active: 1, away: 0 });
  } finally { migrated.close(); }
});

// 2026-11 correction: bar_eating_requests is a brand-new table added
// alongside the pre-existing bar_eating_actions lock, so CREATE TABLE IF
// NOT EXISTS is genuinely sufficient (same reasoning as bar_seats/
// table_departures above) — still verified against a real pre-existing
// database (one that already has bar_eating_actions from the original
// seated-eating round, but predates this round's durable-request table)
// rather than assumed safe, per this file's own established discipline.
function createPreEatingRequestsSchema(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bar_players (
      id TEXT PRIMARY KEY, nickname TEXT NOT NULL, color TEXT NOT NULL, skin TEXT NOT NULL DEFAULT 'warm',
      x INTEGER NOT NULL, y INTEGER NOT NULL, current_table_id TEXT, current_seat_id TEXT, current_game_player_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE bar_eating_actions (
      player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
      kinds TEXT NOT NULL, idempotency_key TEXT, started_at TEXT NOT NULL, ends_at TEXT NOT NULL
    );
    INSERT INTO bar_players VALUES ('old-eater', 'Old Eater', 'red', 'warm', 5, 5, NULL, NULL, NULL, '2026-10-29');
    INSERT INTO bar_eating_actions VALUES ('old-eater', '["drink"]', 'pre-existing-key', '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:08.000Z');
  `);
  db.close();
}

it("adds bar_eating_requests to a database that already has bar_eating_actions, without disturbing the existing lock row", () => {
  const path = join(dir, "vegas.db");
  createPreEatingRequestsSchema(path);

  const db = openDb(path);
  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  expect(names).toContain("bar_eating_requests");

  // The pre-existing lock row from before this round survives untouched.
  const lock = db.prepare(`SELECT kinds, idempotency_key FROM bar_eating_actions WHERE player_id = 'old-eater'`).get();
  expect(lock).toEqual({ kinds: '["drink"]', idempotency_key: "pre-existing-key" });
  db.close();
});

it("preserves a table's current_room_id across a reopen rather than resetting the seed", () => {
  const path = join(dir, "vegas.db");
  createPreBarSchema(path);

  const db1 = openDb(path);
  // tables.current_room_id has a real foreign key into rooms(id)
  // (src/db.ts) — a believable fixture needs an actual room row to
  // point at, the same way Phase 2's real code will always create the
  // room before pointing a table at it.
  db1.prepare(
    `INSERT INTO rooms (id, code, host_player_id, created_at, state_json, version) VALUES (?, ?, ?, ?, ?, 1)`,
  ).run("some-room-id", "AAAAAA", "host-1", new Date().toISOString(), "{}");
  db1.prepare(`UPDATE tables SET current_room_id = ? WHERE id = ?`).run("some-room-id", "vegas-1");
  db1.close();

  const db2 = openDb(path);
  const row = db2.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get("vegas-1") as {
    current_room_id: string | null;
  };
  expect(row.current_room_id).toBe("some-room-id");
  db2.close();
});

// 2026-11-04: accounts (src/accountsSchema.ts) adds bar_players.account_id
// to an already-existing bar_players table, exactly the same migration
// shape as `skin`/`current_game_player_id` above — built against a
// database that predates the accounts feature entirely (has bar_players,
// no account_id column, no accounts/account_sessions/account_characters
// tables at all), per this file's own standing rule that passing the
// rest of the suite proves nothing about this specific failure mode.
function createPreAccountsSchema(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bar_players (
      id TEXT PRIMARY KEY, nickname TEXT NOT NULL, color TEXT NOT NULL, skin TEXT NOT NULL DEFAULT 'warm',
      x INTEGER NOT NULL, y INTEGER NOT NULL, current_table_id TEXT, current_seat_id TEXT, current_game_player_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE bar_sessions (player_id TEXT PRIMARY KEY REFERENCES bar_players(id), session_secret TEXT NOT NULL);
    INSERT INTO bar_players VALUES ('old-guest', 'Old Guest', 'red', 'warm', 5, 5, NULL, NULL, NULL, '2026-10-01');
    INSERT INTO bar_sessions VALUES ('old-guest', 'old-secret');
  `);
  db.close();
}

it("adds bar_players.account_id and the account tables to a database that predates accounts entirely, preserving the existing guest row", () => {
  const path = join(dir, "vegas.db");
  createPreAccountsSchema(path);

  const db = openDb(path);
  try {
    const columns = (db.prepare("PRAGMA table_info(bar_players)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("account_id");
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(names).toContain("accounts");
    expect(names).toContain("account_sessions");
    expect(names).toContain("account_characters");
    expect(names).toContain("account_recovery_codes");

    // The pre-existing guest identity survives untouched, with the new
    // column defaulting to NULL (a guest, not controlled by any account)
    // rather than erroring or being dropped.
    const guest = db.prepare(`SELECT id, nickname, account_id FROM bar_players WHERE id = 'old-guest'`).get();
    expect(guest).toEqual({ id: "old-guest", nickname: "Old Guest", account_id: null });
  } finally {
    db.close();
  }
});

it("opening an accounts-era database twice (idempotent migration) doesn't error and doesn't disturb an already-registered account", () => {
  const path = join(dir, "vegas.db");
  const db1 = openDb(path);
  const result = register(db1, "IdempotentUser", "correct horse battery staple", null);
  db1.close();

  const db2 = openDb(path);
  try {
    const row = db2.prepare(`SELECT username FROM accounts WHERE id = ?`).get(result.accountId) as { username: string };
    expect(row.username).toBe("IdempotentUser");
  } finally {
    db2.close();
  }
});

// 2026-11-04: recovery codes (account_recovery_codes) are a brand-new
// table added inside the SAME migrateAccounts() CREATE TABLE block that
// already created accounts/account_sessions/account_characters in the
// prior round — so the realistic already-deployed scenario this needs
// to survive isn't "no accounts schema at all" (createPreAccountsSchema
// above already covers that), it's specifically "the accounts tables
// from the PRIOR round already exist on disk, recovery codes don't yet."
// Built by hand against that exact prior shape, not assumed safe just
// because CREATE TABLE IF NOT EXISTS usually is.
function createPreRecoveryCodesSchema(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bar_players (
      id TEXT PRIMARY KEY, nickname TEXT NOT NULL, color TEXT NOT NULL, skin TEXT NOT NULL DEFAULT 'warm',
      x INTEGER NOT NULL, y INTEGER NOT NULL, current_table_id TEXT, current_seat_id TEXT, current_game_player_id TEXT,
      account_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE account_sessions (
      token TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE account_characters (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id), bar_player_id TEXT NOT NULL UNIQUE REFERENCES bar_players(id)
    );
    CREATE TABLE auth_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, at INTEGER NOT NULL);
    INSERT INTO bar_players VALUES ('old-account-holder', 'Old Holder', 'blue', 'warm', 7, 7, NULL, NULL, NULL, 'old-account-id', '2026-11-01');
    INSERT INTO accounts VALUES ('old-account-id', 'OldAccountHolder', 'oldaccountholder', 'scrypt:16384:8:1:aa:bb', '2026-11-01');
    INSERT INTO account_characters VALUES ('old-account-id', 'old-account-holder');
  `);
  db.close();
}

it("adds account_recovery_codes to a database with the prior round's own accounts tables already in place, preserving the existing account/character link", () => {
  const path = join(dir, "vegas.db");
  createPreRecoveryCodesSchema(path);

  const db = openDb(path);
  try {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(names).toContain("account_recovery_codes");

    // The pre-existing account/character link from before this round
    // survives untouched.
    const link = db.prepare(`SELECT account_id, bar_player_id FROM account_characters WHERE account_id = 'old-account-id'`).get();
    expect(link).toEqual({ account_id: "old-account-id", bar_player_id: "old-account-holder" });
    const account = db.prepare(`SELECT username FROM accounts WHERE id = 'old-account-id'`).get() as { username: string };
    expect(account.username).toBe("OldAccountHolder");
  } finally {
    db.close();
  }
});
