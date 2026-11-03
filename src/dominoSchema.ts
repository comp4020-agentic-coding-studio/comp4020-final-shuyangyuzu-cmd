import type Database from 'better-sqlite3';
export function migrateDomino(db:Database.Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS domino_rooms (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, lane INTEGER NOT NULL, host TEXT NOT NULL,
    state_json TEXT, version INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS domino_online_lane ON domino_rooms(lane) WHERE mode='online' AND closed=0;
    CREATE TABLE IF NOT EXISTS domino_members(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,seat INTEGER NOT NULL,seen INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(room_id,bar_id));
    CREATE UNIQUE INDEX IF NOT EXISTS domino_one_membership ON domino_members(bar_id) WHERE active=1;
    CREATE UNIQUE INDEX IF NOT EXISTS domino_one_chair ON domino_members(room_id,seat) WHERE active=1;
    CREATE TABLE IF NOT EXISTS domino_requests(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(room_id,bar_id));`);
}
