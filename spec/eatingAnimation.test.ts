// Pure-function coverage for the seated eating/drinking cutscene's own
// timing math (public/tavern.js) — independently testable without a real
// 8-second window or a running animation frame, same reasoning as
// spec/direction-hold.test.ts testing bindDirectionHold directly.
//
// 2026-11 correction (Codex review): the cutscene used to hold the plate/
// glass fixed in one spot across the whole animation, with only a few
// discrete snapshots (an arm raised/lowered, a bite-count, a liquid
// height) standing in for "pick it up, eat/drink it, put it down" — never
// an actual continuous motion. eatingPhaseAt now also returns
// `localProgress`, the continuous 0..1 value drawEatingScene interpolates
// the plate/glass's own height and the shrinking food/liquid from. This
// file pins down that `localProgress` contract directly; the actual
// canvas drawing is verified separately via real browser pixel/screenshot
// checks (see PLAN.md's verification entry for this round), since a unit
// test can't see rendered pixels.

import { expect, it } from "vitest";
import { eatingPhaseAt } from "../public/tavern.js";

it("splits a solo kind's own window evenly into lift/active/down stages, with continuous localProgress throughout", () => {
  const atStart = eatingPhaseAt(["meal"], 0);
  expect(atStart?.kind).toBe("meal");
  expect(atStart?.stage).toBe("lift");
  expect(atStart?.localProgress).toBeCloseTo(0, 5);

  const atEnd = eatingPhaseAt(["meal"], 0.999);
  expect(atEnd?.stage).toBe("down");
  expect(atEnd?.localProgress).toBeGreaterThan(0.9);

  const mid = eatingPhaseAt(["meal"], 0.5);
  expect(mid?.stage).toBe("active");
  expect(mid?.localProgress).toBeCloseTo(0.5, 5);
});

it("a combined meal-then-drink action plays the meal's own full lift/active/down cycle before the drink's", () => {
  // n=2: meal occupies progress [0, 0.5), drink occupies [0.5, 1].
  const earlyMeal = eatingPhaseAt(["meal", "drink"], 0.1);
  expect(earlyMeal?.kind).toBe("meal");
  const lateMeal = eatingPhaseAt(["meal", "drink"], 0.49);
  expect(lateMeal?.kind).toBe("meal");
  expect(lateMeal?.stage).toBe("down"); // the meal's own cycle has already reached "down" by the time its half ends
  const earlyDrink = eatingPhaseAt(["meal", "drink"], 0.5);
  expect(earlyDrink?.kind).toBe("drink");
  expect(earlyDrink?.stage).toBe("lift"); // the drink's own cycle restarts fresh at "lift"
});

it("progress outside [0,1] is clamped, never producing an out-of-range localProgress", () => {
  const before = eatingPhaseAt(["drink"], -0.5);
  expect(before?.localProgress).toBeGreaterThanOrEqual(0);
  const after = eatingPhaseAt(["drink"], 1.5);
  expect(after?.localProgress).toBeLessThanOrEqual(1);
});

it("returns null for an empty kinds list — nothing held, nothing to animate", () => {
  expect(eatingPhaseAt([], 0.5)).toBeNull();
});
