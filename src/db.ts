// Persistence to a single SQLite file under the Fly volume at /data (see
// fly.toml) — the only storage that survives a restart or redeploy, and
// the whole reason a room's state can be resumed after a player leaves
// and comes back.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { installTransactionLogging } from "./actionLog.ts";
import { migratePoker } from './pokerSchema.ts';
import { findFreeTile } from "./bar.ts";
import { BAR_SEATS, GAME_TABLES, defaultSpawn, isWalkingFloor } from "./barLayout.ts";
import { initStamina } from "./stamina.ts";
import type { RoomState } from "./types.ts";

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Patches db.transaction itself so every transaction on this
  // connection — however it's invoked — gets rollback-safe action
  // logging automatically (src/actionLog.ts's own header explains why
  // this can't just rely on every call site remembering to opt in).
  // Installed before migrate/seed below run any transactions of their
  // own, and before this db is handed back to any caller.
  installTransactionLogging(db);
  migrate(db);
  migratePoker(db);
  seedBarFurniture(db);
  seedBarSeats(db);
  // Any bar identity that existed before this feature shipped needs its
  // own stamina row backfilled — joinBar is the only other writer of a
  // first row, and an identity that joined before bar_stamina existed
  // never went through it. initStamina is itself a no-op (ON CONFLICT DO
  // NOTHING) for any identity that already has one, so this is safe to
  // run on every startup, not just the first one after this feature's
  // own deploy.
  for (const p of db.prepare("SELECT id FROM bar_players").all() as Array<{ id: string }>) {
    initStamina(db, p.id);
  }
  // Furniture can move on deploy. Keep seated patrons on their updated
  // chair (seedBarSeats above); relocate only obstructed floor positions
  // — each one to its own free tile (product-direction-update: a layout
  // migration must not strand two migrated patrons on the identical
  // tile), found fresh per player so an earlier relocation in this same
  // loop is already visible to a later one's own search.
  for (const p of db.prepare("SELECT id, x, y FROM bar_players").all() as Array<{ id: string; x: number; y: number }>) {
    const seated = db.prepare("SELECT 1 FROM bar_seats WHERE occupied_by = ? AND x = ? AND y = ?").get(p.id, p.x, p.y);
    if (!seated && !isWalkingFloor(p.x, p.y)) {
      const free = findFreeTile(db, defaultSpawn(), p.id);
      db.prepare("UPDATE bar_players SET x = ?, y = ? WHERE id = ?").run(free.x, free.y, p.id);
    }
  }
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

    -- Proximity-triggered 1:1 chat (product-direction-update, part 3).
    -- SUPERSEDED as the client-facing feature by public speech bubbles
    -- below, after the student's own acceptance testing (CLAUDE.md's
    -- "Public tavern speech..." section has the full story) — kept here,
    -- schema and server routes both, purely to preserve existing private
    -- records under their original access control; the client no longer
    -- creates or reads through this table at all. One thread per
    -- unordered pair of bar identities — id is the two player ids sorted
    -- and joined, so "does this pair already have a thread" is a plain
    -- primary-key lookup regardless of who initiates. Never merged with,
    -- or readable through, the public bar/room SSE channels (CLAUDE.md) —
    -- a message is only ever delivered to its two participants, over
    -- their own authenticated channel (src/live.ts).
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      player_a TEXT NOT NULL REFERENCES bar_players(id),
      player_b TEXT NOT NULL REFERENCES bar_players(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id),
      sender_id TEXT NOT NULL REFERENCES bar_players(id),
      client_msg_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- A sender's retried send (a doubled click, a retry after a dropped
    -- response) carries the same client_msg_id — this is what makes a
    -- second INSERT attempt for the identical logical message detectable
    -- as a duplicate rather than a second real message (src/chat.ts
    -- checks for this row before ever inserting, so this index is a
    -- backstop, not the only thing idempotency depends on).
    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_dedup ON chat_messages(thread_id, sender_id, client_msg_id);
    CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(thread_id, id);

    -- Public tavern speech (product-direction-update, part 3 replacement,
    -- 2026-10-12): one active "bubble" per bar identity, never a message
    -- log — the previous line a patron said is simply gone once a new
    -- one replaces it or it expires, so one row per player (not an
    -- append-only table like chat_messages above) is the correct shape.
    -- expires_at is an absolute timestamp set once at send time, which is
    -- what lets a reconnect or a plain poll show the *remaining* display
    -- window rather than restarting it (src/bar.ts's getPublicBarState
    -- filters by it lazily, the same "evaluated fresh on every read"
    -- principle as the lobby disconnect grace — no sweep, no timer).
    CREATE TABLE IF NOT EXISTS bar_speech (
      player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
      text TEXT NOT NULL,
      client_msg_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_departures (
      player_id TEXT PRIMARY KEY REFERENCES sessions(player_id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      left_at TEXT NOT NULL
    );

    -- Phone-style room voice calls (src/voice.ts). Brand-new tables, so
    -- CREATE TABLE IF NOT EXISTS is genuinely sufficient here (CLAUDE.md's
    -- migration section only requires addColumnIfMissing for a column
    -- added to a table that already exists in production).
    --
    -- Exactly one active call per room at a time, enforced by the UNIQUE
    -- constraint on room_code: two simultaneous "start call" requests race
    -- an INSERT OR IGNORE against this constraint, so whichever commits
    -- first wins and the loser's own request transparently joins the
    -- winner's row instead of creating a second, parallel call (the
    -- "merge" requirement) — no application-level locking needed, the
    -- same reasoning every other single-writer-process race in this
    -- codebase already relies on (src/rooms.ts's own header comment).
    -- room_code, not room_id: src/voice.ts deliberately never reads the
    -- rooms table directly — every check it needs (seated, human,
    -- online-not-solo, connected) already comes back from
    -- rooms.getPublicState, so keying off the public code keeps this
    -- module a one-directional consumer of rooms.ts, never the reverse
    -- (the same layering tables.ts/chat.ts already use against
    -- rooms.ts/bar.ts).
    CREATE TABLE IF NOT EXISTS room_voice_calls (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL UNIQUE,
      started_by TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    -- status is 'invited' or 'joined' only — a decline or a hangup simply
    -- DELETEs the row rather than keeping a third status value, which is
    -- what makes "don't re-invite a decliner for the rest of this same
    -- call, but do invite them again for a genuinely new one" fall out
    -- for free: there's nothing left recording the old decline once the
    -- call that held it is gone.
    CREATE TABLE IF NOT EXISTS room_voice_participants (
      call_id TEXT NOT NULL REFERENCES room_voice_calls(id),
      player_id TEXT NOT NULL,
      status TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      invited_at TEXT NOT NULL,
      joined_at TEXT,
      PRIMARY KEY (call_id, player_id)
    );

    -- Server-computed, lazily-recomputed stamina (src/stamina.ts) — a
    -- frequently-changing numeric stat, deliberately its own table rather
    -- than a bar_players column, for the same reason bar_presence and
    -- table_departures already are: it has no business inside a row that
    -- otherwise holds only permanent profile fields. One row per bar
    -- identity (never per-tab, which is what makes "several tabs, one
    -- stamina" true for free). online_since is null while this identity
    -- currently has no live presence; see stamina.ts's own header for the
    -- full recompute contract.
    CREATE TABLE IF NOT EXISTS bar_stamina (
      player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
      value REAL NOT NULL,
      last_computed_at TEXT NOT NULL,
      online_since TEXT
    );

    -- Front-of-house menu consumption (src/orders.ts). Replaces the
    -- earlier single-active-order design (see src/orders.ts's own header
    -- for why): a patron may hold one meal and one drink at a time, each
    -- its own row, each consumed independently and exactly once.
    CREATE TABLE IF NOT EXISTS held_items (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES bar_players(id),
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      variant TEXT,
      state TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    -- At most one HELD row per (player, kind) at a time — the same
    -- partial-unique-index backstop poker_members.poker_one_seat already
    -- uses for an identical "one active X per Y" rule. The real check
    -- still happens inside the same transaction as the insert (src/
    -- orders.ts), same as everywhere else in this codebase; this index
    -- is the backstop against a race the application check alone can't
    -- rule out.
    CREATE UNIQUE INDEX IF NOT EXISTS held_items_one_per_kind ON held_items(player_id, kind) WHERE state = 'held';
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
  migrateRoomState(db);
}

/** Columns and JSON payloads both survive deployments. Rooms created
 * before approval/NPC support lack these fields, including closed rooms
 * that returning identities still resolve. Add only missing defaults;
 * preserve game progress, sessions, events, and action versions. */
function migrateRoomState(db: Database.Database): void {
  db.transaction(() => {
    const rows = db.prepare("SELECT id, state_json FROM rooms").all() as Array<{ id: string; state_json: string }>;
    const update = db.prepare("UPDATE rooms SET state_json = ? WHERE id = ?");
    for (const row of rows) {
      const state: RoomState = JSON.parse(row.state_json);
      let changed = false;
      if(state.round==null){state.round=state.phase==='lobby'?0:1;changed=true;}
      if(state.startingPlayerId===undefined){state.startingPlayerId=state.turnOrder?.[0]??null;changed=true;}
      if(state.winnerIds==null){state.winnerIds=[];changed=true;}
      if (state.pendingRequests == null) {
        state.pendingRequests = [];
        changed = true;
      }
      for (const player of Object.values(state.players ?? {})) {
        if (player.controller == null) {
          player.controller = "human";
          changed = true;
        }
      }
      if (changed) update.run(JSON.stringify(state), row.id);
    }
  })();
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
    // A layout change moves an occupied chair and its patron together.
    db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = (SELECT occupied_by FROM bar_seats WHERE id = ?)`).run(s.x, s.y, s.id);
  }
}

export function addColumnIfMissing(db: Database.Database, table: string, column: string, type: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function dbPathFromEnv(): string {
  const dir = process.env.DATA_DIR ?? "./data";
  return `${dir}/vegas.db`;
}
