// src/npc.ts's pure decision logic — tested directly, same rationale as
// spec/presence.test.ts: this function *is* the contract (no I/O, no
// RNG), and the point of keeping it pure is exactly that it can be
// checked this way without a database or a room.

import { describe, expect, it } from "vitest";
import { chooseNpcPlacement } from "../src/npc.ts";

describe("chooseNpcPlacement", () => {
  it("picks the value rolled most often", () => {
    expect(chooseNpcPlacement([3, 3, 3, 5, 6])).toBe(3);
    expect(chooseNpcPlacement([1, 2, 2, 2, 2, 6])).toBe(2);
  });

  it("breaks a tie by the lowest value, deterministically", () => {
    expect(chooseNpcPlacement([4, 4, 2, 2])).toBe(2);
    expect(chooseNpcPlacement([6, 6, 1, 1, 3, 3])).toBe(1);
  });

  it("handles a single die", () => {
    expect(chooseNpcPlacement([5])).toBe(5);
  });

  it("never returns a value that wasn't actually rolled", () => {
    const values = [2, 4, 4, 6];
    expect(values).toContain(chooseNpcPlacement(values));
  });
});
