// The minimal viable NPC turn-taking engine (Crit 9 phase 8's
// production-risk fix): a departure handoff alone only flips
// `controller` — without something actually driving a handed-off seat's
// turns, a started game would simply sit turn-stalled forever. Tested
// directly against hand-built databases (like spec/tableExpiry.test.ts),
// not over HTTP: the scheduler itself is a timer in src/server.ts, but
// the engine functions it calls (rooms.npcRoll/npcPlace) are plain,
// synchronous, directly-callable functions — testing them this way is
// faster and more precise than driving a live timer.
//
// Two scenarios the student explicitly asked to see verified separately,
// not just asserted as "the same thing really": the player who departs
// is the one currently mid-turn, versus a player who departs while it's
// someone else's turn and only later becomes current.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  createRoom,
  getPublicState,
  handoffToNpc,
  joinRoom,
  npcPlace,
  npcRoll,
  place,
  RoomError,
  roll,
  setReady,
  startGame,
} from "../src/rooms.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-npc-turn-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function startTwoPlayerGame() {
  const host = createRoom(db, "Host", "red");
  const guest = joinRoom(db, host.code, "Guest", "blue");
  setReady(db, host.code, host.playerId, host.sessionSecret, true);
  setReady(db, host.code, guest.playerId, guest.sessionSecret, true);
  startGame(db, host.code, host.playerId, host.sessionSecret);
  return { code: host.code, host, guest };
}

it("the current-turn player's handoff lets the NPC engine roll and place legally, without double-executing", () => {
  const { code, host, guest } = startTwoPlayerGame();
  let state = getPublicState(db, code);
  expect(state.currentPlayerId).toBe(host.playerId); // join order -> host goes first

  handoffToNpc(db, code, host.playerId);
  state = getPublicState(db, code);
  expect(state.players.find((p) => p.id === host.playerId)?.controller).toBe("npc");
  expect(state.phase).toBe("awaiting_roll");

  expect(npcRoll(db, code)).toBe(true);
  state = getPublicState(db, code);
  expect(state.phase).toBe("awaiting_placement");
  expect(state.lastRoll?.playerId).toBe(host.playerId);
  expect(state.lastRoll!.values.length).toBeGreaterThan(0);

  // A second npcRoll call now the phase has moved on must be a no-op —
  // not a double-roll overwriting the pending one.
  const rollAgain = state.lastRoll;
  expect(npcRoll(db, code)).toBe(false);
  expect(getPublicState(db, code).lastRoll).toEqual(rollAgain);

  const diceBefore = state.players.find((p) => p.id === host.playerId)!.diceInHand;
  expect(npcPlace(db, code)).toBe(true);
  state = getPublicState(db, code);
  const hostAfter = state.players.find((p) => p.id === host.playerId)!;
  expect(hostAfter.diceInHand).toBeLessThan(diceBefore);
  // Turn order in this base game moves to the next player with dice after
  // every placement (src/game.ts's findNextPlayerWithDice) — with the
  // guest untouched and still holding all 8 dice, that's the guest.
  expect(state.currentPlayerId).toBe(guest.playerId);

  // A second npcPlace call now must also be a no-op (wrong phase and/or
  // no longer this player's turn).
  expect(npcPlace(db, code)).toBe(false);
});

it("a departure handoff mid-roll (awaiting_placement, with the NPC's own pending roll) resumes from that exact roll — never re-rolls", () => {
  const { code, host } = startTwoPlayerGame();
  roll(db, code, host.playerId, host.sessionSecret);
  const beforeHandoff = getPublicState(db, code);
  expect(beforeHandoff.phase).toBe("awaiting_placement");
  const originalRollValues = beforeHandoff.lastRoll!.values;

  handoffToNpc(db, code, host.playerId);
  // Handing off must not touch the pending roll at all.
  expect(getPublicState(db, code).lastRoll!.values).toEqual(originalRollValues);

  expect(npcPlace(db, code)).toBe(true);
  // npcRoll must never have been needed/called for this to work — the
  // placement came straight from the roll that was already there.
  const after = getPublicState(db, code);
  expect(after.lastRoll).toBeNull(); // placed and cleared, same as a human's own place() would leave it
});

it("a non-current player's handoff is flagged immediately but acted on only once it's genuinely their turn", () => {
  const { code, host, guest } = startTwoPlayerGame();
  const beforeState = getPublicState(db, code);
  expect(beforeState.currentPlayerId).toBe(host.playerId);

  // Hand off the GUEST — not who's currently up.
  handoffToNpc(db, code, guest.playerId);
  expect(getPublicState(db, code).players.find((p) => p.id === guest.playerId)?.controller).toBe("npc");

  // Nothing to do yet: it's not the guest's turn.
  expect(npcRoll(db, code)).toBe(false);
  expect(npcPlace(db, code)).toBe(false);
  expect(getPublicState(db, code).currentPlayerId).toBe(host.playerId); // unchanged

  // Drive the host's own turn to completion, as a real human would.
  roll(db, code, host.playerId, host.sessionSecret);
  const afterRoll = getPublicState(db, code);
  const value = afterRoll.lastRoll!.values[0];
  place(db, code, host.playerId, host.sessionSecret, value);

  const afterHostTurn = getPublicState(db, code);
  expect(afterHostTurn.currentPlayerId).toBe(guest.playerId); // now genuinely the NPC's turn
  expect(afterHostTurn.phase).toBe("awaiting_roll");

  // Only now does the engine have anything to do for this seat.
  expect(npcRoll(db, code)).toBe(true);
  const afterNpcRoll = getPublicState(db, code);
  expect(afterNpcRoll.lastRoll?.playerId).toBe(guest.playerId);
  expect(npcPlace(db, code)).toBe(true);
});

it("the original human's session can no longer roll or place once handed off to NPC control", () => {
  const { code, host } = startTwoPlayerGame();
  handoffToNpc(db, code, host.playerId);

  expect(() => roll(db, code, host.playerId, host.sessionSecret)).toThrow(RoomError);
  try {
    roll(db, code, host.playerId, host.sessionSecret);
  } catch (err) {
    expect((err as RoomError).code).toBe("npc_controlled");
  }

  // Let the NPC itself roll, then confirm the old human session still
  // can't place for it either.
  npcRoll(db, code);
  expect(() => place(db, code, host.playerId, host.sessionSecret, 1)).toThrow(RoomError);
});

it("npcRoll/npcPlace survive a process restart (a fresh connection to the same database)", () => {
  const path = join(dir, "restart.db");
  let liveDb = openDb(path);

  const host = createRoom(liveDb, "Host", "red");
  const guest = joinRoom(liveDb, host.code, "Guest", "blue");
  setReady(liveDb, host.code, host.playerId, host.sessionSecret, true);
  setReady(liveDb, host.code, guest.playerId, guest.sessionSecret, true);
  startGame(liveDb, host.code, host.playerId, host.sessionSecret);
  handoffToNpc(liveDb, host.code, host.playerId);

  // Simulate a restart: close this connection, open a brand-new one
  // against the same file — nothing in src/server.ts's in-memory
  // scheduler state (npcTurnInFlight) carries over, which is fine and
  // expected; what must carry over is the room's own persisted state.
  liveDb.close();
  liveDb = openDb(path);

  expect(npcRoll(liveDb, host.code)).toBe(true);
  const state = getPublicState(liveDb, host.code);
  expect(state.phase).toBe("awaiting_placement");
  expect(state.players.find((p) => p.id === host.playerId)?.controller).toBe("npc");

  liveDb.close();
});
