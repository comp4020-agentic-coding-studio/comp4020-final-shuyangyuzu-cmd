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
import { logAction, transact } from "./actionLog.ts";
import { requireBarSession } from "./bar.ts";
import { GAME_TABLES } from "./barLayout.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import { COLORS, type Color, type PublicState } from "./types.ts";

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

/** One of a game table's (up to COLORS.length) chairs, for real seated
 * rendering — null for an empty chair, ordered by COLORS to match
 * GAME_CHAIRS. This is a view of the bound room's own player roster, the
 * source of truth for "who's at this table" (PLAN.md's
 * product-direction-update entry). */
export interface TableSeatView {
  color: string;
  nickname: string;
  connected: boolean;
  controller: "human" | "npc";
  barPlayerId: string | null;
  skin: string;
  present: boolean;
}

export interface TableStatusView {
  id: string;
  gameType: string;
  available: boolean;
  label: string;
  /** Which row this table belongs to (src/barLayout.ts's TableMode). An
   * "npc" table always reports as "empty" with no occupancy at all
   * below, regardless of how many visitors are privately playing there
   * right now — it's a solo kiosk, not a shared room other patrons could
   * ever join, and must never be shown as if it were one (PLAN.md's
   * product-direction-update: "普通大厅玩家不应把别人的个人NPC对局显示成
   * 自己可加入的在线房间"). */
  tableMode: "online" | "npc";
  status: TableLiveStatus;
  roomCode: string | null;
  playerCount: number;
  takenColors: string[];
  /** Always length COLORS.length (== MAX_PLAYERS in src/rooms.ts), null
   * where empty — kept separate from takenColors (which the table-
   * dialog's own color picker already depends on) rather than replacing
   * it. */
  seats: Array<TableSeatView | null>;
  /** How many join requests are awaiting the host's approval right now
   * (Crit 9 phase 8) — a lightweight count for the bar's own table
   * dialog to show "N waiting for approval", not full requester detail
   * (that's the room's own lobby view, which already shows it to
   * everyone — CLAUDE.md transparency). Always 0 once a game has started,
   * and always 0 for an NPC table (no approval concept there). */
  pendingCount: number;
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

function emptySeats(): Array<TableSeatView | null> {
  return COLORS.map(() => null);
}

export function getTablesStatus(db: Database.Database): TableStatusView[] {
  return GAME_TABLES.map((t) => {
    const tableMode = t.tableMode ?? "online";
    if (!t.available) {
      return {
        id: t.id,
        gameType: t.gameType!,
        available: false,
        label: t.label,
        tableMode,
        status: "reserved",
        roomCode: null,
        playerCount: 0,
        takenColors: [],
        seats: emptySeats(),
        pendingCount: 0,
      };
    }
    // An NPC table is a solo kiosk, not a single shared room — it has no
    // `current_room_id` concept at all (many visitors can each be mid-
    // game there at once), so it always reports as freely startable,
    // never showing anyone else's private game as if it were a joinable
    // online room (PLAN.md's product-direction-update).
    if (tableMode === "npc") {
      return {
        id: t.id,
        gameType: t.gameType!,
        available: true,
        label: t.label,
        tableMode,
        status: "empty",
        roomCode: null,
        playerCount: 0,
        takenColors: [],
        seats: emptySeats(),
        pendingCount: 0,
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
        tableMode,
        status: "empty",
        roomCode: null,
        playerCount: 0,
        takenColors: [],
        seats: emptySeats(),
        pendingCount: 0,
      };
    }
    const players = open.state.players; // already an array — PublicState, not RoomState
    const seats = emptySeats();
    for (const p of players) {
      const chairIndex = COLORS.indexOf(p.color);
      if (chairIndex >= 0) {
        const patron = db.prepare(`SELECT b.id, b.skin, d.left_at FROM bar_players b
          LEFT JOIN table_departures d ON d.bar_player_id = b.id
          WHERE b.current_game_player_id = ? AND b.current_table_id = ?`).get(p.id, t.id) as
          { id: string; skin: string; left_at: string | null } | undefined;
        seats[chairIndex] = { color: p.color, nickname: p.nickname, connected: p.connected, controller: p.controller,
          barPlayerId: patron?.id ?? null, skin: patron?.skin ?? "warm",
          present: p.controller === "npc" || (p.connected && !patron?.left_at) };
      }
    }
    return {
      id: t.id,
      gameType: t.gameType!,
      available: true,
      label: t.label,
      tableMode,
      status: phaseToStatus(open.state.phase),
      roomCode: open.code,
      playerCount: players.length,
      takenColors: players.map((p) => p.color),
      seats,
      pendingCount: open.state.pendingRequests.length,
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
  /** True if this is a pending join request awaiting host approval, not
   * an actual seat yet (Crit 9 phase 8's approval workflow) — "still
   * associated with this table" either way, for one-table-at-a-time and
   * for what getActiveSeat reports, but a very different thing to show
   * the owner ("waiting for approval" vs. "return to your game"). */
  pending: boolean;
}

/** Resolves and re-validates a bar identity's own currently-bound table
 * seat, if any — the one place this check happens, shared by
 * checkExistingSeat below (which adds the "seated elsewhere" refusal on
 * top) and by getActiveSeat (exported for src/server.ts's bar
 * join/rejoin/appearance responses, so "Return to your game" is driven by
 * a live, re-validated answer rather than anything a client stored itself
 * — see PLAN.md's product-direction-update entry for the bug this
 * replaces). A stale pointer (room closed, request rejected/expired, or
 * left via the room's own /leave without this pointer ever being told)
 * is cleared here, lazily, rather than left dangling.
 *
 * Resolves the room via `sessions.room_id` for the stored
 * `current_game_player_id` — not via the table fixture's own
 * `current_room_id` pointer. The two agree for an online table (exactly
 * one shared room at a time), but a solo Vegas-NPC table (Crit 9 phase
 * 8) has *many* concurrent private rooms bound to the same fixture — one
 * per visitor — so there is no single "the room" a fixture-level pointer
 * could even name. Resolving per-identity, from that identity's own
 * session, works correctly either way without the two table kinds
 * needing different code paths here. */
function resolveActiveSeat(db: Database.Database, barPlayerId: string): ActiveSeat | null {
  const bp = db.prepare(`SELECT current_table_id, current_game_player_id FROM bar_players WHERE id = ?`).get(
    barPlayerId,
  ) as BarPlayerLinkage | undefined;
  if (!bp?.current_table_id || !bp.current_game_player_id) return null;

  const sessionRow = db.prepare(`SELECT room_id, session_secret FROM sessions WHERE player_id = ?`).get(
    bp.current_game_player_id,
  ) as { room_id: string; session_secret: string } | undefined;

  const roomRow = sessionRow
    ? (db.prepare(`SELECT code FROM rooms WHERE id = ?`).get(sessionRow.room_id) as { code: string } | undefined)
    : undefined;
  const state = roomRow ? rooms.getPublicState(db, roomRow.code) : null; // applies the lazy sweep
  const seated = state !== null && !state.closed && state.players.some((p) => p.id === bp.current_game_player_id);
  const pending =
    !seated && state !== null && !state.closed && state.pendingRequests.some((r) => r.id === bp.current_game_player_id);

  if (sessionRow && roomRow && (seated || pending)) {
    return {
      tableId: bp.current_table_id,
      code: roomRow.code,
      playerId: bp.current_game_player_id,
      sessionSecret: sessionRow.session_secret,
      pending,
    };
  }
  db.prepare(`UPDATE bar_players SET current_table_id = NULL, current_game_player_id = NULL WHERE id = ?`).run(
    barPlayerId,
  );
  return null;
}

/** Three-way answer, resolved once so every caller sees the same thing:
 * - a result — genuinely still seated (or pending) at *this* table; the
 *   caller should hand back the existing seat/request, not create/join/
 *   request again (which would otherwise mint a second, duplicate player
 *   or request for the same patron in the same room).
 * - throws — genuinely seated or pending at a *different* open table.
 * - returns `null` — free to proceed. */
function checkExistingSeat(
  db: Database.Database,
  barPlayerId: string,
  tableId: string,
): { code: string; playerId: string; sessionSecret: string; pending: boolean } | null {
  const seat = resolveActiveSeat(db, barPlayerId);
  if (!seat) return null;
  if (seat.tableId !== tableId) {
    throw new TableError("you're already seated at another table — leave it first", "already_seated", 409);
  }
  return { code: seat.code, playerId: seat.playerId, sessionSecret: seat.sessionSecret, pending: seat.pending };
}

/** The current bar identity's own active table seat or pending request,
 * if any — `{tableId, roomCode, pending}` only, never the room's own
 * session_secret (this identity already holds that locally from when it
 * first joined/requested that room; CLAUDE.md forbids a session_secret in
 * any response regardless). Exported for src/server.ts's bar
 * join/rejoin/appearance responses. */
export function getActiveSeat(
  db: Database.Database,
  barPlayerId: string,
): { tableId: string; roomCode: string; pending: boolean } | null {
  const seat = resolveActiveSeat(db, barPlayerId);
  return seat ? { tableId: seat.tableId, roomCode: seat.code, pending: seat.pending } : null;
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
  /** True if this is a pending request awaiting host approval, not an
   * actual seat yet (Crit 9 phase 8's approval workflow) — the client
   * needs this to show "waiting for approval" rather than the normal
   * lobby. Always false for createTableRoom (the first person to open an
   * empty table is seated immediately, as host, by product decision). */
  pending: boolean;
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
  // Same guard as joinTableRoom's own: an NPC-mode fixture is never a
  // shared room another patron could create/join, so this endpoint must
  // reject it outright rather than let it through on `available` alone.
  if (!furniture?.available || furniture.tableMode !== "online") {
    throw new TableError("not a playable table", "table_not_found", 404);
  }

  return transact(db, () => {
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
      // rooms.createRoom calls transact(db, ...) itself — since this
      // outer call is also transact(db, ...), that inner call becomes a
      // SAVEPOINT nested inside this one (db.inTransaction is already
      // true), and its own logAction calls correctly join THIS buffer
      // rather than flushing early — see src/actionLog.ts's header for
      // why an earlier version of this file, using raw db.transaction()
      // here, let the inner call's logging escape an outer rollback.
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
    // Carries both identities together in one line — the one place a
    // presenter can correlate a tavern character to the game player it
    // just became, since rooms.ts itself deliberately stays bar-agnostic
    // (CLAUDE.md's bar/game separation) and every later rolled/placed
    // line only ever carries the room's own playerId.
    logAction(db, {
      action: "create_table",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId, nickname },
      room: { code: created.code },
      table: { id: tableId },
      detail: { roomPlayerId: created.playerId.slice(0, 8), color },
    });
    return { ...created, pending: false };
  });
}

/** Submits a request to join a table that already has a host — never an
 * immediate seat (Crit 9 phase 8's approval workflow; only the first
 * person to open an *empty* table, via createTableRoom above, is seated
 * immediately). The host approves or declines it from the room's own
 * lobby view (rooms.approveJoin/rejectJoin, called directly from
 * src/server.ts — that's a plain room-session action, no bar identity
 * involved, the same as every other lobby action already is). */
export function joinTableRoom(
  db: Database.Database,
  tableId: string,
  barPlayerId: string,
  barSessionSecret: string,
  color: Color,
): TableRoomResult {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const furniture = GAME_TABLES.find((t) => t.id === tableId);
  // Checked before checkExistingSeat's own early return: a visitor who
  // already has an active seat at an NPC table (their own solo game)
  // must still get a hard 404 calling this ONLINE-table endpoint against
  // that same id, not a success that hands back their NPC game — the two
  // table kinds use different start endpoints (startNpcGame) on purpose
  // (PLAN.md's product-direction-update: an NPC table is never shown as
  // joinable to anyone, including its own player calling the wrong route).
  if (!furniture?.available || furniture.tableMode !== "online") {
    throw new TableError("not a playable online table", "table_not_found", 404);
  }
  return transact(db, () => {
    const existing = checkExistingSeat(db, barPlayerId, tableId);
    if (existing) return existing; // re-clicking the table you're already at/pending for, not a new request

    const row = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(tableId) as
      | { current_room_id: string | null }
      | undefined;
    const open = lookupOpenRoom(db, row?.current_room_id ?? null);
    if (!open) throw new TableError("no game at this table yet — create one", "table_empty", 404);

    const nickname = getBarNickname(db, barPlayerId);
    let requested: rooms.RequestedJoin;
    try {
      requested = rooms.requestJoin(db, open.code, nickname, color); // nested under this call's own transact(db, ...) — see createTableRoom's comment above
    } catch (err) {
      if (err instanceof RoomError) throw new TableError(err.message, err.code, err.status);
      throw err;
    }
    db.prepare(`UPDATE bar_players SET current_table_id = ?, current_game_player_id = ? WHERE id = ?`).run(
      tableId,
      requested.playerId,
      barPlayerId,
    );
    logAction(db, {
      action: "join_table",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId, nickname },
      room: { code: open.code },
      table: { id: tableId },
      detail: { roomPlayerId: requested.playerId.slice(0, 8), color, pending: true },
    });
    return { code: open.code, playerId: requested.playerId, sessionSecret: requested.sessionSecret, pending: true };
  });
}

/** Starts (or resumes) this visitor's own private game at a solo Vegas-
 * NPC table — never a shared room another patron could join, and never
 * gated on anyone else (no waiting, no approval). `playerCount` (2 to
 * COLORS.length, total including the human) controls how many NPC seats
 * `rooms.createSoloNpcGame` fills — validated there, not re-validated
 * here, so there's one place that owns "what counts as a legal count."
 * Re-clicking the same NPC table while already in an active private game
 * there hands back that same game (checkExistingSeat, unchanged) rather
 * than starting a second one and orphaning the first — `playerCount` is
 * simply ignored on that path, same as `color` already is. Re-clicking it
 * after that game has ended (round_end or disbanded... though an NPC game
 * is never disbanded, only ever finishes) starts a genuinely new one.
 * Never touches `tables.current_room_id` at all — there is no single
 * "the" room for this fixture (PLAN.md's product-direction-update: one
 * table, many concurrent private games, one per visitor). */
export function startNpcGame(
  db: Database.Database,
  tableId: string,
  barPlayerId: string,
  barSessionSecret: string,
  color: Color,
  playerCount: number,
): TableRoomResult {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const furniture = GAME_TABLES.find((t) => t.id === tableId);
  if (!furniture?.available || furniture.tableMode !== "npc") {
    throw new TableError("not a solo NPC table", "table_not_found", 404);
  }
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > COLORS.length) {
    throw new TableError(`playerCount must be between 2 and ${COLORS.length}`, "bad_player_count", 400);
  }

  return transact(db, () => {
    const existing = checkExistingSeat(db, barPlayerId, tableId);
    if (existing) return existing; // already mid-game here — hand back that same game, don't start a second

    const nickname = getBarNickname(db, barPlayerId);
    let created: rooms.CreatedRoom;
    try {
      created = rooms.createSoloNpcGame(db, nickname, color, playerCount - 1); // nested under this call's own transact(db, ...) — see createTableRoom's comment above
    } catch (err) {
      if (err instanceof RoomError) throw new TableError(err.message, err.code, err.status);
      throw err;
    }
    db.prepare(`UPDATE bar_players SET current_table_id = ?, current_game_player_id = ? WHERE id = ?`).run(
      tableId,
      created.playerId,
      barPlayerId,
    );
    logAction(db, {
      action: "start_npc_game",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId, nickname },
      room: { code: created.code },
      table: { id: tableId },
      detail: { roomPlayerId: created.playerId.slice(0, 8), color },
    });
    return { ...created, pending: false };
  });
}

