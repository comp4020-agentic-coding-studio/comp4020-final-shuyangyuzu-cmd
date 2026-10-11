// Room lifecycle and the HTTP-facing wrapper around src/game.ts's pure
// turn engine: this is where authentication, the DB transaction, and
// public-response sanitization live. See CLAUDE.md for why each of those
// is non-negotiable.

import type Database from "better-sqlite3";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { freshDeck } from "./deck.ts";
import { applyPlacement, applyRoll, GameError, startGame as startGameLogic } from "./game.ts";
import { chooseNpcPlacement } from "./npc.ts";
import {
  forgetPresence,
  isConnected,
  isPastGrace,
  lastSeenTimes,
  pickNextHost,
  recordHeartbeat,
} from "./presence.ts";
import { systemRng } from "./rng.ts";
import { COLORS, type Color, type PublicState, type RoomState } from "./types.ts";

// Excludes 0/O, 1/I/L — characters that are easy to mis-type or mis-read
// aloud when a room code is being passed around a table.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
export const MAX_PLAYERS = 4;

export class RoomError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function emptyState(): RoomState {
  return {
    phase: "lobby",
    turnOrder: [],
    currentPlayerId: null,
    players: {},
    lastRoll: null,
    casinos: [],
    deck: freshDeck(),
  };
}

function generateCode(db: Database.Database): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
    if (!exists) return code;
  }
  // 31^6 is ~887 billion; 50 collisions in a row means something is
  // actually wrong (e.g. the alphabet/length got misconfigured), not bad
  // luck — fail loudly rather than loop forever.
  throw new Error("could not generate a unique room code after 50 attempts");
}

function newSessionSecret(): string {
  return randomBytes(24).toString("base64url");
}

