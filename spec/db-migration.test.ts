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

it("seeds the 6 fixed game tables exactly once, even across repeated opens", () => {
  const path = join(dir, "vegas.db");
  createPreBarSchema(path);

  openDb(path).close();
  const db = openDb(path); // second open must not duplicate the seed
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM tables`).get() as { n: number }).n;
  expect(count).toBe(6);
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