// ---- The 2-minute away-from-table clock (CLAUDE.md's leave/exit states) ----

/** Explicitly marks "I've just stepped away from my table" — called when
 * a patron navigates from the game-room view back to the bar
 * (`public/app.js`'s "Back to the bar" button), independent of sitting
 * at a real seat (src/bar.ts's sitAtSeat starts/refreshes the same clock
 * for that trigger). A no-op if this identity has no active table
 * binding at all — never an error, since this is a best-effort signal
 * fired alongside an ordinary navigation, not a request the UI blocks on. */
export function departActiveTable(db: Database.Database, barPlayerId: string, barSessionSecret: string): void {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const row = db.prepare(`SELECT current_table_id FROM bar_players WHERE id = ?`).get(barPlayerId) as
    | { current_table_id: string | null }
    | undefined;
  if (!row?.current_table_id) return;
  db.prepare(
    `INSERT INTO table_departures (bar_player_id, table_id, left_at) VALUES (?, ?, ?)
     ON CONFLICT(bar_player_id) DO UPDATE SET table_id = excluded.table_id, left_at = excluded.left_at`,
  ).run(barPlayerId, row.current_table_id, new Date().toISOString());
  logAction(db, {
    action: "depart_table",
    outcome: "ok",
    verified: true,
    actor: { kind: "bar", id: barPlayerId },
    table: { id: row.current_table_id },
  });
}

