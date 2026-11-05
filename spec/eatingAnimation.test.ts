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

// ---- 2026-11-05 manual-acceptance correction: real contact-point
// geometry, not a restatement of the implementation ----
//
// The student's own real-browser playtest rejected the previous round's
// contact math outright — the glass's rim reached up near the eyes, the
// plate's centre (not its near rim) was driven toward the mouth, and a
// grey utensil was left floating with nothing holding it. These tests
// exercise the actual exported geometry helpers the drawing code now
// shares a single coordinate system through, and — per the student's own
// explicit instruction — verify the TRANSFORMED contact point actually
// lands at the mouth, by re-applying the exact forward transform
// (translate + ctx.rotate) these helpers are the algebraic inverse of,
// rather than merely re-asserting the formula that produced it.
import { glassOriginForRim, mouthAnchor, plateCenterForRim, rotatePoint } from "../public/tavern.js";

it("rotatePoint matches canvas's own ctx.rotate convention at known angles", () => {
  // 90 degrees: (1,0) -> (0,1) under canvas's y-down, clockwise-positive rotation.
  const quarter = rotatePoint(1, 0, Math.PI / 2);
  expect(quarter.x).toBeCloseTo(0, 10);
  expect(quarter.y).toBeCloseTo(1, 10);
  // 0 radians is the identity.
  const identity = rotatePoint(3, -4, 0);
  expect(identity.x).toBeCloseTo(3, 10);
  expect(identity.y).toBeCloseTo(-4, 10);
});

it("plateCenterForRim: the plate's own near rim, not its centre, lands exactly on the requested contact point at every tilt", () => {
  const w = 180; // an arbitrary plate width, matching PLATE_W's own scale
  for (const tilt of [0, 0.3, 0.6, 1]) {
    const ry = w * 0.22 * (1 - tilt * 0.92); // plateRy's own formula, independently recomputed here (not imported) so this test can't pass merely by sharing a bug with the implementation
    const contact = { x: 42, y: -213 }; // an arbitrary target "mouth" point
    const center = plateCenterForRim(contact.x, contact.y, ry);
    // Forward check: the rim of an ellipse centred at `center` with
    // vertical radius `ry` sits at (center.x, center.y - ry) — this must
    // reproduce the original contact point exactly, at every tilt,
    // confirming the ellipse's own near edge (not its centre) is what
    // reaches the target.
    const reconstructedRim = { x: center.x, y: center.y - ry };
    expect(reconstructedRim.x).toBeCloseTo(contact.x, 10);
    expect(reconstructedRim.y).toBeCloseTo(contact.y, 10);
  }
});

it("glassOriginForRim: the glass's own rim lands on the requested contact point once ctx.translate+ctx.rotate are actually applied, at every tilt angle", () => {
  const bowlH = 55; // an arbitrary bowl height, matching GLASS_H*0.5's own scale
  const contact = { x: -17, y: -340 }; // an arbitrary "mouth" target, distinct from the plate test's own, so neither test could pass by coincidence
  for (const theta of [0, -0.3, -0.9, -1.2]) {
    const origin = glassOriginForRim(contact.x, contact.y, bowlH, theta);
    // Forward transform: this is EXACTLY what ctx.translate(origin.x,
    // origin.y); ctx.rotate(theta) does to the glass's own local rim
    // point (0, -bowlH) before any drawing happens — reproducing it here
    // independently (not calling glassOriginForRim's own internals)
    // proves the inverse this function computes is actually correct,
    // not merely self-consistent.
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const rotatedRimX = 0 * cos - -bowlH * sin;
    const rotatedRimY = 0 * sin + -bowlH * cos;
    const actualRimOnScreen = { x: origin.x + rotatedRimX, y: origin.y + rotatedRimY };
    expect(actualRimOnScreen.x).toBeCloseTo(contact.x, 8);
    expect(actualRimOnScreen.y).toBeCloseTo(contact.y, 8);
  }
});

it("mouthAnchor sits inside the lower half of the head box, directly below the eye line drawFace itself uses — not above the hairline and not below the chin", () => {
  const headY = -100, headH = 80;
  const eyeY = headY + headH * 0.42; // drawFace's own eye-line formula, independently recomputed here
  const mouth = mouthAnchor(headY, headH);
  expect(mouth.x).toBe(0); // the scene's own horizontal centre line
  expect(mouth.y).toBeGreaterThan(eyeY); // below the eyes, never above them (the previous round's actual bug: the glass reached eye height)
  expect(mouth.y).toBeLessThan(headY + headH); // still within the head box, never below the chin/off the face entirely
});

it("at full lift, the meal plate's and the drink glass's own rim contact points converge on the exact same mouth anchor — one shared coordinate system, not two independently-tuned targets", () => {
  const headY = -200, headH = 150;
  const mouth = mouthAnchor(headY, headH);
  // Meal: at plateLift=1 the contact point IS the mouth (no further lerp
  // headroom beyond full lift) — verified by reconstructing the rim from
  // plateCenterForRim at full tilt and confirming it equals mouth exactly.
  const plateTilt = 1;
  const ry = 180 * 0.22 * (1 - plateTilt * 0.92);
  const plateCenter = plateCenterForRim(mouth.x, mouth.y, ry);
  const plateRimReconstructed = { x: plateCenter.x, y: plateCenter.y - ry };
  expect(plateRimReconstructed.x).toBeCloseTo(mouth.x, 10);
  expect(plateRimReconstructed.y).toBeCloseTo(mouth.y, 10);
  // Drink: at lift=1 the contact point is likewise exactly the mouth —
  // verified the same forward-transform way as the dedicated glass test
  // above, at the specific tiltRad the real lift=1 beat actually uses.
  const theta = -1 * 0.9;
  const bowlH = 55;
  const origin = glassOriginForRim(mouth.x, mouth.y, bowlH, theta);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const glassRimReconstructed = { x: origin.x + (0 * cos - -bowlH * sin), y: origin.y + (0 * sin + -bowlH * cos) };
  expect(glassRimReconstructed.x).toBeCloseTo(mouth.x, 8);
  expect(glassRimReconstructed.y).toBeCloseTo(mouth.y, 8);
});
