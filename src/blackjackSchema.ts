import type Database from 'better-sqlite3';
export function migrateBlackjack(db:Database.Database):void {db.exec(`
CREATE TABLE IF NOT EXISTS blackjack_rooms(id TEXT PRIMARY KEY,host TEXT NOT NULL,state_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS blackjack_one_online ON blackjack_rooms(closed) WHERE closed=0;
CREATE TABLE IF NOT EXISTS blackjack_members(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,seat INTEGER NOT NULL,seen INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(room_id,bar_id));
CREATE UNIQUE INDEX IF NOT EXISTS blackjack_one_player ON blackjack_members(bar_id) WHERE active=1;
CREATE UNIQUE INDEX IF NOT EXISTS blackjack_one_seat ON blackjack_members(room_id,seat) WHERE active=1;
CREATE TABLE IF NOT EXISTS blackjack_notices(bar_id TEXT PRIMARY KEY,message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blackjack_wallets(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,stack INTEGER NOT NULL,PRIMARY KEY(room_id,bar_id));
`);}
