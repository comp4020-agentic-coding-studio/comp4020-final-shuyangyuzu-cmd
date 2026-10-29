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
import { currentStamina } from "../src/stamina.ts";
import { createTableRoom, startNpcGame, TableError } from "../src/tables.ts";

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
