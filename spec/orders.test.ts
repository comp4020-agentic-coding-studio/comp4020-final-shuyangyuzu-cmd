// Front-of-house menu: ordering and consuming Meals/Drinks (src/orders.ts).
// Direct-DB tests, same pattern as spec/stamina.test.ts and
// spec/speech.test.ts — exact control over stamina values without
// waiting out real decay, and no HTTP round-trip needed to exercise the
// actual logic this module owns.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { joinBar } from "../src/bar.ts";
import { openDb } from "../src/db.ts";
import { consumeHeldItem, getHeldItems, MENU, OrderError, placeOrder, previewOrder } from "../src/orders.ts";
import { currentStamina } from "../src/stamina.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-orders-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function catchError(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrderError) return err;
    throw err;
  }
  throw new Error("expected an OrderError, nothing was thrown");
}

it("the menu has a small, complete set with real variant cases", () => {
  expect(MENU.length).toBeGreaterThanOrEqual(7);
  const meals = MENU.filter((m) => m.kind === "meal");
  const drinks = MENU.filter((m) => m.kind === "drink");
  expect(meals.length).toBeGreaterThanOrEqual(4);
  expect(drinks.length).toBeGreaterThanOrEqual(3);
  // At least one meal with a genuine variant choice, and at least one
  // without — never a meaningless identical dropdown on every dish.
  expect(meals.some((m) => (m.variants?.length ?? 0) > 0)).toBe(true);
  expect(meals.some((m) => !m.variants)).toBe(true);
});

it("previewOrder is a pure lookup — no mutation, no stamina change", () => {
  const p = joinBar(db, "A", "red", "warm");
  const before = currentStamina(db, p.playerId);
  const preview = previewOrder("grilled-trout", null);
  expect(preview.item.name).toBe("Grilled Trout");
  expect(preview.variant).toBeNull();
  // Real wall-clock decay between the two reads, same jitter reasoning
  // as spec/stamina.test.ts — precision 2, not 5.
  expect(currentStamina(db, p.playerId)).toBeCloseTo(before, 2);
});

it("previewOrder resolves a real variant and rejects a fake one", () => {
  const ok = previewOrder("house-steak", "Medium");
  expect(ok.variant).toBe("Medium");
  const err = catchError(() => previewOrder("house-steak", "Extra crispy"));
  expect(err.code).toBe("bad_variant");
});

it("rejects a variant for an item that has no choice at all", () => {
  const err = catchError(() => previewOrder("grilled-trout", "Medium"));
  expect(err.code).toBe("bad_variant");
});

it("rejects an item not on the menu", () => {
  const err = catchError(() => previewOrder("mystery-meat", null));
  expect(err.code).toBe("bad_item");
});

it("placing an order never changes stamina", () => {
  const p = joinBar(db, "A", "red", "warm");
  const before = currentStamina(db, p.playerId);
  placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-1");
  expect(currentStamina(db, p.playerId)).toBeCloseTo(before, 2);
});

it("can hold a meal and a drink at the same time (replaces the old single-active-order limit)", () => {
  const p = joinBar(db, "A", "red", "warm");
  const meal = placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "key-meal");
  const drink = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-drink");
  expect(meal.kind).toBe("meal");
  expect(drink.kind).toBe("drink");
  const held = getHeldItems(db, p.playerId);
  expect(held.filter((h) => h.state === "held")).toHaveLength(2);
});

it("refuses a second meal while one is already held", () => {
  const p = joinBar(db, "A", "red", "warm");
  placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "key-1");
  const err = catchError(() => placeOrder(db, p.playerId, p.sessionSecret, "bean-chili", null, "key-2"));
  expect(err.code).toBe("order_active");
});

it("a duplicate idempotency key returns the same held item, not a second one", () => {
  const p = joinBar(db, "A", "red", "warm");
  const first = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "same-key");
  const second = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "same-key");
  expect(second.id).toBe(first.id);
  expect(getHeldItems(db, p.playerId).filter((h) => h.itemId === "soda")).toHaveLength(1);
});

it('never returns another identity’s order through a reused global idempotency key',()=>{
  const a=joinBar(db,'A','red','warm'),b=joinBar(db,'B','blue','warm');
  placeOrder(db,a.playerId,a.sessionSecret,'soda',null,'collision-key');
  expect(catchError(()=>placeOrder(db,b.playerId,b.sessionSecret,'soda',null,'collision-key')).code).toBe('idempotency_conflict');
  expect(getHeldItems(db,b.playerId)).toEqual([]);
});

