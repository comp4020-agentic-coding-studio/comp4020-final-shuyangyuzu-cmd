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
