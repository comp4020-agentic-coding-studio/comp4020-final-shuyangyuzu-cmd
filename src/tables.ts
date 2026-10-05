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
import type { Color, RoomState } from "./types.ts";

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

function phaseToStatus(phase: RoomState["phase"]): "waiting" | "in_progress" | "finished" {
  if (phase === "lobby") return "waiting";
  if (phase === "round_end") return "finished";
  return "in_progress";
}

interface OpenRoom {
  id: string;
  code: string;
  state: RoomState;
}

/** Null unless roomId points at a room that still exists and isn't
 * closed — the single place "is this room actually still live" is
 * decided, so every caller below gets the same answer. */
function lookupOpenRoom(db: Database.Database, roomId: string | null): OpenRoom | null {
  if (!roomId) return null;
  const room = db.prepare(`SELECT id, code, closed_at, state_json FROM rooms WHERE id = ?`).get(roomId) as
    | { id: string; code: string; closed_at: string | null; state_json: string }
    | undefined;
  if (!room || room.closed_at) return null;
  return { id: room.id, code: room.code, state: JSON.parse(room.state_json) };
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
    const players = Object.values(open.state.players);
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

/** Three-way answer, resolved once so every caller sees the same thing:
 * - `{ seatedHere: result }` — genuinely still seated at *this* table;
 *   the caller should hand back the existing seat, not create/join
 *   again (which would otherwise mint a second, duplicate player row
 *   for the same patron in the same room).
 * - throws — genuinely seated at a *different* open table.
 * - returns `null` — free to proceed; if the stored pointer was stale
 *   (room closed, or left via the room's own /leave without this
 *   pointer ever being told), it's cleared here, not left dangling. */
function checkExistingSeat(
  db: Database.Database,
  barPlayerId: string,
  tableId: string,
): { code: string; playerId: string; sessionSecret: string } | null {
  const bp = db.prepare(`SELECT current_table_id, current_game_player_id FROM bar_players WHERE id = ?`).get(
    barPlayerId,
  ) as BarPlayerLinkage | undefined;
  if (!bp?.current_table_id) return null;

  const tableRow = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(bp.current_table_id) as
    | { current_room_id: string | null }
    | undefined;
  const open = lookupOpenRoom(db, tableRow?.current_room_id ?? null);
  const stillSeated =
    open !== null && bp.current_game_player_id !== null && open.state.players[bp.current_game_player_id] !== undefined;

  if (stillSeated) {
    if (bp.current_table_id !== tableId) {
      throw new TableError("you're already seated at another table — leave it first", "already_seated", 409);
    }
    const sessionRow = db.prepare(`SELECT session_secret FROM sessions WHERE player_id = ?`).get(
      bp.current_game_player_id,
    ) as { session_secret: string } | undefined;
    // sessionRow is always present here: creating/joining a room always
    // inserts its sessions row in the same transaction that set this
    // bar_players pointer, and neither is ever deleted independently.
    return { code: open!.code, playerId: bp.current_game_player_id!, sessionSecret: sessionRow!.session_secret };
  }
  db.prepare(`UPDATE bar_players SET current_table_id = NULL, current_game_player_id = NULL WHERE id = ?`).run(
    barPlayerId,
  );
  return null;
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
