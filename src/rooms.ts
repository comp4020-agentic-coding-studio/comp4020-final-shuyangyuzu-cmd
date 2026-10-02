// Room lifecycle and the HTTP-facing wrapper around src/game.ts's pure
// turn engine: this is where authentication, the DB transaction, and
// public-response sanitization live. See CLAUDE.md for why each of those
// is non-negotiable.

import type Database from "better-sqlite3";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { freshDeck } from "./deck.ts";
import { applyPlacement, applyRoll, GameError, startGame as startGameLogic } from "./game.ts";
import { systemRng } from "./rng.ts";
import { COLORS, type Color, type PublicState, type RoomState } from "./types.ts";

// Excludes 0/O, 1/I/L — characters that are easy to mis-type or mis-read
// aloud when a room code is being passed around a table.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const MAX_PLAYERS = 4;

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
    logEvent(db, roomId, "room_created", { playerId, nickname: trimmed, color });
  });
  tx();

  return { code, playerId, sessionSecret };
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
  state_json: string;
  version: number;
}

function getRoomRow(db: Database.Database, code: string): RoomRow {
  const row = db
    .prepare(`SELECT id, code, host_player_id, state_json, version FROM rooms WHERE code = ?`)
    .get(code.toUpperCase()) as RoomRow | undefined;
  if (!row) throw new RoomError("no such room", "room_not_found", 404);
  return row;
}

function requireSession(db: Database.Database, roomId: string, playerId: string, sessionSecret: string): void {
  const row = db
    .prepare(`SELECT session_secret FROM sessions WHERE player_id = ? AND room_id = ?`)
    .get(playerId, roomId) as { session_secret: string } | undefined;
  if (!row || row.session_secret !== sessionSecret) {
    throw new RoomError("not authorized for this player in this room", "unauthorized", 403);
  }
}

export interface JoinedRoom {
  playerId: string;
  sessionSecret: string;
}

export function joinRoom(
  db: Database.Database,
  code: string,
  nickname: string,
  color: Color,
): JoinedRoom {
  const trimmed = nickname.trim();
  if (!trimmed) throw new RoomError("nickname is required", "nickname_required", 400);
  if (!COLORS.includes(color)) throw new RoomError("not a valid color", "bad_color", 400);

  const row = getRoomRow(db, code);
  const playerId = randomUUID();
  const sessionSecret = newSessionSecret();

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
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

    state.players[playerId] = {
      id: playerId,
      nickname: trimmed,
      color,
      seat: existing.length,
      diceInHand: 0,
      wonBills: [],
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
    logEvent(db, row.id, "player_joined", { playerId, nickname: trimmed, color });
  });
  tx();

  return { playerId, sessionSecret };
}

/** Confirms a returning player's identity; the state itself is fetched
 * separately via getPublicState (rejoining doesn't need its own view of
 * the state — there's no hidden information in this game). */
export function rejoin(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = getRoomRow(db, code);
  requireSession(db, row.id, playerId, sessionSecret);
}

export function startGame(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = getRoomRow(db, code);
  requireSession(db, row.id, playerId, sessionSecret);
  if (row.host_player_id !== playerId) {
    throw new RoomError("only the host can start the game", "not_host", 403);
  }

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);

    let next: RoomState;
    try {
      next = startGameLogic(state, systemRng);
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

export function roll(db: Database.Database, code: string, playerId: string, sessionSecret: string): void {
  const row = getRoomRow(db, code);
  requireSession(db, row.id, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);

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
  const row = getRoomRow(db, code);
  requireSession(db, row.id, playerId, sessionSecret);

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT state_json, version FROM rooms WHERE id = ?`)
      .get(row.id) as { state_json: string; version: number };
    const state: RoomState = JSON.parse(fresh.state_json);

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
      logEvent(db, row.id, "round_settled", { wonBills: Object.fromEntries(
        Object.values(next.players).map((p) => [p.id, p.wonBills]),
      ) });
    }
  });
  tx();
}

export function getPublicState(db: Database.Database, code: string): PublicState {
  const row = getRoomRow(db, code);
  const state: RoomState = JSON.parse(row.state_json);
  return toPublicState(row.code, row.host_player_id, row.version, state);
}

function toPublicState(code: string, hostPlayerId: string, version: number, state: RoomState): PublicState {
  return {
    code,
    hostPlayerId,
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
      })),
    lastRoll: state.lastRoll,
    casinos: state.casinos.map((c) => ({ value: c.value, bills: c.bills, placements: c.placements })),
    deckSize: state.deck.length,
    version,
  };
}