function logEvent(db: Database.Database, roomId: string, type: string, payload: unknown): void {
  db.prepare(`INSERT INTO events (room_id, type, payload, created_at) VALUES (?, ?, ?, ?)`).run(
    roomId,
    type,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

interface RoomRow {
  id: string;
  code: string;
  host_player_id: string;
  closed_at: string | null;
  state_json: string;
  version: number;
}

function getRoomRow(db: Database.Database, code: string): RoomRow {
  const row = db
    .prepare(`SELECT id, code, host_player_id, closed_at, state_json, version FROM rooms WHERE code = ?`)
    .get(code.toUpperCase()) as RoomRow | undefined;
  if (!row) throw new RoomError("no such room", "room_not_found", 404);
  return row;
}

/** Applies the lobby disconnect-grace sweep (a no-op outside the lobby,
 * or if nobody's actually past grace) and returns the row fresh
 * afterwards. Never throws on a closed room — closed is a normal,
 * displayable state for a read, not a failure. See loadOpenRoom for the
 * version mutating actions need. */
function loadRoomAfterSweep(db: Database.Database, code: string): RoomRow {
  const row = getRoomRow(db, code);
  sweepStaleLobbyPlayers(db, row);
  return getRoomRow(db, code);
}

/** Same, but refuses a closed room outright — what every mutating action
 * (join, start, roll, place, ready, leave, disband, heartbeat) wants: a
 * closed room has nothing left to mutate. */
function loadOpenRoom(db: Database.Database, code: string): RoomRow {
  const row = loadRoomAfterSweep(db, code);
  if (row.closed_at) throw new RoomError("this room has closed", "room_closed", 410);
  return row;
}

/** Lobby-only: removes any player whose last heartbeat (or join time, if
 * they've never sent one yet) is past LOBBY_GRACE_MS. Transfers host to
 * the remaining player with the lowest seat if the host was the one
 * removed; closes the room if nobody's left. Never touches a game that's
 * already started (CLAUDE.md / PLAN.md playtest-round-1: no auto-removal
 * once playing) — checked both before and again inside the transaction,
 * since this runs on every read, not just on an explicit action. */
function sweepStaleLobbyPlayers(db: Database.Database, row: RoomRow): void {
  if (row.closed_at) return;
  const state: RoomState = JSON.parse(row.state_json);
  if (state.phase !== "lobby") return;

  const now = new Date();
  const seen = lastSeenTimes(db, row.id);
  const staleIds = Object.values(state.players)
    .filter((p) => isPastGrace(seen.get(p.id) ?? p.joinedAt, now))
    .map((p) => p.id);
  if (staleIds.length === 0) return;

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version, host_player_id, closed_at FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number; host_player_id: string; closed_at: string | null };
    if (fresh.closed_at) return;
    const freshState: RoomState = JSON.parse(fresh.state_json);
    if (freshState.phase !== "lobby") return;

    let anyRemoved = false;
    for (const id of staleIds) {
      if (freshState.players[id]) {
        delete freshState.players[id];
        forgetPresence(db, id);
        anyRemoved = true;
        logEvent(db, row.id, "player_timed_out", { playerId: id });
      }
    }
    if (!anyRemoved) return;

    let hostId = fresh.host_player_id;
    let closedAt: string | null = null;
    if (!freshState.players[hostId]) {
      const next = pickNextHost(Object.values(freshState.players));
      if (next === null) {
        closedAt = now.toISOString();
        logEvent(db, row.id, "room_closed", { reason: "last player timed out" });
      } else {
        hostId = next;
        logEvent(db, row.id, "host_transferred", { newHostId: hostId, reason: "previous host timed out" });
      }
    }

    db.prepare(
      `UPDATE rooms SET state_json = ?, host_player_id = ?, closed_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
    ).run(JSON.stringify(freshState), hostId, closedAt, row.id, fresh.version);
  });
  tx();
}

function requireSession(db: Database.Database, roomId: string, playerId: string, sessionSecret: string): void {
  const row = db
    .prepare(`SELECT session_secret FROM sessions WHERE player_id = ? AND room_id = ?`)
    .get(playerId, roomId) as { session_secret: string } | undefined;
  if (!row || row.session_secret !== sessionSecret) {
    throw new RoomError("not authorized for this player in this room", "unauthorized", 403);
  }
}

function requireSeated(state: RoomState, playerId: string): void {
  if (!state.players[playerId]) {
    throw new RoomError(
      "you're no longer in this room (likely removed after being disconnected too long)",
      "player_removed",
      410,
    );
  }
}

export interface CreatedRoom {
  code: string;
  playerId: string;
  sessionSecret: string;
}

export function createRoom(db: Database.Database, nickname: string, color: Color): CreatedRoom {
  const trimmed = nickname.trim();
  if (!trimmed) throw new RoomError("nickname is required", "nickname_required", 400);
  if (!COLORS.includes(color)) throw new RoomError("not a valid color", "bad_color", 400);

  const roomId = randomUUID();
  const playerId = randomUUID();
  const sessionSecret = newSessionSecret();
  const code = generateCode(db);
  const now = new Date().toISOString();

  const state = emptyState();
  state.players[playerId] = {
    id: playerId,
    nickname: trimmed,
    color,
    seat: 0,
    diceInHand: 0,
    wonBills: [],
    ready: false,
    joinedAt: now,
    controller: "human",
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO rooms (id, code, host_player_id, created_at, state_json, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(roomId, code, playerId, now, JSON.stringify(state));
    db.prepare(`INSERT INTO sessions (player_id, room_id, session_secret) VALUES (?, ?, ?)`).run(
      playerId,
      roomId,
      sessionSecret,
    );
    recordHeartbeat(db, roomId, playerId, new Date(now));
    logEvent(db, roomId, "room_created", { playerId, nickname: trimmed, color });
  });
  tx();

  return { code, playerId, sessionSecret };
}

export interface JoinedRoom {
  playerId: string;
  sessionSecret: string;
}

export function joinRoom(db: Database.Database, code: string, nickname: string, color: Color): JoinedRoom {
  const trimmed = nickname.trim();
  if (!trimmed) throw new RoomError("nickname is required", "nickname_required", 400);
  if (!COLORS.includes(color)) throw new RoomError("not a valid color", "bad_color", 400);

  const row = loadOpenRoom(db, code);
  const playerId = randomUUID();
  const sessionSecret = newSessionSecret();

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version, closed_at FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number; closed_at: string | null };
    if (fresh.closed_at) throw new RoomError("this room has closed", "room_closed", 410);
    const state: RoomState = JSON.parse(fresh.state_json);

    if (state.phase !== "lobby") {
      throw new RoomError("the game has already started; seats are closed", "seats_closed", 409);
    }
    const existing = Object.values(state.players);
    if (existing.length >= MAX_PLAYERS) {
      throw new RoomError("this room already has its 4 players", "room_full", 409);
    }
    if (existing.some((p) => p.color === color)) {
      throw new RoomError("that color is already taken in this room", "color_taken", 409);
    }

    const now = new Date().toISOString();
    state.players[playerId] = {
      id: playerId,
      nickname: trimmed,
      color,
      seat: existing.length,
      diceInHand: 0,
      wonBills: [],
      ready: false,
      joinedAt: now,
      controller: "human",
    };

    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(state),
      row.id,
      fresh.version,
    );
    db.prepare(`INSERT INTO sessions (player_id, room_id, session_secret) VALUES (?, ?, ?)`).run(
      playerId,
      row.id,
      sessionSecret,
    );
    recordHeartbeat(db, row.id, playerId, new Date(now));
    logEvent(db, row.id, "player_joined", { playerId, nickname: trimmed, color });
  });
  tx();

  return { playerId, sessionSecret };
}

/** Confirms a returning player's identity. Deliberately doesn't throw on
 * a closed room — rejoining just proves who you are; getPublicState (the
 * client always fetches this right after) is what tells them the room's
 * closed, same as any other viewer. */
export function rejoin(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = loadRoomAfterSweep(db, code);
  requireSession(db, row.id, playerId, sessionSecret);
}

export function heartbeat(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);
  const state: RoomState = JSON.parse(row.state_json);
  requireSeated(state, playerId);
  recordHeartbeat(db, row.id, playerId);
}

export function setReady(
  db: Database.Database,
  code: string,
  playerId: string,
  sessionSecret: string,
  ready: boolean,
): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);
    if (state.phase !== "lobby") {
      throw new RoomError("the game has already started", "not_lobby", 409);
    }
    requireSeated(state, playerId);
    state.players[playerId].ready = ready;

    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(state),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "ready_changed", { playerId, ready });
  });
  tx();
}

/** Voluntary leave, lobby-only (a started game keeps its existing
 * disconnect-tolerant policy — no leaving mid-game). Releases the seat
 * immediately; transfers host by join order if the host left; closes the
 * room if nobody's left. */
export function leaveRoom(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version, host_player_id FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number; host_player_id: string };
    const state: RoomState = JSON.parse(fresh.state_json);
    if (state.phase !== "lobby") {
      throw new RoomError("can't leave once the game has started", "not_lobby", 409);
    }
    requireSeated(state, playerId);

    delete state.players[playerId];
    forgetPresence(db, playerId);
    logEvent(db, row.id, "player_left", { playerId });

    let hostId = fresh.host_player_id;
    let closedAt: string | null = null;
    if (hostId === playerId) {
      const next = pickNextHost(Object.values(state.players));
      if (next === null) {
        closedAt = new Date().toISOString();
        logEvent(db, row.id, "room_closed", { reason: "last player left" });
      } else {
        hostId = next;
        logEvent(db, row.id, "host_transferred", { newHostId: hostId, reason: "host left" });
      }
    }

    db.prepare(
      `UPDATE rooms SET state_json = ?, host_player_id = ?, closed_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
    ).run(JSON.stringify(state), hostId, closedAt, row.id, fresh.version);
  });
  tx();
}

