// Persistence to a single SQLite file under the Fly volume at /data (see
// fly.toml) — the only storage that survives a restart or redeploy, and
// the whole reason a room's state can be resumed after a player leaves
// and comes back.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BAR_SEATS, GAME_TABLES } from "./barLayout.ts";

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seedBarFurniture(db);
  seedBarSeats(db);
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

    -- The bar: a separate identity layer from a game room's, on purpose
    -- (CLAUDE.md) — none of the tables above are touched by any of this.
    CREATE TABLE IF NOT EXISTS bar_players (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      color TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      current_table_id TEXT,
      current_seat_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bar_sessions (
      player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
      session_secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bar_presence (
      player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
      last_seen_at TEXT NOT NULL
    );

    -- Fixed furniture (src/barLayout.ts), seeded below — never created or
    -- deleted outside that seed (CLAUDE.md). current_room_id is Phase 2;
    -- left NULL and unused until then.
    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      game_type TEXT NOT NULL,
      available INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      current_room_id TEXT REFERENCES rooms(id)
    );

    -- Phase 2 (product-direction-update, PLAN.md): real dining/stool
    -- seats, fixed furniture seeded once below, same pattern as the
    -- tables table above. A game table's own 4 chairs are NOT rows here
    -- -- sitting there is already being seat-index 0-3 in that room's
    -- own player roster (src/tables.ts), not a new occupancy concept.
    CREATE TABLE IF NOT EXISTS bar_seats (
      id TEXT PRIMARY KEY,
      furniture_id TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      occupied_by TEXT REFERENCES bar_players(id)
    );

    -- The 2-minute away-from-table clock (CLAUDE.md's leave/exit states).
    -- One row per bar identity currently away from a table binding it
    -- still holds — separate from bar_presence (heartbeat) and from
    -- rooms.state_json (a frequently-changing clock doesn't belong in the
    -- versioned game blob any more than a heartbeat does).
    CREATE TABLE IF NOT EXISTS table_departures (
      bar_player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
      table_id TEXT NOT NULL,
      left_at TEXT NOT NULL
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
  addColumnIfMissing(db, "bar_players", "skin", "TEXT NOT NULL DEFAULT 'warm'");
  // Phase 2: the only link between a bar identity and which game-room
  // player row they became when they sat at a table — what makes "one
  // table at a time" actually checkable server-side (src/tables.ts).
  addColumnIfMissing(db, "bar_players", "current_game_player_id", "TEXT");
}

/** The 6 game-table slots are fixed furniture (src/barLayout.ts) —
 * seeded once, idempotently, and never touched again by anything except
 * Phase 2's current_room_id updates. INSERT OR IGNORE rather than
 * upsert: a table that already exists keeps whatever current_room_id
 * it's accumulated, not reset to the seed's NULL on every restart. */
function seedBarFurniture(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tables (id, game_type, available, x, y, current_room_id)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  );
  for (const t of GAME_TABLES) {
    insert.run(t.id, t.gameType, t.available ? 1 : 0, t.x, t.y);
    // Layout revisions move fixtures without resetting their game pointer.
    db.prepare(`UPDATE tables SET x = ?, y = ? WHERE id = ?`).run(t.x, t.y, t.id);
  }
}

/** Phase 2: dining/stool seats, same idempotent-seed-plus-reposition
 * pattern as seedBarFurniture above, and for the same reason — a seat
 * that already exists keeps whatever `occupied_by` it's accumulated, not
 * reset to the seed's NULL on every restart. */
function seedBarSeats(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO bar_seats (id, furniture_id, x, y, occupied_by) VALUES (?, ?, ?, ?, NULL)`,
  );
  for (const s of BAR_SEATS) {
    insert.run(s.id, s.furnitureId, s.x, s.y);
    db.prepare(`UPDATE bar_seats SET x = ?, y = ?, furniture_id = ? WHERE id = ?`).run(s.x, s.y, s.furnitureId, s.id);
  }
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
