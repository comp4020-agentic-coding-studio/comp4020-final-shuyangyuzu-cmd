// Seated eating/drinking's own server lifecycle (CLAUDE.md's "Seated
// eating and drinking" section): src/orders.ts's startEating,
// src/eating.ts's lock, and the standing/seated/game-join gates it
// drives in src/bar.ts and src/tables.ts. Direct-DB tests, same pattern
// as spec/orders.test.ts and spec/barSeats.test.ts — exact control over
// both the stamina/held-item state and the lock's own timestamps,
// without waiting out a real 8-second window or walking a patron there
// tile by tile over HTTP.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BarError, getPublicBarState, joinBar, moveBar, sitAtSeat, standFromSeat } from "../src/bar.ts";
import { BAR_SEATS, GAME_CHAIRS } from "../src/barLayout.ts";
import { openDb } from "../src/db.ts";
import { EATING_DURATION_MS, isEating } from "../src/eating.ts";
import { OrderError, placeOrder, startEating } from "../src/orders.ts";
import { RoomError, approveJoin, getPublicState, place, resumeGame, roll, setReady, startGame } from "../src/rooms.ts";
import { currentStamina } from "../src/stamina.ts";
import { createTableRoom, joinTableRoom, resumeActiveTable, startNpcGame, TableError } from "../src/tables.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-eating-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function placeAt(playerId: string, x: number, y: number): void {
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(x, y, playerId);
}

function seatPlayer(playerId: string, sessionSecret: string, seatIndex = 0): { id: string; x: number; y: number } {
  const seat = BAR_SEATS[seatIndex];
  placeAt(playerId, seat.x, seat.y + 1);
  sitAtSeat(db, playerId, sessionSecret, seat.id);
  return seat;
}

function catchOrderError(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrderError) return err;
    throw err;
  }
  throw new Error("expected an OrderError, nothing was thrown");
}

it("standing consumption is refused — holding food/drink while standing is not enough to eat it", () => {
  const p = joinBar(db, "Standing", "red", "warm");
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-1");
  const err = catchOrderError(() => startEating(db, p.playerId, p.sessionSecret, "eat-key-1"));
  expect(err.code).toBe("not_seated");
  // Nothing was consumed and no stamina changed.
  expect(currentStamina(db, p.playerId)).toBeCloseTo(80, 1);
});

it("a dining/stool seat is enough to eat — a game table's own chair is not a dining seat", () => {
  const p = joinBar(db, "Diner", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-1");
  const action = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");
  expect(action.kinds).toEqual(["drink"]);
  expect(isEating(db, p.playerId)).toBe(true);
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2); // 80 + 30
});

it("sitting at a Vegas game chair never counts as a dining seat", () => {
  // Game chairs are never rows in bar_seats at all (src/barLayout.ts) —
  // a patron merely standing at that tile (not "sitting" in the bar's
  // own sense) still has no bar_seats row, so startEating must refuse.
  const p = joinBar(db, "Gamer", "red", "warm");
  const chair = GAME_CHAIRS[0];
  placeAt(p.playerId, chair.x, chair.y);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-1");
  const err = catchOrderError(() => startEating(db, p.playerId, p.sessionSecret, "eat-key-1"));
  expect(err.code).toBe("not_seated");
});

it("refuses to start eating with nothing held", () => {
  const p = joinBar(db, "Empty", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  const err = catchOrderError(() => startEating(db, p.playerId, p.sessionSecret, "eat-key-1"));
  expect(err.code).toBe("nothing_held");
});

it("a single held meal plays only the meal action, a single drink only the drink action", () => {
  const meal = joinBar(db, "Meal Only", "red", "warm");
  seatPlayer(meal.playerId, meal.sessionSecret);
  placeOrder(db, meal.playerId, meal.sessionSecret, "grilled-trout", null, "k1");
  expect(startEating(db, meal.playerId, meal.sessionSecret, "e1").kinds).toEqual(["meal"]);

  const drink = joinBar(db, "Drink Only", "blue", "warm");
  seatPlayer(drink.playerId, drink.sessionSecret, 1);
  placeOrder(db, drink.playerId, drink.sessionSecret, "soda", null, "k2");
  expect(startEating(db, drink.playerId, drink.sessionSecret, "e2").kinds).toEqual(["drink"]);
});

it("holding both a meal and a drink starts a combined action, meal before drink, and restores both", () => {
  const p = joinBar(db, "Both", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "k-meal");
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k-drink");
  const action = startEating(db, p.playerId, p.sessionSecret, "e1");
  expect(action.kinds).toEqual(["meal", "drink"]);
  // 80 -> +70 (clamped 100) -> +30 (still clamped 100)
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2);
  const held = db.prepare(`SELECT state FROM held_items WHERE player_id = ?`).all(p.playerId) as { state: string }[];
  expect(held.every((h) => h.state === "consumed")).toBe(true);
});