/** Explicitly marks "I've just gone back to my table" — the one thing
 * that clears a pending departure. Deliberately NOT triggered by a room
 * heartbeat or rejoin: an independent review caught that an earlier
 * version did exactly that, and both are passive signals that only prove
 * a browser/tab is still connected — they fire automatically even from a
 * room view left open in the background while this same identity's bar
 * avatar is sitting somewhere else entirely. This is called instead from
 * deliberate bar-world actions only (`public/tavern.js`: the "Return to
 * your game" button, and navigating into a table's room via the table
 * dialog), right before the navigation that's actually heading back to
 * the table. A no-op if there's no pending departure at all. */
export function resumeActiveTable(db: Database.Database, barPlayerId: string, barSessionSecret: string): void {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const existing = db.prepare(`SELECT table_id FROM table_departures WHERE bar_player_id = ?`).get(barPlayerId) as
    | { table_id: string }
    | undefined;
  const result = db.prepare(`DELETE FROM table_departures WHERE bar_player_id = ?`).run(barPlayerId);
  if (result.changes > 0) {
    logAction(db, {
      action: "resume_table",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId },
      table: existing ? { id: existing.table_id } : null,
    });
  }
}

/** Resolves every table_departures row older than `awayMs` — pre-start,
 * reuses rooms.leaveRoom exactly as a voluntary leave would (host
 * transfer, room close, all unchanged); once a game has started, hands
 * the seat to NPC control instead (rooms.handoffToNpc) rather than
 * dropping dice, skipping a settlement, or stalling the turn order
 * (CLAUDE.md). Returns the room codes actually changed, so the caller
 * (src/server.ts) knows what to broadcast — this function never
 * publishes anything itself, matching every other src/tables.ts function
 * (publishing is server.ts's job alone). */
