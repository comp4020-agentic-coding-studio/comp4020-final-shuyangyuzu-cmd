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
  createSoloNpcGame,
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
import type { PublicCasino } from "../src/types.ts";

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
  const first=getPublicState(db,host.code).currentPlayerId===host.playerId;
  // Actor aliases for these turn tests; first player is now server-random.
  return {code:host.code,host:first?host:guest,guest:first?guest:host};
}

it("the current-turn player's handoff lets the NPC engine roll and place legally, without double-executing", () => {
  const { code, host, guest } = startTwoPlayerGame();
  let state = getPublicState(db, code);
  expect(state.currentPlayerId).toBe(host.playerId); // helper aliases the actual first actor

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
  const actorId=getPublicState(liveDb,host.code).currentPlayerId!;
  handoffToNpc(liveDb, host.code, actorId);

  // Simulate a restart: close this connection, open a brand-new one
  // against the same file — nothing in src/server.ts's in-memory
  // scheduler state (npcTurnInFlight) carries over, which is fine and
  // expected; what must carry over is the room's own persisted state.
  liveDb.close();
  liveDb = openDb(path);

  expect(npcRoll(liveDb, host.code)).toBe(true);
  const state = getPublicState(liveDb, host.code);
  expect(state.phase).toBe("awaiting_placement");
  expect(state.players.find((p) => p.id === actorId)?.controller).toBe("npc");

  liveDb.close();
});

// A full 5-player NPC round (1 human + 4 NPCs, the new full-table default
// — src/rooms.ts's MAX_PLAYERS comment has the rulebook citation) actually
// settles correctly, exercising the real engine end to end rather than
// just the turn-taking mechanics the tests above already cover. Settles
// via alternating roll()/place() for the human seat and npcRoll()/
// npcPlace() for the 4 NPC seats, driven directly against the DB (the
// same reasoning this whole file already uses: the scheduler is a timer,
// the engine it calls isn't).
it("a full 5-player NPC round (1 human + 4 NPCs) settles correctly — every casino's payout matches the official rule", () => {
  const created = createSoloNpcGame(db, "SoloFive", "red", 4);
  let state = getPublicState(db, created.code);
  expect(state.players).toHaveLength(5);
  expect(state.players.filter((p) => p.controller === "npc")).toHaveLength(4);

  const dealtBillsByCasino = state.casinos.map((c) => c.bills);

  let guard = 0;
  while (state.phase !== "round_end") {
    if (++guard > 500) throw new Error("full 5-player NPC round: too many turns, something's stuck");
    const current = state.players.find((p) => p.id === state.currentPlayerId)!;
    if (current.controller === "npc") {
      if (state.phase === "awaiting_roll") expect(npcRoll(db, created.code)).toBe(true);
      else expect(npcPlace(db, created.code)).toBe(true);
    } else {
      if (state.phase === "awaiting_roll") {
        roll(db, created.code, current.id, created.sessionSecret);
      } else {
        const fresh = getPublicState(db, created.code);
        place(db, created.code, current.id, created.sessionSecret, fresh.lastRoll!.values[0]);
      }
    }
    state = getPublicState(db, created.code);
  }

  expect(state.phase).toBe("round_end");
  const inHand = state.players.reduce((sum, p) => sum + p.diceInHand, 0);
  const placed = state.casinos.reduce(
    (sum, c) => sum + Object.values(c.placements).reduce((s, n) => s + n, 0),
    0,
  );
  expect(inHand).toBe(0);
  expect(placed).toBe(state.players.length * 8); // every one of the 5 seats' 8 dice accounted for

  // Same settlement contract spec/settlement.test.ts's own
  // checkCasinoContract checks over HTTP — reimplemented minimally here
  // rather than imported, since that function isn't exported and this
  // file's own direct-DB style is deliberately different from that
  // file's HTTP-level one.
  function expectedRanking(placements: Record<string, number>): string[] {
    const byCount = new Map<number, string[]>();
    for (const [playerId, count] of Object.entries(placements)) {
      if (count <= 0) continue;
      const group = byCount.get(count) ?? [];
      group.push(playerId);
      byCount.set(count, group);
    }
    return [...byCount.entries()]
      .sort((a, b) => b[0] - a[0])
      .flatMap(([, group]) => (group.length === 1 ? group : []));
  }
  state.casinos.forEach((casino: PublicCasino, index) => {
    const dealtBills = dealtBillsByCasino[index];
    const ranked = expectedRanking(casino.placements);
    const sortedBills = [...dealtBills].sort((a, b) => b - a);
    const payout = casino.payout ?? {};
    for (let i = 0; i < ranked.length; i++) {
      if (i < sortedBills.length) {
        expect(payout[ranked[i]], `rank ${i} at casino ${casino.value} should win ${sortedBills[i]}`).toBe(
          sortedBills[i],
        );
      } else {
        expect(payout[ranked[i]]).toBeUndefined();
      }
    }
    expect(Object.keys(payout).length).toBeLessThanOrEqual(ranked.length);
  });
});
