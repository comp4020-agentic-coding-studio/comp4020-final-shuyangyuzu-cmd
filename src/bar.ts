// The bar: a separate identity layer from a game room's (CLAUDE.md) —
// its own tables, its own session secrets, its own presence. Phase 1
// scope only: join/rejoin, heartbeat, grid-tile movement (server-
// validated against src/barLayout.ts), and a public snapshot for
// rendering. Table click-to-join/create (Phase 2), ordering (Phase 3),
// and seating (Phase 4) are deliberately not here yet.

import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { defaultSpawn, FURNITURE, isValidStep } from "./barLayout.ts";
import { isConnected } from "./presence.ts";

// A separate, larger palette from the Vegas table's 4 (PLAN.md decision:
// the bar isn't capped at 4 patrons). Keep in sync with public/app.js's
// BAR_COLORS — there's no shared module between server and this plain-JS
// client to enforce that automatically, so spec/bar.test.ts exercises
// every one of these against the real endpoint to catch drift.
export const BAR_COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"] as const;
export type BarColor = (typeof BAR_COLORS)[number];

// Separate presence storage from the game-room `presence` table on
// purpose: that table's room_id column has a real foreign key into
// `rooms`, so a bar identity (which isn't a room player) can't share it
// without either violating that constraint or weakening it for
// everyone. `isConnected` (the pure time-comparison) is still reused —
// it has no table coupling at all.

function recordBarHeartbeat(db: Database.Database, playerId: string, now = new Date()): void {
  db.prepare(
    `INSERT INTO bar_presence (player_id, last_seen_at) VALUES (?, ?)
     ON CONFLICT(player_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(playerId, now.toISOString());
}

function barLastSeenTimes(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`SELECT player_id, last_seen_at FROM bar_presence`).all() as Array<{
    player_id: string;
    last_seen_at: string;
  }>;
  return new Map(rows.map((r) => [r.player_id, r.last_seen_at]));
}

export class BarError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function newSessionSecret(): string {
  return randomBytes(24).toString("base64url");
}

export interface JoinedBar {
  playerId: string;
  sessionSecret: string;
  x: number;
  y: number;
}

export const BAR_SKINS = ["fair", "warm", "tan", "brown", "deep"] as const;
export function joinBar(db: Database.Database, nickname: string, color: BarColor, skin = "warm"): JoinedBar {
  const trimmed = nickname.trim();
  if (!trimmed) throw new BarError("nickname is required", "nickname_required", 400);
  if (!BAR_COLORS.includes(color)) throw new BarError("not a valid color", "bad_color", 400);
  if (!BAR_SKINS.includes(skin as typeof BAR_SKINS[number])) throw new BarError("not a valid skin tone", "bad_skin", 400);

  const id = randomUUID();
  const sessionSecret = newSessionSecret();
  const now = new Date().toISOString();
  const { x, y } = defaultSpawn();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO bar_players (id, nickname, color, skin, x, y, current_table_id, current_seat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(id, trimmed, color, skin, x, y, now);
    db.prepare(`INSERT INTO bar_sessions (player_id, session_secret) VALUES (?, ?)`).run(id, sessionSecret);
    recordBarHeartbeat(db, id, new Date(now));
  });
  tx();

  return { playerId: id, sessionSecret, x, y };
}

// Exported for src/tables.ts — table creation/joining acts on behalf of
// a bar identity, so it needs the same proof-of-identity check every
// other bar action already uses, not a copy of it.
export function requireBarSession(db: Database.Database, playerId: string, sessionSecret: string): void {
  const row = db.prepare(`SELECT session_secret FROM bar_sessions WHERE player_id = ?`).get(playerId) as
    | { session_secret: string }
    | undefined;
  if (!row || row.session_secret !== sessionSecret) {
    throw new BarError("not authorized for this bar identity", "unauthorized", 403);
  }
}

export function rejoinBar(db: Database.Database, playerId: string, sessionSecret: string): void {
  requireBarSession(db, playerId, sessionSecret);
  recordBarHeartbeat(db, playerId);
}

export function updateAppearance(db: Database.Database, playerId: string, sessionSecret: string, nickname: string, color: BarColor, skin: string): void {
  requireBarSession(db, playerId, sessionSecret);
  if (!nickname.trim() || nickname.trim().length > 20) throw new BarError("nickname must be 1–20 characters", "nickname_required", 400);
  if (!BAR_COLORS.includes(color)) throw new BarError("not a valid color", "bad_color", 400);
  if (!BAR_SKINS.includes(skin as typeof BAR_SKINS[number])) throw new BarError("not a valid skin tone", "bad_skin", 400);
  db.prepare("UPDATE bar_players SET nickname = ?, color = ?, skin = ? WHERE id = ?").run(nickname.trim(), color, skin, playerId);
  recordBarHeartbeat(db, playerId);
}

export function barHeartbeat(db: Database.Database, playerId: string, sessionSecret: string): void {
  requireBarSession(db, playerId, sessionSecret);
  recordBarHeartbeat(db, playerId);
}

export function moveBar(db: Database.Database, playerId: string, sessionSecret: string, x: number, y: number): void {
  requireBarSession(db, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT x, y FROM bar_players WHERE id = ?`).get(playerId) as
      | { x: number; y: number }
      | undefined;
    if (!row) throw new BarError("no such bar identity", "player_not_found", 404);
    if (!isValidStep(row.x, row.y, x, y)) {
      throw new BarError("not a valid move from your current tile", "invalid_move", 409);
    }
    db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(x, y, playerId);
  });
  tx();
  recordBarHeartbeat(db, playerId);
}