it("a retried start with the same idempotency key is a no-op, not a second restore or a restarted clock", () => {
  const p = joinBar(db, "Retry", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k1");
  const first = startEating(db, p.playerId, p.sessionSecret, "same-eat-key");
  const staminaAfterFirst = currentStamina(db, p.playerId);
  const second = startEating(db, p.playerId, p.sessionSecret, "same-eat-key");
  expect(second.startedAt).toBe(first.startedAt);
  expect(second.endsAt).toBe(first.endsAt);
  expect(currentStamina(db, p.playerId)).toBeLessThanOrEqual(staminaAfterFirst); // no second +30
});

it("a different idempotency key while already eating is refused outright, not a second action", () => {
  const p = joinBar(db, "Double Order", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k1");
  startEating(db, p.playerId, p.sessionSecret, "key-a");
  const err = catchOrderError(() => startEating(db, p.playerId, p.sessionSecret, "key-b"));
  expect(err.code).toBe("eating_active");
});

it("while eating: moving, standing, ordering again, and starting a game are all refused", () => {
  const p = joinBar(db, "Locked", "red", "warm");
  const seat = seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k1");
  startEating(db, p.playerId, p.sessionSecret, "e1");

  expect(() => moveBar(db, p.playerId, p.sessionSecret, seat.x, seat.y + 1)).toThrow(BarError);
  expect(() => standFromSeat(db, p.playerId, p.sessionSecret)).toThrow(BarError);
  expect(() => placeOrder(db, p.playerId, p.sessionSecret, "coffee", null, "k2")).toThrow(OrderError);
  expect(() => createTableRoom(db, "vegas-1", p.playerId, p.sessionSecret, "red")).toThrow(TableError);
  expect(() => startNpcGame(db, "vegas-npc-1", p.playerId, p.sessionSecret, "red", 2)).toThrow(TableError);
});

it("the lock expires naturally after its own duration, unlocking every gated action again", () => {
  const p = joinBar(db, "Expires", "red", "warm");
  const seat = seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k1");
  startEating(db, p.playerId, p.sessionSecret, "e1");
  expect(isEating(db, p.playerId)).toBe(true);

  const later = new Date(Date.now() + EATING_DURATION_MS + 1000);
  expect(isEating(db, p.playerId, later)).toBe(false);
  // standFromSeat/moveBar both default `now` internally to a real clock,
  // so simulate real passage of time having already occurred by writing
  // the lock row's own ends_at into the past directly — exercising the
  // exact same lazy-expiry read every other call site performs.
  db.prepare(`UPDATE bar_eating_actions SET ends_at = ? WHERE player_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    p.playerId,
  );
  expect(() => standFromSeat(db, p.playerId, p.sessionSecret)).not.toThrow();
  const after = getPublicBarState(db).players.find((x) => x.id === p.playerId)!;
  expect(after.seatId).toBeNull();
});

it("a refresh/reconnect recovers the lock from server state — no client 'I'm done' call required", () => {
  const p = joinBar(db, "Refreshed", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k1");
  const action = startEating(db, p.playerId, p.sessionSecret, "e1");
  // Simulate a server restart / a completely fresh read with no in-
  // memory state at all: isEating/currentEatingAction are pure reads of
  // the persisted row plus the current wall clock, nothing cached.
  expect(isEating(db, p.playerId)).toBe(true);
  const stillActive = new Date(new Date(action.endsAt).getTime() - 500);
  expect(isEating(db, p.playerId, stillActive)).toBe(true);
  const pastEnd = new Date(new Date(action.endsAt).getTime() + 500);
  expect(isEating(db, p.playerId, pastEnd)).toBe(false);
});

it("public bar state reports holding (kind-only) and eating status for every online player, not just the actor", () => {
  const a = joinBar(db, "Alice", "red", "warm");
  const b = joinBar(db, "Bob", "blue", "warm");
  placeOrder(db, a.playerId, a.sessionSecret, "grilled-trout", null, "k1");
  seatPlayer(a.playerId, a.sessionSecret);
  startEating(db, a.playerId, a.sessionSecret, "e1");

  const state = getPublicBarState(db);
  const alice = state.players.find((p) => p.id === a.playerId)!;
  const bob = state.players.find((p) => p.id === b.playerId)!;
  expect(alice.eating?.kinds).toEqual(["meal"]);
  expect(alice.holding).toEqual({ meal: false, drink: false }); // consumed already, no longer "held"
  expect(bob.eating).toBeNull();
  expect(bob.holding).toEqual({ meal: false, drink: false });
});

it("public holding status reflects a currently-held (not yet eaten) item for a standing patron", () => {
  const p = joinBar(db, "Holding Only", "red", "warm");
  placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "k1");
  const state = getPublicBarState(db);
  const mine = state.players.find((x) => x.id === p.playerId)!;
  expect(mine.holding).toEqual({ meal: true, drink: false });
  expect(mine.eating).toBeNull();
});

it("refuses a wrong session secret for starting to eat", () => {
  const p = joinBar(db, "Wrong Secret", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k1");
  expect(() => startEating(db, p.playerId, "wrong-secret", "e1")).toThrow();
});

// ---- Regression: Codex reproduced this directly (2026-11 review) ----
//
// startEating's idempotency check only ever looked at activeEatingRow's
// own `active` flag — true only while `ends_at > now`. Once the lock had
// naturally expired, a retried request carrying the FIRST action's own
// idempotency key fell straight through to the ordinary "start a new
// action" path, which collects whatever is CURRENTLY held — including an
// item ordered after the first action already finished — and consumes
// it, restoring stamina again and restarting the 8-second clock. A
// network retry of the first "eat" request arriving late (after the
// animation had already finished and the player had ordered something
// new) would therefore silently eat/drink the NEW item and replay the
// cutscene, never touching the original request's own already-settled
// item at all.
it("retrying the FIRST eat request after its lock naturally expired must not consume a newly-ordered item or restart the clock (Codex-reproduced)", () => {
  const p = joinBar(db, "Retry After Expiry", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  const firstDrink = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k-drink-1");
  const first = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");
  expect(first.kinds).toEqual(["drink"]);

  // The 8-second window has genuinely passed — the same lazy-expiry
  // simulation spec/eating.test.ts's own "the lock expires naturally"
  // case above already uses.
  db.prepare(`UPDATE bar_eating_actions SET ends_at = ? WHERE player_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    p.playerId,
  );
  expect(isEating(db, p.playerId)).toBe(false);

  // The player orders something new in the meantime.
  const secondDrink = placeOrder(db, p.playerId, p.sessionSecret, "coffee", null, "k-drink-2");
  const staminaBeforeRetry = currentStamina(db, p.playerId);

  // A delayed/duplicated network retry of the ORIGINAL request arrives.
  const retried = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");

  // Must return the original action's own result, unchanged — never a
  // freshly-started one.
  expect(retried.startedAt).toBe(first.startedAt);
  expect(retried.endsAt).toBe(first.endsAt);
  expect(retried.kinds).toEqual(first.kinds);

  // The newly-ordered coffee must still be sitting there, untouched.
  const secondRow = db.prepare(`SELECT state FROM held_items WHERE id = ?`).get(secondDrink.id) as { state: string };
  expect(secondRow.state).toBe("held");

  // No second restore happened.
  expect(currentStamina(db, p.playerId)).toBeCloseTo(staminaBeforeRetry, 2);

  // The original drink's own row is unaffected by the retry (still
  // exactly as consumed as it already was).
  const firstRow = db.prepare(`SELECT state FROM held_items WHERE id = ?`).get(firstDrink.id) as { state: string };
  expect(firstRow.state).toBe("consumed");
});

it("retrying the FIRST eat request survives the lock row no longer existing at all (e.g. a fresh db reopen) and still returns the original result, never a second consume", () => {
  const p = joinBar(db, "Retry After Reopen", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k-drink-1");
  const first = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");

  // Expire the lock, then actually delete the row outright — simulating
  // a sweep/restart scenario where nothing short-lived survives, only the
  // already-committed held_items/stamina state (which is the real
  // "nothing pending to lose" guarantee src/eating.ts's own header
  // describes) and whatever durable record of the request itself exists.
  db.prepare(`DELETE FROM bar_eating_actions WHERE player_id = ?`).run(p.playerId);
  const newDrink = placeOrder(db, p.playerId, p.sessionSecret, "coffee", null, "k-drink-2");
  const staminaBefore = currentStamina(db, p.playerId);

  const retried = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");
  expect(retried.startedAt).toBe(first.startedAt);
  expect(retried.endsAt).toBe(first.endsAt);

  const row = db.prepare(`SELECT state FROM held_items WHERE id = ?`).get(newDrink.id) as { state: string };
  expect(row.state).toBe("held");
  expect(currentStamina(db, p.playerId)).toBeCloseTo(staminaBefore, 2);
});

it("a retried eat request after an actual process restart (the db file closed and reopened) still returns the original result, never a second consume", () => {
  const dbPath = join(dir, "vegas.db");
  const p = joinBar(db, "Real Reopen", "red", "warm");
  seatPlayer(p.playerId, p.sessionSecret);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "k-drink-1");
  const first = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");
  db.prepare(`UPDATE bar_eating_actions SET ends_at = ? WHERE player_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    p.playerId,
  );

  // A genuine process restart: close this connection entirely and open a
  // fresh one against the same file on disk, the same way openDb() runs
  // on every real server start — exercising the actual migration path
  // (bar_eating_requests must already exist, or be created, on this
  // reopen) rather than just the in-process row deletion above.
  db.close();
  db = openDb(dbPath);

  const newDrink = placeOrder(db, p.playerId, p.sessionSecret, "coffee", null, "k-drink-2");
  const staminaBefore = currentStamina(db, p.playerId);

  const retried = startEating(db, p.playerId, p.sessionSecret, "eat-key-1");
  expect(retried.startedAt).toBe(first.startedAt);
  expect(retried.endsAt).toBe(first.endsAt);
  expect(retried.kinds).toEqual(["drink"]);

  const row = db.prepare(`SELECT state FROM held_items WHERE id = ?`).get(newDrink.id) as { state: string };
  expect(row.state).toBe("held");
  expect(currentStamina(db, p.playerId)).toBeCloseTo(staminaBefore, 2);
});

it("a genuinely different player's identical idempotency key is isolated — never returns or affects another player's eating action", () => {
  const a = joinBar(db, "Key Isolation A", "red", "warm");
  const b = joinBar(db, "Key Isolation B", "blue", "warm");
  seatPlayer(a.playerId, a.sessionSecret, 0);
  seatPlayer(b.playerId, b.sessionSecret, 1);
  placeOrder(db, a.playerId, a.sessionSecret, "soda", null, "k-a");
  placeOrder(db, b.playerId, b.sessionSecret, "coffee", null, "k-b");

  const sharedKey = "shared-key-collision";
  const aAction = startEating(db, a.playerId, a.sessionSecret, sharedKey);
  const bAction = startEating(db, b.playerId, b.sessionSecret, sharedKey);

  // Each identity's own action is independent — the same literal key
  // string used by two different players must never cross-return or
  // cross-affect the other's result.
  expect(aAction.kinds).toEqual(["drink"]);
  expect(bAction.kinds).toEqual(["drink"]);
  expect(isEating(db, a.playerId)).toBe(true);
  expect(isEating(db, b.playerId)).toBe(true);
  const aHeld = db.prepare(`SELECT state FROM held_items WHERE player_id = ?`).all(a.playerId) as { state: string }[];
  const bHeld = db.prepare(`SELECT state FROM held_items WHERE player_id = ?`).all(b.playerId) as { state: string }[];
  expect(aHeld.every((h) => h.state === "consumed")).toBe(true);
  expect(bHeld.every((h) => h.state === "consumed")).toBe(true);
});

// ---- Regression: multi-tab/existing-game actions during an eating lock
// (Codex review, 2026-11) ----
//
// A bar identity who already has a started Vegas game bound to them
// (current_table_id/current_game_player_id) can genuinely be away from
// that table — sitting at a real dining/stool seat — while the room's own
// game session (a second browser tab, kept open the whole time) is still
// perfectly valid and never itself checked isEating. createTableRoom/
// joinTableRoom/startNpcGame already refuse a NEW game while eating, but
// that only guards the "start/join something" entry points — it says
// nothing about acting on a game this identity is ALREADY bound to.
// Before this fix, rooms.roll/place/resumeGame had no isEating check of
// their own at all, so the second tab's room session could roll, place,
// or explicitly resume the table right through an active eating lock.
function startedTwoPlayerGame() {
  const host = joinBar(db, "Eating Host", "red", "warm");
  const created = createTableRoom(db, "vegas-1", host.playerId, host.sessionSecret, "red");
  const guestBar = joinBar(db, "Eating Guest", "blue", "warm");
  const guest = joinTableRoom(db, "vegas-1", guestBar.playerId, guestBar.sessionSecret, "yellow");
  approveJoin(db, created.code, created.playerId, created.sessionSecret, guest.playerId);
  setReady(db, created.code, created.playerId, created.sessionSecret, true);
  setReady(db, created.code, guest.playerId, guest.sessionSecret, true);
  startGame(db, created.code, created.playerId, created.sessionSecret);
  return { host, created, guestBar, guest };
}

// The server randomly chooses round 1's starting player (CLAUDE.md:
// "Round 1 chooses its starter using server RNG"), so these tests work
// out which of host/guest's own ROOM player ids actually holds the turn
// and gate that SAME bar identity, rather than assuming it's always the
// host — a test that just always picked the host would silently pass for
// the wrong reason half the time (gating a player who was never going to
// act anyway) instead of actually exercising the bug.
function roomAndBarSessionFor(
  roomPlayerId: string,
  host: { playerId: string; sessionSecret: string },
  bar: { host: { playerId: string; sessionSecret: string }; guestBar: { playerId: string; sessionSecret: string } },
  guest: { playerId: string; sessionSecret: string },
) {
  const isHost = roomPlayerId === host.playerId;
  return {
    room: isHost ? host : guest,
    bar: isHost ? bar.host : bar.guestBar,
  };
}

it("rolling for an existing, already-started game is refused while this identity's eating lock is active (multi-tab)", () => {
  const { host, created, guestBar, guest } = startedTwoPlayerGame();
  const starting = getPublicState(db, created.code).currentPlayerId!;
  const { room, bar } = roomAndBarSessionFor(starting, created, { host, guestBar }, guest);

  // Whichever bar identity actually holds the current turn walks back to
  // the bar (a separate tab/view from the room session above) and sits
  // down to eat — the room session itself is untouched, exactly like a
  // second open tab would be.
  seatPlayer(bar.playerId, bar.sessionSecret);
  placeOrder(db, bar.playerId, bar.sessionSecret, "soda", null, "k1");
  startEating(db, bar.playerId, bar.sessionSecret, "eat-key-1");
  expect(isEating(db, bar.playerId)).toBe(true);

  expect(() => roll(db, created.code, room.playerId, room.sessionSecret)).toThrow(RoomError);
  const after = getPublicState(db, created.code);
  expect(after.lastRoll).toBeNull(); // nothing actually rolled
});

it("placing for an existing, already-started game is refused while this identity's eating lock is active (multi-tab)", () => {
  const { host, created, guestBar, guest } = startedTwoPlayerGame();
  const starting = getPublicState(db, created.code).currentPlayerId!;
  const { room, bar } = roomAndBarSessionFor(starting, created, { host, guestBar }, guest);

  // Roll for real first (before eating starts) so there's a legal value
  // to place, isolating this test to the `place` gate specifically.
  roll(db, created.code, room.playerId, room.sessionSecret);
  const rolled = getPublicState(db, created.code);
  const value = rolled.lastRoll!.values[0];

  seatPlayer(bar.playerId, bar.sessionSecret);
  placeOrder(db, bar.playerId, bar.sessionSecret, "soda", null, "k1");
  startEating(db, bar.playerId, bar.sessionSecret, "eat-key-1");

  expect(() => place(db, created.code, room.playerId, room.sessionSecret, value)).toThrow(RoomError);
  const after = getPublicState(db, created.code);
  expect(after.currentPlayerId).toBe(starting); // the turn never actually advanced
});

it("explicitly resuming an existing table binding (tables.resumeActiveTable / rooms.resumeGame) is refused while eating", () => {
  const { host, created } = startedTwoPlayerGame();

  // Step away physically (starts the 3-minute away-from-table clock) —
  // this is the actual precondition for "Return to your game"/resume to
  // have anything to do.
  seatPlayer(host.playerId, host.sessionSecret);
  const departureBefore = db.prepare(`SELECT 1 FROM table_departures WHERE bar_player_id = ?`).get(host.playerId);
  expect(departureBefore).toBeTruthy();

  placeOrder(db, host.playerId, host.sessionSecret, "soda", null, "k1");
  startEating(db, host.playerId, host.sessionSecret, "eat-key-1");

  // The bar-level "I'm actually back" action must not silently succeed
  // and clear the departure/resume the game while the eating lock is
  // active — it's exactly the kind of "other entry point back into the
  // game" the standing instruction asks to be covered, not just the
  // literal join/create table routes.
  expect(() => resumeActiveTable(db, host.playerId, host.sessionSecret)).toThrow(TableError);
  const departureAfter = db.prepare(`SELECT 1 FROM table_departures WHERE bar_player_id = ?`).get(host.playerId);
  expect(departureAfter).toBeTruthy(); // never cleared

  // The lower-level rooms.resumeGame, as the room session's own tab might
  // call it directly, must independently refuse too.
  expect(() => resumeGame(db, created.code, created.playerId, created.sessionSecret)).toThrow(RoomError);
});

// ---- Regression: rooms.startGame itself lacked the eating guard
// (Codex-found/reproduced, 2026-11-04 independent review) ----
//
// createTableRoom/joinTableRoom/startNpcGame refuse to seat someone new
// while eating, and roll/place/resumeGame (above) refuse to act on an
// ALREADY-STARTED game while eating — but a lobby that is fully ready
// and waiting to start is neither of those: the host's own still-valid
// room session (a second open tab) could call startGame while physically
// seated and mid an eating/drinking lock, flipping the room straight from
// "lobby" to "awaiting_roll" with the lock still active. Reproduced
// directly before the fix: {eating:true, before:"lobby",
// startResult:"accepted", after:"awaiting_roll"}.
it("starting an already-ready lobby is refused while the host's eating lock is active, and succeeds once it ends", () => {
  const host = joinBar(db, "Eating Host", "red", "warm");
  const created = createTableRoom(db, "vegas-1", host.playerId, host.sessionSecret, "red");
  const guestBar = joinBar(db, "Eating Guest", "blue", "warm");
  const guest = joinTableRoom(db, "vegas-1", guestBar.playerId, guestBar.sessionSecret, "yellow");
  approveJoin(db, created.code, created.playerId, created.sessionSecret, guest.playerId);
  setReady(db, created.code, created.playerId, created.sessionSecret, true);
  setReady(db, created.code, guest.playerId, guest.sessionSecret, true);

  expect(getPublicState(db, created.code).phase).toBe("lobby");

  seatPlayer(host.playerId, host.sessionSecret);
  placeOrder(db, host.playerId, host.sessionSecret, "soda", null, "k1");
  const action = startEating(db, host.playerId, host.sessionSecret, "eat-key-1");
  expect(isEating(db, host.playerId)).toBe(true);

  expect(() => startGame(db, created.code, created.playerId, created.sessionSecret)).toThrow(RoomError);
  expect(getPublicState(db, created.code).phase).toBe("lobby"); // unchanged

  // Once the lock naturally expires, the exact same start request succeeds.
  db.prepare(`UPDATE bar_eating_actions SET ends_at = ? WHERE player_id = ?`).run(
    new Date(action.startedAt).toISOString(),
    host.playerId,
  );
  expect(isEating(db, host.playerId)).toBe(false);
  startGame(db, created.code, created.playerId, created.sessionSecret);
  expect(getPublicState(db, created.code).phase).toBe("awaiting_roll");
});
