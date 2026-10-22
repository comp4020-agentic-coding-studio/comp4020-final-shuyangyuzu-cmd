import type Database from "better-sqlite3";
export function migratePoker(db:Database.Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS poker_rooms(id TEXT PRIMARY KEY,mode TEXT NOT NULL,table_id TEXT NOT NULL,host TEXT NOT NULL,state_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS poker_shared_table ON poker_rooms(table_id) WHERE mode='online' AND closed=0;
    CREATE TABLE IF NOT EXISTS poker_members(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,seat INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(room_id,bar_id));
    CREATE UNIQUE INDEX IF NOT EXISTS poker_one_seat ON poker_members(bar_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS poker_wallets(room_id TEXT NOT NULL,bar_id TEXT NOT NULL,stack INTEGER NOT NULL,PRIMARY KEY(room_id,bar_id));
    CREATE TABLE IF NOT EXISTS poker_presence(bar_id TEXT PRIMARY KEY,seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS poker_invites(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,sender TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS poker_events(id INTEGER PRIMARY KEY,room_id TEXT NOT NULL,version INTEGER NOT NULL,actor TEXT,action TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS poker_notices(bar_id TEXT PRIMARY KEY,notice_id TEXT NOT NULL,room_id TEXT NOT NULL,hand INTEGER NOT NULL,result TEXT NOT NULL);`);
}
