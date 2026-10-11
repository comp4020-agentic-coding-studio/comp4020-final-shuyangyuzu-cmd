// Binds each physical Vegas table (src/barLayout.ts's fixed furniture)
// to at most one currently-open game room at a time. The fixture itself
// is permanent (CLAUDE.md: furniture is never created or deleted at
// runtime); only which room it currently points at changes, and a
// closed room's binding is cleared lazily at the next read rather than
// reaped by a background sweep — the same pattern src/rooms.ts already
// uses for its own lobby disconnect grace.
//
// A bar identity and a game room's player are different identity
// spaces (CLAUDE.md: never merged) — bar_players.current_game_player_id
// is the only link between "this patron" and "the player row they
// became inside that room's state", and it's what makes "one table at a
// time, enforced server-side" actually checkable.

import type Database from "better-sqlite3";
import { requireBarSession } from "./bar.ts";
import { GAME_TABLES } from "./barLayout.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import type { Color, PublicState } from "./types.ts";

export class TableError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type TableLiveStatus = "reserved" | "empty" | "waiting" | "in_progress" | "finished";

export interface TableStatusView {
  id: string;
  gameType: string;
  available: boolean;
  label: string;
  status: TableLiveStatus;
  roomCode: string | null;
  playerCount: number;
  takenColors: string[];
}

function phaseToStatus(phase: PublicState["phase"]): "waiting" | "in_progress" | "finished" {
  if (phase === "lobby") return "waiting";
  if (phase === "round_end") return "finished";
  return "in_progress";
}

interface OpenRoom {
  code: string;
  state: PublicState;
}

/** Null unless roomId points at a room that still exists and isn't
 * closed — the single place "is this room actually still live" is
 * decided, so every caller below gets the same answer.
 *
 * Deliberately goes through rooms.getPublicState rather than a raw
 * `SELECT ... FROM rooms` — an independent review found the raw read
 * this used to do bypassed rooms.ts's own lazy lobby-disconnect-grace
 * sweep (loadRoomAfterSweep), so a lobby whose players had all gone
 * stale, but which nobody had read via rooms.ts recently, kept reporting
 * through getTablesStatus as "waiting, N/4" until the *join attempt
 * itself* finally triggered the real sweep, closed the room, and only
 * then refused — "shows someone present, joining says closed" (see
 * PLAN.md's product-direction-update entry). Routing every read here
 * through the same sweep-applying function every other room read already
 * uses removes the second, inconsistent code path instead of adding a
 * special case for it. */
function lookupOpenRoom(db: Database.Database, roomId: string | null): OpenRoom | null {
  if (!roomId) return null;
  const row = db.prepare(`SELECT code FROM rooms WHERE id = ?`).get(roomId) as { code: string } | undefined;
  if (!row) return null; // rooms are never deleted (CLAUDE.md); this would mean a stale id from elsewhere
  const state = rooms.getPublicState(db, row.code);
  if (state.closed) return null;
  return { code: row.code, state };
}

export function getTablesStatus(db: Database.Database): TableStatusView[] {
  return GAME_TABLES.map((t) => {
    if (!t.available) {
      return {
        id: t.id,
        gameType: t.gameType!,
        available: false,
        label: t.label,
        status: "reserved",
        roomCode: null,
        playerCount: 0,
        takenColors: [],
      };
    }
    const row = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(t.id) as
      | { current_room_id: string | null }
      | undefined;
    const open = lookupOpenRoom(db, row?.current_room_id ?? null);
    if (!open) {
      if (row?.current_room_id) {
        // Lazily clear a binding to a room that's since closed — the
        // next person to look is what notices, not a timer.
        db.prepare(`UPDATE tables SET current_room_id = NULL WHERE id = ? AND current_room_id = ?`).run(
          t.id,
          row.current_room_id,
        );
      }
      return {
        id: t.id,
        gameType: t.gameType!,
        available: true,
        label: t.label,
        status: "empty",
        roomCode: null,
        playerCount: 0,
        takenColors: [],
      };
    }
    const players = open.state.players; // already an array — PublicState, not RoomState
    return {
      id: t.id,
      gameType: t.gameType!,
      available: true,
      label: t.label,
      status: phaseToStatus(open.state.phase),
      roomCode: open.code,
      playerCount: players.length,
      takenColors: players.map((p) => p.color),
    };
  });
}

interface BarPlayerLinkage {
  current_table_id: string | null;
  current_game_player_id: string | null;
}

interface ActiveSeat {
  tableId: string;
  code: string;
  playerId: string;
  sessionSecret: string;
}

/** Resolves and re-validates a bar identity's own currently-bound table
 * seat, if any — the one place this check happens, shared by
 * checkExistingSeat below (which adds the "seated elsewhere" refusal on
 * top) and by getActiveSeat (exported for src/server.ts's bar
 * join/rejoin/appearance responses, so "Return to your game" is driven by
 * a live, re-validated answer rather than anything a client stored itself
 * — see PLAN.md's product-direction-update entry for the bug this
 * replaces). A stale pointer (room closed, or left via the room's own
 * /leave without this pointer ever being told) is cleared here, lazily,
 * rather than left dangling. */
