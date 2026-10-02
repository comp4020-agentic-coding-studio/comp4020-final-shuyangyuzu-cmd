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
}

export function dbPathFromEnv(): string {
  const dir = process.env.DATA_DIR ?? "./data";
  return `${dir}/vegas.db`;
}