export interface PublicBarPlayer {
  id: string;
  nickname: string;
  color: string;
  skin: string;
  x: number;
  y: number;
}

export interface PublicGameTable {
  id: string;
  gameType: string;
  available: boolean;
  x: number;
  y: number;
  label: string;
  /** Phase 1: always "not_wired" for the 3 Vegas tables (status/joining
   * lands in Phase 2) and "reserved" for Texas/dominoes/blackjack. */
  status: "not_wired" | "reserved";
}

export interface PublicBarState {
  players: PublicBarPlayer[];
}

/** Online patrons only — a stale heartbeat removes the avatar from view
 * without touching the bar_players row itself (identity, table
 * membership, and any order survive; "离线后移除在线角色,但保留身份、
 * 订单和游戏进度" per PLAN.md). Nothing is deleted here, ever. */
export function getPublicBarState(db: Database.Database): PublicBarState {
  const rows = db.prepare(`SELECT id, nickname, color, skin, x, y FROM bar_players`).all() as Array<{
    id: string;
    nickname: string;
    color: string;
    skin: string;
    x: number;
    y: number;
  }>;
  const now = new Date();
  const seen = barLastSeenTimes(db);
  const online = rows.filter((p) => {
    const lastSeen = seen.get(p.id);
    return lastSeen !== undefined && isConnected(lastSeen, now);
  });
  return { players: online.map((p) => ({ id: p.id, nickname: p.nickname, color: p.color, skin: p.skin, x: p.x, y: p.y })) };
}

/** Static furniture, including the 6 game-table slots — fetched once by
 * the client, not polled (it never changes at runtime). Phase 1 doesn't
 * wire table status to a real room yet, so every Vegas table reports
 * "not_wired" rather than a real empty/waiting/in-game status — that's
 * Phase 2's job (see PLAN.md's phase breakdown). */
export function getGameTables(): PublicGameTable[] {
  return FURNITURE.filter((f) => f.kind === "game_table").map((f) => ({
    id: f.id,
    gameType: f.gameType!,
    available: f.available!,
    x: f.x,
    y: f.y,
    label: f.label,
    status: f.available ? "not_wired" : "reserved",
  }));
}
