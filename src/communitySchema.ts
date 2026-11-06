import type Database from 'better-sqlite3';
export function migrateCommunity(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS community_recipes(
 id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(id),draft TEXT NOT NULL,published TEXT,
 revision INTEGER NOT NULL DEFAULT 1,published_revision INTEGER NOT NULL DEFAULT 0,
 hidden INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,
 search_text TEXT NOT NULL DEFAULT '',ingredient_keys TEXT NOT NULL DEFAULT '[]',alcohol_free INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS community_owner ON community_recipes(owner,deleted);
CREATE TABLE IF NOT EXISTS community_images(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(id),data BLOB NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS community_library(owner TEXT PRIMARY KEY REFERENCES accounts(id),version INTEGER NOT NULL DEFAULT 0,pantry TEXT NOT NULL DEFAULT '[]',imported INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS community_saved(owner TEXT NOT NULL REFERENCES accounts(id),recipe TEXT NOT NULL,PRIMARY KEY(owner,recipe));
CREATE TABLE IF NOT EXISTS community_plan(owner TEXT NOT NULL REFERENCES accounts(id),recipe TEXT NOT NULL,snapshot TEXT NOT NULL,glasses INTEGER NOT NULL,PRIMARY KEY(owner,recipe));
CREATE TABLE IF NOT EXISTS community_reports(recipe TEXT NOT NULL,reporter TEXT NOT NULL REFERENCES accounts(id),reason TEXT NOT NULL,created INTEGER NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(recipe,reporter));
CREATE TABLE IF NOT EXISTS community_limits(owner TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS community_limit_window ON community_limits(owner,kind,at);
CREATE TABLE IF NOT EXISTS community_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL);
`);
    if (!(db.prepare('PRAGMA table_info(community_library)').all() as {
        name: string;
    }[]).some(c => c.name === 'purchased'))
        db.exec("ALTER TABLE community_library ADD COLUMN purchased TEXT NOT NULL DEFAULT '[]'");
}
