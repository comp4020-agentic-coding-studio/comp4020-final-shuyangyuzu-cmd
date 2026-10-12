// Where a bar identity "really is" for occupancy, movement, click-
// targeting, and chat-proximity purposes. A patron actively, presently
// seated at a game table is drawn — and must be targeted — at their real
// chair tile (src/barLayout.ts's GAME_CHAIRS), never their frozen
// pre-game bar coordinate (CLAUDE.md: a game-table occupant participates
// in display/click judgment by real chair position, not a hidden old
// lobby coordinate). Everyone else is simply wherever `bar_players.x,y`
// says.
//
// Deliberately its own module, not folded into bar.ts or tables.ts:
// tables.ts already imports bar.ts (for requireBarSession), and bar.ts
// needs this same resolution for its own occupancy checks below it in
// the dependency graph — a third, lower module (depending only on
// rooms.ts and barLayout.ts, neither of which know about the bar at all)
// avoids a cycle between the two instead of making one depend on the
// other.

import type Database from "better-sqlite3";
import { GAME_CHAIRS } from "./barLayout.ts";
import { getPublicState } from "./rooms.ts";

export interface Position {
  x: number;
  y: number;
}

interface BarPlayerLinkage {
  x: number;
  y: number;
  current_table_id: string | null;
  current_game_player_id: string | null;
}

/** Null only if no such bar identity exists at all. */
export function effectivePosition(db: Database.Database, barPlayerId: string): Position | null {
  const bp = db
    .prepare(`SELECT x, y, current_table_id, current_game_player_id FROM bar_players WHERE id = ?`)
    .get(barPlayerId) as BarPlayerLinkage | undefined;
  if (!bp) return null;

  if (bp.current_table_id && bp.current_game_player_id) {
    const sessionRow = db.prepare(`SELECT room_id FROM sessions WHERE player_id = ?`).get(bp.current_game_player_id) as
      | { room_id: string }
      | undefined;
    const roomRow = sessionRow
      ? (db.prepare(`SELECT code FROM rooms WHERE id = ?`).get(sessionRow.room_id) as { code: string } | undefined)
      : undefined;
    if (roomRow) {
      let state;
      try {
        state = getPublicState(db, roomRow.code);
      } catch {
        state = null;
      }
      const player = state && !state.closed ? state.players.find((p) => p.id === bp.current_game_player_id) : undefined;
      if (player) {
        // Present = actually, currently at the table right now — the
        // same definition src/tables.ts's getTablesStatus already uses
        // for its own seated-figure rendering (kept in sync here rather
        // than imported, to avoid the same bar.ts<->tables.ts cycle this
        // module exists to sidestep): an NPC-controlled seat is always
        // present (there's no "away" concept for a computer player), a
        // human seat is present only while connected AND not mid an
        // away-from-table departure.
        const departed = db.prepare(`SELECT 1 FROM table_departures WHERE bar_player_id = ?`).get(barPlayerId);
        const present = player.controller === "npc" || (player.connected && !departed);
        if (present) {
          const chair = GAME_CHAIRS.find((c) => c.tableId === bp.current_table_id && c.color === player.color);
          if (chair) return { x: chair.x, y: chair.y };
        }
      }
    }
  }
  return { x: bp.x, y: bp.y };
}
