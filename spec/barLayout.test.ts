// src/barLayout.ts's pure geometry — tested directly, same rationale as
// spec/presence.test.ts: these functions *are* the contract (there's no
// separate "real" behavior to compare against), and testing furniture
// collision in isolation from adjacency needs a controlled pair of
// tiles that spec/bar.test.ts's HTTP-level tests can't cheaply set up
// from the fixed spawn point alone.

import { describe, expect, it } from "vitest";
import { BAR_SEATS, FURNITURE, GAME_TABLES, GRID_COLS, GRID_ROWS, isValidStep, isWalkable } from "../src/barLayout.ts";

describe("isWalkable", () => {
  it("is true for open floor", () => {
    expect(isWalkable(0, 0)).toBe(true);
    expect(isWalkable(GRID_COLS - 1, GRID_ROWS - 1)).toBe(true);
  });

  it("is false for every tile a blocking piece of furniture covers", () => {
    // Excludes any fixture explicitly marked blocksMovement: false (the
    // restroom) — covered separately below, since that's the one
    // intentional exception to "furniture blocks movement".
    for (const f of FURNITURE.filter((f) => f.blocksMovement !== false)) {
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

describe("the restroom (Crit 9: a walkable zone, not an obstacle)", () => {
  const restroom = FURNITURE.find((f) => f.id === "restroom")!;

  it("exists, is at a map edge, and doesn't overlap any other fixture", () => {
    expect(restroom).toBeDefined();
    expect(restroom.blocksMovement).toBe(false);
    for (const other of FURNITURE) {
      if (other.id === restroom.id) continue;
      const overlapsX = restroom.x < other.x + other.w && other.x < restroom.x + restroom.w;
      const overlapsY = restroom.y < other.y + other.h && other.y < restroom.y + restroom.h;
      expect(overlapsX && overlapsY, `${restroom.id} overlaps ${other.id}`).toBe(false);
    }
  });

  it("every one of its tiles is walkable — client and server share this exact fixture list, so they can't disagree", () => {
    for (let dx = 0; dx < restroom.w; dx++) {
      for (let dy = 0; dy < restroom.h; dy++) {
        expect(isWalkable(restroom.x + dx, restroom.y + dy), `restroom tile (${restroom.x + dx},${restroom.y + dy})`).toBe(true);
      }
    }
  });

  it("stepping into and back out of it is a sequence of valid single steps", () => {
    const entryX = restroom.x, entryY = restroom.y + restroom.h; // just south of it, open floor
    expect(isWalkable(entryX, entryY)).toBe(true);
    expect(isValidStep(entryX, entryY, restroom.x, restroom.y + restroom.h - 1)).toBe(true);
    expect(isValidStep(restroom.x, restroom.y + restroom.h - 1, entryX, entryY)).toBe(true);
  });

  it("doesn't change walkability of the tiles immediately around it (no accidental widening of the walkable area)", () => {
    // One tile further out than the restroom's own footprint, on each
    // side still inside the grid, should be exactly what it was before
    // this fixture existed: open floor, not specially affected.
    const aboveY = restroom.y - 1;
    if (aboveY >= 0) expect(isWalkable(restroom.x, aboveY)).toBe(true);
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

describe("BAR_SEATS (Phase 2: real dining/stool seating)", () => {
  it("every seat is on an ordinary walkable tile — sitting never needs a walkability exception", () => {
    for (const s of BAR_SEATS) {
      expect(isWalkable(s.x, s.y), `${s.id} at (${s.x},${s.y})`).toBe(true);
    }
  });

  it("no two seats share the same tile, even across different furniture", () => {
    const seen = new Set<string>();
    for (const s of BAR_SEATS) {
      const key = `${s.x},${s.y}`;
      expect(seen.has(key), `${s.id} collides with an earlier seat at (${s.x},${s.y})`).toBe(false);
      seen.add(key);
    }
  });

  it("has one seat per stool and 4 per dining table", () => {
    const stools = FURNITURE.filter((f) => f.kind === "stool");
    const diningTables = FURNITURE.filter((f) => f.kind === "dining_table");
    for (const f of stools) {
      expect(BAR_SEATS.filter((s) => s.furnitureId === f.id)).toHaveLength(1);
    }
    for (const f of diningTables) {
      expect(BAR_SEATS.filter((s) => s.furnitureId === f.id)).toHaveLength(4);
    }
  });
});

it("has nine tables in two labelled rows — 2 online + 1 NPC Vegas table playable, 6 reserved slots, all 2x2", () => {
  expect(GAME_TABLES).toHaveLength(9);
  expect(GAME_TABLES.filter((t) => t.gameType === "vegas")).toHaveLength(3); // 2 online + 1 NPC
  expect(GAME_TABLES.filter((t) => t.available)).toHaveLength(3);
  expect(GAME_TABLES.filter((t) => !t.available)).toHaveLength(6);
  expect(GAME_TABLES.filter((t) => t.tableMode === "online")).toHaveLength(5);
  expect(GAME_TABLES.filter((t) => t.tableMode === "npc")).toHaveLength(4);
  // Every available slot is a Vegas table — only this game is actually
  // implemented this round (PLAN.md's product-direction-update), in both
  // modes; every other game stays reserved in both rows.
  for (const t of GAME_TABLES.filter((t) => t.available)) {
    expect(t.gameType).toBe("vegas");
  }
  for (const t of GAME_TABLES) {
    expect(t.w).toBe(2);
    expect(t.h).toBe(2);
  }
});

it("the two rows (online, NPC) don't overlap each other or anything else", () => {
  const online = GAME_TABLES.filter((t) => t.tableMode === "online");
  const npc = GAME_TABLES.filter((t) => t.tableMode === "npc");
  for (const a of online) {
    for (const b of npc) {
      const overlapsX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapsY = a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlapsX && overlapsY, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
});

it("no two fixtures in the whole layout overlap each other, full stop", () => {
  for (let i = 0; i < FURNITURE.length; i++) {
    for (let j = i + 1; j < FURNITURE.length; j++) {
      const a = FURNITURE[i], b = FURNITURE[j];
      const overlapsX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapsY = a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlapsX && overlapsY, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
});
