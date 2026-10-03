// Persistence to a single SQLite file under the Fly volume at /data (see
// fly.toml) — the only storage that survives a restart or redeploy, and
// the whole reason a room's state can be resumed after a player leaves
// and comes back.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      host_player_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    -- Heartbeat presence, deliberately NOT part of the versioned
    -- rooms.state_json blob — see src/presence.ts for why.
    CREATE TABLE IF NOT EXISTS presence (
      player_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      last_seen_at TEXT NOT NULL
    );

    -- Identity proof for a returning player. Deliberately never joined
    -- into any query that builds a public response (see toPublicState in
    -- rooms.ts) — CLAUDE.md: session_secret must never leave the server.
    CREATE TABLE IF NOT EXISTS sessions (
      player_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      session_secret TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Added after the first deploy. "CREATE TABLE IF NOT EXISTS" above is a
  // no-op against a `rooms` table that already exists on disk — it does
  // NOT retroactively add a column a later version introduced. Caught
  // this the hard way: it worked against every fresh local database
  // (always created from nothing) and broke only against the real,
  // already-deployed Fly volume. addColumnIfMissing is the general fix —
  // every future new column goes through it, not a bare ALTER TABLE.
  addColumnIfMissing(db, "rooms", "closed_at", "TEXT");
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, type: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function dbPathFromEnv(): string {
  const dir = process.env.DATA_DIR ?? "./data";
  return `${dir}/vegas.db`;
}
