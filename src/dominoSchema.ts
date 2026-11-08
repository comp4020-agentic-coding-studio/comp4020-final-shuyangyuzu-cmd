import type Database from 'better-sqlite3';
import { addColumnIfMissing } from './db.ts';
export function migrateDomino(db:Database.Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS domino_rooms (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, lane INTEGER NOT NULL, host TEXT NOT NULL,
    state_json TEXT, version INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS domino_online_lane ON domino_rooms(lane) WHERE mode='online' AND closed=0;
    CREATE TABLE IF NOT EXISTS domino_members(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,seat INTEGER NOT NULL,seen INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(room_id,bar_id));
    CREATE UNIQUE INDEX IF NOT EXISTS domino_one_membership ON domino_members(bar_id) WHERE active=1;
    CREATE UNIQUE INDEX IF NOT EXISTS domino_one_chair ON domino_members(room_id,seat) WHERE active=1;
    CREATE TABLE IF NOT EXISTS domino_requests(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(room_id,bar_id));
    CREATE TABLE IF NOT EXISTS domino_waitlist(lane INTEGER NOT NULL,bar_id TEXT NOT NULL,created INTEGER NOT NULL,notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(lane,bar_id));`);
  // 2026-11-07: dominoes dropped its host-approval step (domino_requests
  // is no longer written to, but is left in place rather than dropped —
  // CLAUDE.md's "a schema change needs a real migration" cuts both ways,
  // and an unused table costs nothing to leave behind on an already-
  // deployed volume) and gained a per-lane waitlist instead
  // (domino_waitlist, a genuinely new table — CREATE TABLE IF NOT EXISTS
  // alone is correct here since it's new, not a column added to an
  // existing table).
  //
  // 2026-11-08: a genuine column addition on an already-existing table —
  // domino_members already exists on any deployed volume via its own
  // CREATE TABLE IF NOT EXISTS above, so this needs addColumnIfMissing
  // (CLAUDE.md's migration rule), not a wider CREATE TABLE. Mirrors
  // poker_members.away exactly: a display-only away flag, independent of
  // the lock/seat-occupancy logic.
  addColumnIfMissing(db,'domino_members','away','INTEGER NOT NULL DEFAULT 0');
}