function resolveActiveSeat(db: Database.Database, barPlayerId: string): ActiveSeat | null {
  const bp = db.prepare(`SELECT current_table_id, current_game_player_id FROM bar_players WHERE id = ?`).get(
    barPlayerId,
  ) as BarPlayerLinkage | undefined;
  if (!bp?.current_table_id) return null;

  const tableRow = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(bp.current_table_id) as
    | { current_room_id: string | null }
    | undefined;
  const open = lookupOpenRoom(db, tableRow?.current_room_id ?? null);
  const stillSeated =
    open !== null &&
    bp.current_game_player_id !== null &&
    open.state.players.some((p) => p.id === bp.current_game_player_id);

  if (stillSeated) {
    const sessionRow = db.prepare(`SELECT session_secret FROM sessions WHERE player_id = ?`).get(
      bp.current_game_player_id,
    ) as { session_secret: string } | undefined;
    // sessionRow is always present here: creating/joining a room always
    // inserts its sessions row in the same transaction that set this
    // bar_players pointer, and neither is ever deleted independently.
    return {
      tableId: bp.current_table_id,
      code: open!.code,
      playerId: bp.current_game_player_id!,
      sessionSecret: sessionRow!.session_secret,
    };
  }
  db.prepare(`UPDATE bar_players SET current_table_id = NULL, current_game_player_id = NULL WHERE id = ?`).run(
    barPlayerId,
  );
  return null;
}

/** Three-way answer, resolved once so every caller sees the same thing:
 * - a result — genuinely still seated at *this* table; the caller should
 *   hand back the existing seat, not create/join again (which would
 *   otherwise mint a second, duplicate player row for the same patron in
 *   the same room).
 * - throws — genuinely seated at a *different* open table.
 * - returns `null` — free to proceed. */
function checkExistingSeat(
  db: Database.Database,
  barPlayerId: string,
  tableId: string,
): { code: string; playerId: string; sessionSecret: string } | null {
  const seat = resolveActiveSeat(db, barPlayerId);
  if (!seat) return null;
  if (seat.tableId !== tableId) {
    throw new TableError("you're already seated at another table — leave it first", "already_seated", 409);
  }
  return { code: seat.code, playerId: seat.playerId, sessionSecret: seat.sessionSecret };
}

/** The current bar identity's own active table seat, if any —
 * `{tableId, roomCode}` only, never the room's own session_secret (this
 * identity already holds that locally from when it first joined that
 * room; CLAUDE.md forbids a session_secret in any response regardless).
 * Exported for src/server.ts's bar join/rejoin/appearance responses. */
export function getActiveSeat(db: Database.Database, barPlayerId: string): { tableId: string; roomCode: string } | null {
  const seat = resolveActiveSeat(db, barPlayerId);
  return seat ? { tableId: seat.tableId, roomCode: seat.code } : null;
}

function getBarNickname(db: Database.Database, barPlayerId: string): string {
  const row = db.prepare(`SELECT nickname FROM bar_players WHERE id = ?`).get(barPlayerId) as
    | { nickname: string }
    | undefined;
  if (!row) throw new TableError("no such bar identity", "player_not_found", 404);
  return row.nickname;
}

export interface TableRoomResult {
  code: string;
  playerId: string;
  sessionSecret: string;
}

export function createTableRoom(
  db: Database.Database,
  tableId: string,
  barPlayerId: string,
  barSessionSecret: string,
  color: Color,
): TableRoomResult {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const furniture = GAME_TABLES.find((t) => t.id === tableId);
  if (!furniture?.available) throw new TableError("not a playable table", "table_not_found", 404);

  const tx = db.transaction(() => {
    const existing = checkExistingSeat(db, barPlayerId, tableId);
    if (existing) return existing; // re-clicking the table you're already at, not a new game

    const row = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(tableId) as
      | { current_room_id: string | null }
      | undefined;
    if (lookupOpenRoom(db, row?.current_room_id ?? null)) {
      throw new TableError("this table already has a game — join it instead", "table_occupied", 409);
    }

    const nickname = getBarNickname(db, barPlayerId);
    let created: rooms.CreatedRoom;
    try {
      created = rooms.createRoom(db, nickname, color);
    } catch (err) {
      if (err instanceof RoomError) throw new TableError(err.message, err.code, err.status);
      throw err;
    }
    const roomRow = db.prepare(`SELECT id FROM rooms WHERE code = ?`).get(created.code) as { id: string };
    db.prepare(`UPDATE tables SET current_room_id = ? WHERE id = ?`).run(roomRow.id, tableId);
    db.prepare(`UPDATE bar_players SET current_table_id = ?, current_game_player_id = ? WHERE id = ?`).run(
      tableId,
      created.playerId,
      barPlayerId,
    );
    return created;
  });
  return tx();
}

export function joinTableRoom(
  db: Database.Database,
  tableId: string,
  barPlayerId: string,
  barSessionSecret: string,
  color: Color,
): TableRoomResult {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const tx = db.transaction(() => {
    const existing = checkExistingSeat(db, barPlayerId, tableId);
    if (existing) return existing; // re-clicking the table you're already at, not a new join

    const row = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(tableId) as
      | { current_room_id: string | null }
      | undefined;
    const open = lookupOpenRoom(db, row?.current_room_id ?? null);
    if (!open) throw new TableError("no game at this table yet — create one", "table_empty", 404);

    const nickname = getBarNickname(db, barPlayerId);
    let joined: rooms.JoinedRoom;
    try {
      joined = rooms.joinRoom(db, open.code, nickname, color);
    } catch (err) {
      if (err instanceof RoomError) throw new TableError(err.message, err.code, err.status);
      throw err;
    }
    db.prepare(`UPDATE bar_players SET current_table_id = ?, current_game_player_id = ? WHERE id = ?`).run(
      tableId,
      joined.playerId,
      barPlayerId,
    );
    return { code: open.code, ...joined };
  });
  return tx();
}