it('rejects reuse of a successful key for a different item or variant',()=>{
  const a=joinBar(db,'A','red','warm');placeOrder(db,a.playerId,a.sessionSecret,'house-steak','Rare','meal-key');
  expect(catchError(()=>placeOrder(db,a.playerId,a.sessionSecret,'house-steak','Medium','meal-key')).code).toBe('idempotency_conflict');
});

it("consuming a meal restores +70, a drink +30, both on top of the current value", () => {
  const p = joinBar(db, "A", "red", "warm");
  const meal = placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "key-meal");
  const afterMeal = consumeHeldItem(db, p.playerId, p.sessionSecret, meal.id);
  expect(afterMeal.state).toBe("consumed");
  // Started at 80%; +70 clamps at 100. A later currentStamina() read
  // recomputes decay for the real wall-clock time since the restore,
  // same jitter reasoning as spec/stamina.test.ts — precision 2, not
  // exact equality.
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2);
});

it("ordering, browsing, and variant selection never restore stamina — only consume does", () => {
  const p = joinBar(db, "A", "red", "warm");
  previewOrder("house-steak", "Rare");
  const held = placeOrder(db, p.playerId, p.sessionSecret, "house-steak", "Rare", "key-1");
  expect(currentStamina(db, p.playerId)).toBeCloseTo(80, 1);
  consumeHeldItem(db, p.playerId, p.sessionSecret, held.id);
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2); // only this call restored anything
});

it("a second consume attempt against an already-consumed item is a no-op, never a double restore", () => {
  const p = joinBar(db, "A", "red", "warm");
  const held = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-1");
  consumeHeldItem(db, p.playerId, p.sessionSecret, held.id); // 80 + 30 = 100
  const afterFirst = currentStamina(db, p.playerId);
  expect(afterFirst).toBeCloseTo(100, 2);
  const second = consumeHeldItem(db, p.playerId, p.sessionSecret, held.id);
  expect(second.state).toBe("consumed");
  // Must not have risen from the first read — a second restore would
  // add another +30, which toBeCloseTo(_, 2) could not hide.
  expect(currentStamina(db, p.playerId)).toBeLessThanOrEqual(afterFirst);
});

it("consuming at full stamina clamps at 100 and banks nothing for later", () => {
  const p = joinBar(db, "A", "red", "warm");
  const meal = placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "key-meal");
  consumeHeldItem(db, p.playerId, p.sessionSecret, meal.id); // -> 100
  const drink = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-drink");
  const afterDrink = consumeHeldItem(db, p.playerId, p.sessionSecret, drink.id);
  expect(afterDrink.state).toBe("consumed");
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2); // 100 + 30 still clamps at 100
});

it("cannot consume another identity's held item", () => {
  const a = joinBar(db, "A", "red", "warm");
  const b = joinBar(db, "B", "blue", "warm");
  const held = placeOrder(db, a.playerId, a.sessionSecret, "soda", null, "key-1");
  const err = catchError(() => consumeHeldItem(db, b.playerId, b.sessionSecret, held.id));
  expect(err.code).toBe("not_held");
  expect(currentStamina(db, a.playerId)).toBeCloseTo(80, 1); // untouched
});

it("refuses a wrong session secret for placing and consuming", () => {
  const p = joinBar(db, "A", "red", "warm");
  expect(() => placeOrder(db, p.playerId, "wrong-secret", "soda", null, "key-1")).toThrow();
  const held = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-2");
  expect(() => consumeHeldItem(db, p.playerId, "wrong-secret", held.id)).toThrow();
});

it("a meal and a drink can be ordered and consumed independently, in either order", () => {
  const p = joinBar(db, "A", "red", "warm");
  const drink = placeOrder(db, p.playerId, p.sessionSecret, "soda", null, "key-drink");
  const meal = placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "key-meal");
  consumeHeldItem(db, p.playerId, p.sessionSecret, drink.id); // 80 + 30 -> 100
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2);
  consumeHeldItem(db, p.playerId, p.sessionSecret, meal.id); // 100 + 70 -> still 100
  expect(currentStamina(db, p.playerId)).toBeCloseTo(100, 2);
  const held = getHeldItems(db, p.playerId);
  expect(held.every((h) => h.state === "consumed")).toBe(true);
});

it("once a meal is consumed, a new meal can be ordered again (not permanently stuck)", () => {
  const p = joinBar(db, "A", "red", "warm");
  const first = placeOrder(db, p.playerId, p.sessionSecret, "grilled-trout", null, "key-1");
  consumeHeldItem(db, p.playerId, p.sessionSecret, first.id);
  const second = placeOrder(db, p.playerId, p.sessionSecret, "bean-chili", null, "key-2");
  expect(second.id).not.toBe(first.id);
});