export function enforceExpiredDepartures(db: Database.Database, awayMs: number): string[] {
  const cutoff = new Date(Date.now() - awayMs).toISOString();
  const stale = db.prepare(`SELECT bar_player_id, table_id FROM table_departures WHERE left_at < ?`).all(cutoff) as Array<{
    bar_player_id: string;
    table_id: string;
  }>;
  const affected = new Set<string>();

  for (const dep of stale) {
    db.prepare(`DELETE FROM table_departures WHERE bar_player_id = ?`).run(dep.bar_player_id);

    const bp = db.prepare(`SELECT current_table_id, current_game_player_id FROM bar_players WHERE id = ?`).get(
      dep.bar_player_id,
    ) as BarPlayerLinkage | undefined;
    // Moved on since this departure was recorded (switched tables,
    // already left) — nothing to enforce.
    if (!bp?.current_table_id || bp.current_table_id !== dep.table_id || !bp.current_game_player_id) continue;

    const tableRow = db.prepare(`SELECT current_room_id FROM tables WHERE id = ?`).get(dep.table_id) as
      | { current_room_id: string | null }
      | undefined;
    const open = lookupOpenRoom(db, tableRow?.current_room_id ?? null);
    if (!open) continue; // the room's already gone

    if (open.state.phase === "lobby") {
      const sessionRow = db.prepare(`SELECT session_secret FROM sessions WHERE player_id = ?`).get(
        bp.current_game_player_id,
      ) as { session_secret: string } | undefined;
      if (!sessionRow) continue;
      try {
        rooms.leaveRoom(db, open.code, bp.current_game_player_id, sessionRow.session_secret);
        affected.add(open.code);
        // rooms.leaveRoom already logs its own "player_left"/"room_closed"/
        // "host_transferred" action lines — this is the table-layer event
        // that explains *why* that happened (a lobby seat's own 2-minute
        // away-from-table clock expiring), not a duplicate of it.
        logAction(db, {
          action: "table_departure_expired_lobby",
          outcome: "ok",
          verified: true,
          actor: { kind: "bar", id: dep.bar_player_id },
          room: { code: open.code },
          table: { id: dep.table_id },
        });
      } catch {
        // Already left, room closed in the meantime, etc. — fine.
      }
    } else {
      rooms.handoffToNpc(db, open.code, bp.current_game_player_id);
      affected.add(open.code);
      // rooms.handoffToNpc already logs "npc_takeover" for the room-side
      // seat change — this is the table-layer event explaining why (the
      // same 2-minute away-from-table clock, but on an already-started
      // game, per CLAUDE.md's leave/exit states).
      logAction(db, {
        action: "table_departure_expired_handoff",
        outcome: "ok",
        verified: true,
        actor: { kind: "bar", id: dep.bar_player_id },
        room: { code: open.code },
        table: { id: dep.table_id },
      });
    }
  }
  return [...affected];
}