/** Host-only, lobby-only, and requires an explicit confirm — this
 * destroys the room for everyone immediately, so a bare POST with no
 * confirmation marker is refused the same way a careless client-only
 * confirm dialog could be bypassed. */
export function disbandRoom(
  db: Database.Database,
  code: string,
  playerId: string,
  sessionSecret: string,
  confirm: boolean,
): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);
  if (row.host_player_id !== playerId) {
    throw new RoomError("only the host can disband the room", "not_host", 403);
  }
  if (!confirm) {
    throw new RoomError("disbanding a room needs explicit confirmation", "confirm_required", 400);
  }

  const tx = db.transaction(() => {
    const fresh = db.prepare(`SELECT state_json, version FROM rooms WHERE id = ?`).get(row.id) as {
      state_json: string;
      version: number;
    };
    const state: RoomState = JSON.parse(fresh.state_json);
    if (state.phase !== "lobby") {
      throw new RoomError("can't disband once the game has started", "not_lobby", 409);
    }
    db.prepare(`UPDATE rooms SET closed_at = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      new Date().toISOString(),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "room_disbanded", { byPlayerId: playerId });
  });
  tx();
}

/** Hands a seat to NPC control without touching its dice, winnings, or
 * place in the turn order — called internally by src/tables.ts's
 * departure enforcement once a started game's seat has been away from
 * its table long enough (CLAUDE.md's leave/exit states: "a departed
 * human's started-game seat is handed to NPC control, never deleted").
 * Not an HTTP-authenticated action — there is no human session to check;
 * the caller (server-side enforcement) already decided this seat's
 * departure earned it. Idempotent: already-NPC or already-gone is a
 * silent no-op, not an error, since enforcement can't fully serialize
 * against every other concurrent change to this room. */
export function handoffToNpc(db: Database.Database, code: string, playerId: string): void {
  const row = getRoomRow(db, code);
  if (row.closed_at) return;

  const tx = db.transaction(() => {
    const fresh = db.prepare(`SELECT state_json, version FROM rooms WHERE id = ?`).get(row.id) as {
      state_json: string;
      version: number;
    };
    const state: RoomState = JSON.parse(fresh.state_json);
    const player = state.players[playerId];
    if (!player || player.controller === "npc") return;
    player.controller = "npc";
    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(state),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "npc_takeover", { playerId });
  });
  tx();
}

/** Internal, server-scheduled turn-taking for an NPC-controlled seat —
 * never called from an HTTP handler with a client-supplied playerId:
 * there is no session to check, because the caller (src/server.ts's
 * scheduler) already decided *which* room needs a nudge, and this acts
 * on whoever `state.currentPlayerId` actually is right now. Re-checks
 * phase and controller again here, inside the same transaction, rather
 * than trusting an earlier read — state can change between the
 * scheduler's own check and this call (CLAUDE.md: a write is only
 * applied if it's still valid at commit time). Returns whether it
 * actually acted, so the caller knows whether there's anything new to
 * broadcast; a `false` return (wrong phase, no longer NPC-controlled, no
 * dice, room gone) is a silent no-op, not an error — the scheduler calls
 * this speculatively, on a timer, not in response to a specific request
 * it needs to answer. Idempotent by construction: a second call against
 * state that's already moved past `awaiting_roll` simply finds nothing
 * to do, which is what makes "never double-execute a turn" hold even if
 * the scheduler's own in-memory in-flight guard were ever bypassed (e.g.
 * by a restart mid-wait). */
export function npcRoll(db: Database.Database, code: string): boolean {
  const row = loadRoomAfterSweep(db, code);
  if (row.closed_at) return false;

  let acted = false;
  const tx = db.transaction(() => {
    const fresh = db.prepare(`SELECT state_json, version, closed_at FROM rooms WHERE id = ?`).get(row.id) as {
      state_json: string;
      version: number;
      closed_at: string | null;
    };
    if (fresh.closed_at) return;
    const state: RoomState = JSON.parse(fresh.state_json);
    if (state.phase !== "awaiting_roll" || !state.currentPlayerId) return;
    const player = state.players[state.currentPlayerId];
    if (!player || player.controller !== "npc") return;

    let next: RoomState;
    try {
      next = applyRoll(state, player.id, systemRng);
    } catch {
      return; // e.g. no dice left — shouldn't happen (findNextPlayerWithDice already skips that), but never crash the scheduler over it
    }
    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(next),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "rolled", { playerId: player.id, values: next.lastRoll?.values, controller: "npc" });
    acted = true;
  });
  tx();
  return acted;
}

/** The NPC placement counterpart to npcRoll above — same reasoning
 * throughout. Uses src/npc.ts's chooseNpcPlacement against the *already
 * rolled* values sitting in state.lastRoll; never rolls again, never
 * reads anything about the deck's future order. */
export function npcPlace(db: Database.Database, code: string): boolean {
  const row = loadRoomAfterSweep(db, code);
  if (row.closed_at) return false;

  let acted = false;
  const tx = db.transaction(() => {
    const fresh = db.prepare(`SELECT state_json, version, closed_at FROM rooms WHERE id = ?`).get(row.id) as {
      state_json: string;
      version: number;
      closed_at: string | null;
    };
    if (fresh.closed_at) return;
    const state: RoomState = JSON.parse(fresh.state_json);
    if (state.phase !== "awaiting_placement" || !state.currentPlayerId) return;
    const player = state.players[state.currentPlayerId];
    if (!player || player.controller !== "npc") return;
    if (!state.lastRoll || state.lastRoll.playerId !== player.id) return;

    const value = chooseNpcPlacement(state.lastRoll.values);
    let next: RoomState;
    try {
      next = applyPlacement(state, player.id, value);
    } catch {
      return;
    }
    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(next),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "placed", { playerId: player.id, value, controller: "npc" });
    // state.phase is already narrowed to "awaiting_placement" above, so
    // (unlike the human place() below) next.phase === "round_end" alone
    // is enough to mean "this placement is what ended it."
    if (next.phase === "round_end") {
      logEvent(db, row.id, "round_settled", {
        wonBills: Object.fromEntries(Object.values(next.players).map((p) => [p.id, p.wonBills])),
      });
    }
    acted = true;
  });
  tx();
  return acted;
}

export function startGame(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);
  if (row.host_player_id !== playerId) {
    throw new RoomError("only the host can start the game", "not_host", 403);
  }

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);

    const now = new Date();
    const seen = lastSeenTimes(db, row.id);
    const connectedPlayerIds = new Set(
      Object.values(state.players)
        .filter((p) => isConnected(seen.get(p.id) ?? p.joinedAt, now))
        .map((p) => p.id),
    );

    let next: RoomState;
    try {
      next = startGameLogic(state, systemRng, connectedPlayerIds);
    } catch (err) {
      if (err instanceof GameError) throw new RoomError(err.message, err.code, 409);
      throw err;
    }

    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(next),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "game_started", { turnOrder: next.turnOrder });
  });
  tx();
}

/** A player whose seat has been handed to NPC control (CLAUDE.md's
 * leave/exit states) keeps their session row — it's never deleted, since
 * nothing about their identity or history is erased — but that session
 * can no longer act for this seat. Checked inside roll/place themselves,
 * not just left to applyRoll/applyPlacement's own currentPlayerId check:
 * once handed off, this player's id can still legitimately be
 * `currentPlayerId` when it's genuinely this seat's turn, so the
 * ordinary "is it your turn" check alone would NOT catch a since-departed
 * human's old session trying to act for it again. */
function refuseIfNpcControlled(state: RoomState, playerId: string): void {
  if (state.players[playerId]?.controller === "npc") {
    throw new RoomError(
      "this seat is now played by the table, not your session — it was handed off after being away too long",
      "npc_controlled",
      403,
    );
  }
}

export function roll(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);
    refuseIfNpcControlled(state, playerId);

    let next: RoomState;
    try {
      next = applyRoll(state, playerId, systemRng);
    } catch (err) {
      if (err instanceof GameError) throw new RoomError(err.message, err.code, 409);
      throw err;
    }

    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(next),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "rolled", { playerId, values: next.lastRoll?.values });
  });
  tx();
}

export function place(
  db: Database.Database,
  code: string,
  playerId: string,
  sessionSecret: string,
  value: number,
): void {
  const row = loadOpenRoom(db, code);
  requireSession(db, row.id, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);
    refuseIfNpcControlled(state, playerId);

    let next: RoomState;
    try {
      next = applyPlacement(state, playerId, value);
    } catch (err) {
      if (err instanceof GameError) throw new RoomError(err.message, err.code, 409);
      throw err;
    }

    db.prepare(`UPDATE rooms SET state_json = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      JSON.stringify(next),
      row.id,
      fresh.version,
    );
    logEvent(db, row.id, "placed", { playerId, value });
    if (next.phase === "round_end" && state.phase !== "round_end") {
      logEvent(db, row.id, "round_settled", {
        wonBills: Object.fromEntries(Object.values(next.players).map((p) => [p.id, p.wonBills])),
      });
    }
  });
  tx();
}

