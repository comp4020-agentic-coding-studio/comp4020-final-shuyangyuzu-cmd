// src/barLayout.ts's pure geometry — tested directly, same rationale as
// spec/presence.test.ts: these functions *are* the contract (there's no
// separate "real" behavior to compare against), and testing furniture
// collision in isolation from adjacency needs a controlled pair of
// tiles that spec/bar.test.ts's HTTP-level tests can't cheaply set up
// from the fixed spawn point alone.

import { describe, expect, it } from "vitest";
import { FURNITURE, GAME_TABLES, GRID_COLS, GRID_ROWS, isValidStep, isWalkable } from "../src/barLayout.ts";

describe("isWalkable", () => {
  it("is true for open floor", () => {
    expect(isWalkable(0, 0)).toBe(true);
    expect(isWalkable(GRID_COLS - 1, GRID_ROWS - 1)).toBe(true);
  });

  it("is false for every tile a piece of furniture covers", () => {
    for (const f of FURNITURE) {
      for (let dx = 0; dx < f.w; dx++) {
        for (let dy = 0; dy < f.h; dy++) {
          expect(isWalkable(f.x + dx, f.y + dy), `${f.id} tile (${f.x + dx},${f.y + dy})`).toBe(false);
        }
      }
    }
  });

  it("is false outside the grid", () => {
    expect(isWalkable(-1, 0)).toBe(false);
    expect(isWalkable(0, -1)).toBe(false);
    expect(isWalkable(GRID_COLS, 0)).toBe(false);
    expect(isWalkable(0, GRID_ROWS)).toBe(false);
  });
});

describe("isValidStep", () => {
  it("allows a single step onto adjacent open floor, 8 directions", () => {
    const [fx, fy] = [5, 0]; // an open-floor origin tile, away from any furniture
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      if (isWalkable(fx + dx, fy + dy)) {
        expect(isValidStep(fx, fy, fx + dx, fy + dy)).toBe(true);
      }
    }
  });

  it("refuses stepping onto furniture even though it's adjacent", () => {
    const f = FURNITURE[0]; // the counter, at (3,1), spanning x=3..16
    // x=f.x+1 (not f.x itself) to dodge the stool fixture directly below
    // the counter's left edge at (3,2) — a real second piece of
    // furniture, not a bug in this test's target tile.
    const adjacentFloor = { x: f.x + 1, y: f.y + f.h };
    const furnitureAbove = { x: f.x + 1, y: f.y };
    expect(isWalkable(adjacentFloor.x, adjacentFloor.y)).toBe(true);
    expect(isValidStep(adjacentFloor.x, adjacentFloor.y, furnitureAbove.x, furnitureAbove.y)).toBe(false);
  });

  it("refuses a step more than one tile away, even onto open floor", () => {
    expect(isValidStep(0, 0, 2, 0)).toBe(false);
    expect(isValidStep(0, 0, 0, 2)).toBe(false);
  });

  it("refuses a zero-distance 'step'", () => {
    expect(isValidStep(5, 5, 5, 5)).toBe(false);
  });
});

it("has exactly 3 playable Vegas tables and 3 reserved slots, all 2x2", () => {
  expect(GAME_TABLES).toHaveLength(6);
  expect(GAME_TABLES.filter((t) => t.gameType === "vegas")).toHaveLength(3);
  expect(GAME_TABLES.filter((t) => !t.available)).toHaveLength(3);
  for (const t of GAME_TABLES) {
    expect(t.w).toBe(2);
    expect(t.h).toBe(2);
  }
});
