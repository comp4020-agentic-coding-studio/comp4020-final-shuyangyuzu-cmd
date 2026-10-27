// The reversible "temporary NPC standby vs self control" away-choice
// (CLAUDE.md), distinct from controller's own one-way permanent handoff.
// Direct-DB tests, same pattern as spec/npcTurn.test.ts: the scheduler
// itself is a timer in src/server.ts, but the engine functions it calls
// (rooms.npcRoll/npcPlace) are plain, synchronous, directly-callable
// functions — testing them this way is faster and more precise than
// driving a live timer.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  createRoom,
  departChoice,
  getPublicState,
  handoffToNpc,
  joinRoom,
  npcPlace,
  npcRoll,
  place,
  resumeGame,
  roll,
  RoomError,
  setReady,
  startGame,
} from "../src/rooms.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-awaymode-test-"));
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
  const first = getPublicState(db, host.code).currentPlayerId === host.playerId;
  return { code: host.code, host: first ? host : guest, guest: first ? guest : host };
}

it("choosing NPC standby lets the scheduler's engine take this seat's turns, without flipping controller", () => {
  const { code, host } = startTwoPlayerGame();
  departChoice(db, code, host.playerId, host.sessionSecret, "npc");
  let state = getPublicState(db, code);
  const me = state.players.find((p) => p.id === host.playerId)!;
  expect(me.awayMode).toBe("npc");
  expect(me.controller).toBe("human"); // never flips controller — reversible

  expect(npcRoll(db, code)).toBe(true);
  state = getPublicState(db, code);
  expect(state.lastRoll?.playerId).toBe(host.playerId);
  expect(npcPlace(db, code)).toBe(true);
});

it("choosing self-control means no scheduler action occurs across multiple ticks — the original session still acts normally", () => {
  const { code, host } = startTwoPlayerGame();
  departChoice(db, code, host.playerId, host.sessionSecret, "self");
  const me = getPublicState(db, code).players.find((p) => p.id === host.playerId)!;
  expect(me.awayMode).toBe("self");

  // The engine must never act for this seat while awayMode is "self" —
  // checked across several speculative ticks, same as the scheduler
  // would call it.
  expect(npcRoll(db, code)).toBe(false);
  expect(npcPlace(db, code)).toBe(false);
  expect(npcRoll(db, code)).toBe(false);

  // The original human session still acts normally — nothing about
  // "self" mode changes who may act via the ordinary endpoints.
  roll(db, code, host.playerId, host.sessionSecret);
  const afterRoll = getPublicState(db, code);
  expect(afterRoll.lastRoll?.playerId).toBe(host.playerId);
  place(db, code, host.playerId, host.sessionSecret, afterRoll.lastRoll!.values[0]);
});

it("resuming clears awayMode and hands control back to the ordinary roll/place endpoints", () => {
  const { code, host } = startTwoPlayerGame();
  departChoice(db, code, host.playerId, host.sessionSecret, "npc");
  expect(getPublicState(db, code).players.find((p) => p.id === host.playerId)?.awayMode).toBe("npc");

  resumeGame(db, code, host.playerId, host.sessionSecret);
  const state = getPublicState(db, code);
  expect(state.players.find((p) => p.id === host.playerId)?.awayMode).toBeNull();

  // The scheduler must no longer act for this seat once resumed.
  expect(npcRoll(db, code)).toBe(false);
  // The human session can act normally again.
  roll(db, code, host.playerId, host.sessionSecret);
  expect(getPublicState(db, code).lastRoll?.playerId).toBe(host.playerId);
});

it("a resume racing an already-scheduled-but-undelivered NPC turn wins: the re-check at execution time declines to act", () => {
  const { code, host } = startTwoPlayerGame();
  departChoice(db, code, host.playerId, host.sessionSecret, "npc");

  // Simulate the scheduler's own captured state being stale by resuming
  // control BEFORE the delayed npcRoll call actually executes — it must
  // re-read fresh state and decline, never trusting what was true when
  // it was scheduled.
  resumeGame(db, code, host.playerId, host.sessionSecret);
  expect(npcRoll(db, code)).toBe(false);

  // The human's own session, not the engine, is what moves the game now.
  roll(db, code, host.playerId, host.sessionSecret);
  expect(getPublicState(db, code).lastRoll?.playerId).toBe(host.playerId);
});

it("a forged/wrong-session resume attempt is refused", () => {
  const { code, host } = startTwoPlayerGame();
  departChoice(db, code, host.playerId, host.sessionSecret, "npc");
  expect(() => resumeGame(db, code, host.playerId, "wrong-secret")).toThrow(RoomError);
  // Still away — the forged attempt didn't clear anything.
  expect(getPublicState(db, code).players.find((p) => p.id === host.playerId)?.awayMode).toBe("npc");
});

it("depart-choice refuses an invalid mode", () => {
  const { code, host } = startTwoPlayerGame();
  expect(() => departChoice(db, code, host.playerId, host.sessionSecret, "something-else")).toThrow(RoomError);
  try {
    departChoice(db, code, host.playerId, host.sessionSecret, "something-else");
  } catch (err) {
    expect((err as RoomError).code).toBe("bad_mode");
  }
});

it("the three-minute clock is unaffected by which away mode was chosen — either one still ends in permanent handoff via the existing path", () => {
  const { code, host } = startTwoPlayerGame();
  departChoice(db, code, host.playerId, host.sessionSecret, "npc");
  // Simulate the existing three-minute sweep's own action — handoffToNpc
  // is the exact function enforceExpiredDepartures already calls once a
  // departure crosses the threshold; this phase adds no second timer.
  handoffToNpc(db, code, host.playerId);
  const state = getPublicState(db, code);
  expect(state.players.find((p) => p.id === host.playerId)?.controller).toBe("npc");
});

it("a fresh page cannot use depart-choice to take back an already-permanently-handed-off seat", () => {
  const { code, host } = startTwoPlayerGame();
  handoffToNpc(db, code, host.playerId);
  expect(() => departChoice(db, code, host.playerId, host.sessionSecret, "self")).toThrow(RoomError);
  try {
    departChoice(db, code, host.playerId, host.sessionSecret, "self");
  } catch (err) {
    expect((err as RoomError).code).toBe("npc_controlled");
  }
});

it("awayMode defaults to null for every freshly created or joined player", () => {
  const { code, host, guest } = startTwoPlayerGame();
  const state = getPublicState(db, code);
  expect(state.players.find((p) => p.id === host.playerId)?.awayMode).toBeNull();
  expect(state.players.find((p) => p.id === guest.playerId)?.awayMode).toBeNull();
});