export function getPublicState(db: Database.Database, code: string): PublicState {
  const row = loadRoomAfterSweep(db, code);
  const state: RoomState = JSON.parse(row.state_json);
  return toPublicState(db, row, state);
}

function toPublicState(db: Database.Database, row: RoomRow, state: RoomState): PublicState {
  const now = new Date();
  const seen = lastSeenTimes(db, row.id);
  return {
    code: row.code,
    hostPlayerId: row.host_player_id,
    closed: row.closed_at !== null,
    closedAt: row.closed_at,
    phase: state.phase,
    turnOrder: state.turnOrder,
    currentPlayerId: state.currentPlayerId,
    players: Object.values(state.players)
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        color: p.color,
        seat: p.seat,
        diceInHand: p.diceInHand,
        wonBills: p.wonBills,
        moneyTotal: p.wonBills.reduce((sum, b) => sum + b, 0),
        ready: p.ready,
        connected: isConnected(seen.get(p.id) ?? p.joinedAt, now),
        controller: p.controller,
      })),
    lastRoll: state.lastRoll,
    casinos: state.casinos.map((c) => ({
      value: c.value,
      bills: c.bills,
      placements: c.placements,
      payout: c.payout,
    })),
    deckSize: state.deck.length,
    version: row.version,
  };
}
