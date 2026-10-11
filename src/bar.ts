// The bar: a separate identity layer from a game room's (CLAUDE.md) —
// its own tables, its own session secrets, its own presence. Phase 1
// scope only: join/rejoin, heartbeat, grid-tile movement (server-
// validated against src/barLayout.ts), and a public snapshot for
// rendering. Table click-to-join/create (Phase 2), ordering (Phase 3),
// and seating (Phase 4) are deliberately not here yet.

import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { BAR_SEATS, defaultSpawn, FURNITURE, isValidStep } from "./barLayout.ts";
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
    // Moving away is an implicit stand-up — a seat's occupancy must never
    // outlive the patron actually being on that tile (PLAN.md Phase 2:
    // "standing up and moving must not trap the character inside
    // furniture," and more basically, a chair can't show "occupied" once
    // its occupant has visibly walked off).
    db.prepare(`UPDATE bar_seats SET occupied_by = NULL WHERE occupied_by = ?`).run(playerId);
  });
  tx();
  recordBarHeartbeat(db, playerId);
}

export interface PublicSeat {
  id: string;
  furnitureId: string;
  x: number;
  y: number;
}

/** Every real seat's static layout — fetched once by the client via
 * GET /api/bar/layout, same as FURNITURE already is. Live occupancy is
 * read from each PublicBarPlayer's own `seatId` in the streamed bar
 * state, not duplicated here. */
export function getSeatLayout(): PublicSeat[] {
  return BAR_SEATS.map((s) => ({ id: s.id, furnitureId: s.furnitureId, x: s.x, y: s.y }));
}

/** Sitting requires actually standing on the seat's own tile — ordinary
 * movement gets you there, so there's no separate walkability exception
 * to maintain (src/barLayout.ts's BAR_SEATS doc comment). One real seat
 * at a time per patron; sitting back down in the same seat you're
 * already in is a harmless no-op, not an error (re-clicking your own
 * chair shouldn't surface a confusing refusal). */
export function sitAtSeat(db: Database.Database, playerId: string, sessionSecret: string, seatId: string): void {
  requireBarSession(db, playerId, sessionSecret);
  const seat = BAR_SEATS.find((s) => s.id === seatId);
  if (!seat) throw new BarError("no such seat", "seat_not_found", 404);

  const tx = db.transaction(() => {
    const player = db.prepare(`SELECT x, y, current_table_id FROM bar_players WHERE id = ?`).get(playerId) as
      | { x: number; y: number; current_table_id: string | null }
      | undefined;
    if (!player) throw new BarError("no such bar identity", "player_not_found", 404);
    if (player.x !== seat.x || player.y !== seat.y) {
      throw new BarError("walk to the seat before sitting down", "not_at_seat", 409);
    }

    const mine = db.prepare(`SELECT id FROM bar_seats WHERE occupied_by = ?`).get(playerId) as
      | { id: string }
      | undefined;
    if (mine) {
      if (mine.id === seatId) return; // already sitting here
      throw new BarError("stand up from your current seat first", "already_seated_elsewhere", 409);
    }

    const row = db.prepare(`SELECT occupied_by FROM bar_seats WHERE id = ?`).get(seatId) as
      | { occupied_by: string | null }
      | undefined;
    if (!row) throw new BarError("no such seat", "seat_not_found", 404);
    if (row.occupied_by) throw new BarError("someone is already sitting there", "seat_taken", 409);

    db.prepare(`UPDATE bar_seats SET occupied_by = ? WHERE id = ?`).run(playerId, seatId);

    // Sitting at a real seat while bound to a game table means stepping
    // away from it, physically — starts (or refreshes) the 2-minute
    // away-from-table clock (CLAUDE.md's leave/exit states). Standing
    // back up from this seat does NOT clear the clock on its own — only
    // actually re-engaging with the game (a heartbeat/rejoin/action
    // there) does, so briefly sitting down somewhere else and standing
    // right back up can't be used to silently reset a departure that's
    // already ticking.
    if (player.current_table_id) {
      db.prepare(
        `INSERT INTO table_departures (bar_player_id, table_id, left_at) VALUES (?, ?, ?)
         ON CONFLICT(bar_player_id) DO UPDATE SET table_id = excluded.table_id, left_at = excluded.left_at`,
      ).run(playerId, player.current_table_id, new Date().toISOString());
    }
  });
  tx();
  recordBarHeartbeat(db, playerId);
}

/** Idempotent: standing when not seated anywhere is a harmless no-op. */
export function standFromSeat(db: Database.Database, playerId: string, sessionSecret: string): void {
  requireBarSession(db, playerId, sessionSecret);
  db.prepare(`UPDATE bar_seats SET occupied_by = NULL WHERE occupied_by = ?`).run(playerId);
  recordBarHeartbeat(db, playerId);
}

export interface PublicBarPlayer {
  id: string;
  nickname: string;
  color: string;
  skin: string;
  x: number;
  y: number;
  /** The real seat (dining/stool) this patron currently occupies, if
   * any — null otherwise. A game table's own chairs are never reported
   * here (src/tables.ts's getTablesStatus reports those, from the bound
   * room's own player roster, since that's a different occupancy
   * concept entirely — PLAN.md's product-direction-update entry). */
  seatId: string | null;
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
  const seatedBy = new Map(
    (db.prepare(`SELECT id, occupied_by FROM bar_seats WHERE occupied_by IS NOT NULL`).all() as Array<{
      id: string;
      occupied_by: string;
    }>).map((s) => [s.occupied_by, s.id]),
  );
  return {
    players: online.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      color: p.color,
      skin: p.skin,
      x: p.x,
      y: p.y,
      seatId: seatedBy.get(p.id) ?? null,
    })),
  };
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
