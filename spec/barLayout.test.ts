// src/barLayout.ts's pure geometry — tested directly, same rationale as
// spec/presence.test.ts: these functions *are* the contract (there's no
// separate "real" behavior to compare against), and testing furniture
// collision in isolation from adjacency needs a controlled pair of
// tiles that spec/bar.test.ts's HTTP-level tests can't cheaply set up
// from the fixed spawn point alone.

import { describe, expect, it } from "vitest";
import { BAR_SEATS, FURNITURE, GAME_CHAIRS, GAME_TABLES, GRID_COLS, GRID_ROWS, defaultSpawn, isValidStep, isWalkable, isWalkingFloor } from "../src/barLayout.ts";
import { COLORS } from "../src/types.ts";

describe("isWalkable", () => {
  it("is true for open floor", () => {
    expect(isWalkable(0, 3)).toBe(true);
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

  it("doesn't open a passage through the back wall immediately above it", () => {
    expect(isWalkable(restroom.x, restroom.y - 1)).toBe(false);
    expect(isWalkingFloor(restroom.x, restroom.y + restroom.h)).toBe(true);
  });
});

it("all chairs block ordinary movement, and diagonal steps cannot cut their corners", () => {
  for (const chair of [...BAR_SEATS, ...GAME_CHAIRS]) {
    expect(isWalkingFloor(chair.x, chair.y)).toBe(false);
    for (const [dx,dy] of [[0,1],[1,0],[0,-1],[-1,0]]) {
      expect(isValidStep(chair.x+dx,chair.y+dy,chair.x,chair.y)).toBe(false);
    }
  }
  const stool = BAR_SEATS[0];
  expect(isValidStep(stool.x-1,stool.y,stool.x,stool.y+1)).toBe(false);
});

it("both painted cabinet walls have real blocking footprints", () => {
  for (const id of ["back-wall", "back-bar"]) {
    const wall = FURNITURE.find(f=>f.id===id)!;
    expect(wall).toBeDefined();
    for (let x=wall.x;x<wall.x+wall.w;x++) for(let y=wall.y;y<wall.y+wall.h;y++) expect(isWalkingFloor(x,y)).toBe(false);
  }
});

it("every decorative plant fixture has a real blocking footprint, and none sits near a chair or seat", () => {
  // A plant drawn purely in canvas (the shape this replaces) had no
  // shared collision at all, and visually overlapped a game chair in a
  // real play-test screenshot even though nothing here would have
  // caught it — a walkable tile next to another walkable tile isn't a
  // collision. Guards both halves of the fix: the fixture really blocks
  // movement, and it's far enough from every seat/chair (Chebyshev
  // distance, matching how a chair's own drawn canopy/art extends past
  // its single tile) that a small future layout nudge can't silently
  // reintroduce the same overlap.
  const plants = FURNITURE.filter((f) => f.kind === "plant");
  expect(plants.length).toBeGreaterThan(0);
  const occupied = [...BAR_SEATS, ...GAME_CHAIRS];
  for (const p of plants) {
    expect(isWalkingFloor(p.x, p.y), `${p.id} should block movement`).toBe(false);
    for (const o of occupied) {
      const dist = Math.max(Math.abs(o.x - p.x), Math.abs(o.y - p.y));
      expect(dist, `${p.id} is too close to ${"id" in o ? o.id : `${o.tableId}:${o.color}`}`).toBeGreaterThanOrEqual(3);
    }
  }
});

describe("isValidStep", () => {
  it("allows a single step onto adjacent open floor, 8 directions", () => {
    const [fx, fy] = [5, 3]; // clear floor below the back wall
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
    expect(isValidStep(0, 3, 2, 3)).toBe(false);
    expect(isValidStep(0, 3, 0, 5)).toBe(false);
  });

  it("refuses a zero-distance 'step'", () => {
    expect(isValidStep(5, 5, 5, 5)).toBe(false);
  });
});

describe("BAR_SEATS (Phase 2: real dining/stool seating)", () => {
  it("Vegas chairs are evenly distributed around each round table with distinct hit areas", () => {
    for (const table of GAME_TABLES.filter((t) => t.gameType === "vegas")) {
      const chairs = GAME_CHAIRS.filter((s) => s.tableId === table.id);
      expect(chairs).toHaveLength(5);
      for (let i = 0; i < chairs.length; i++) {
        const chair = chairs[i] as typeof chairs[number] & { displayX: number; displayY: number };
        const angle = (-90 + i * 72) * Math.PI / 180;
        expect(chair.displayX).toBeCloseTo(table.x + table.w / 2 + 1.55 * Math.cos(angle));
        expect(chair.displayY).toBeCloseTo(table.y + table.h / 2 + 1.55 * Math.sin(angle));
        expect(chair.x).toBe(Math.floor(chair.displayX));
        expect(chair.y).toBe(Math.floor(chair.displayY));
      }
    }
    const centres = GAME_CHAIRS.map((s) => ({
      x: "displayX" in s ? s.displayX as number : s.x + .5,
      y: "displayY" in s ? s.displayY as number : s.y + .5,
    }));
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
      expect(Math.abs(centres[i].x - centres[j].x) < 1 && Math.abs(centres[i].y - centres[j].y) < 1,
        `chair hit areas ${i} and ${j} overlap`).toBe(false);
    }
  });
  it("each painted stool is its actual clickable, walkable seat tile", () => {
    for (const f of FURNITURE.filter((f) => f.kind === "stool")) {
      expect(BAR_SEATS.find((s) => s.furnitureId === f.id)).toMatchObject({ x: f.x, y: f.y });
      expect(isWalkable(f.x, f.y)).toBe(true);
    }
  });
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

it("all physical chairs have unique, reachable tiles, including between adjacent game tables", () => {
  const spawn = defaultSpawn();
  const queue = [spawn], reachable = new Set([`${spawn.x},${spawn.y}`]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx, y = p.y + dy, key = `${x},${y}`;
      if (isWalkingFloor(x, y) && !reachable.has(key)) { reachable.add(key); queue.push({ x, y }); }
    }
  }
  const seen = new Set<string>();
  for (const s of [...BAR_SEATS, ...GAME_CHAIRS]) {
    const key = `${s.x},${s.y}`;
    expect(seen.has(key), `two chairs at ${key}`).toBe(false);
    expect([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>reachable.has(`${s.x+dx},${s.y+dy}`)), `inaccessible chair at ${key}`).toBe(true);
    seen.add(key);
  }
});

it("every game table has exactly COLORS.length chairs, one per color, mutually exclusive and walkable", () => {
  // 5, not 4 — the official rulebook ships 5 player colours' worth of
  // dice (src/rooms.ts's MAX_PLAYERS comment has the citation); this test
  // guards GAME_CHAIRS staying in sync with COLORS, whatever its length
  // is, rather than re-hardcoding "5" as a second number to drift from
  // the first.
  for (const t of GAME_TABLES) {
    const chairs = GAME_CHAIRS.filter((c) => c.tableId === t.id);
    expect(chairs, `${t.id} chair count`).toHaveLength(COLORS.length);
    expect(chairs.map((c) => c.color).sort()).toEqual([...COLORS].sort());
    const seen = new Set<string>();
    for (const c of chairs) {
      const key = `${c.x},${c.y}`;
      expect(seen.has(key), `${t.id} has two chairs at ${key}`).toBe(false);
      seen.add(key);
      expect(isWalkable(c.x, c.y), `${t.id}'s ${c.color} chair at ${key} is not walkable`).toBe(true);
    }
  }
});

it("both game-table rows start at the dining-table row's own left edge", () => {
  // Both rows still line up with the dining row on the left. The NPC
  // row still ends exactly on that same right edge too — the online
  // row no longer does, see the next test for why.
  const dining = FURNITURE.filter((f) => f.kind === "dining_table");
  const diningLeft = Math.min(...dining.map((f) => f.x));
  for (const mode of ["online", "npc"]) {
    const row = GAME_TABLES.filter((f) => f.tableMode === mode);
    expect(Math.min(...row.map((f) => f.x))).toBe(diningLeft);
  }
  const npcRow = GAME_TABLES.filter((f) => f.tableMode === "npc");
  expect(Math.max(...npcRow.map((f) => f.x + f.w))).toBe(Math.max(...dining.map((f) => f.x + f.w)));
});

it("the online row's own columns leave a real walkway beside every chair ring, round or square", () => {
  // The online row was originally packed at the same tight gap as the
  // dining row (gap=2 between table rectangles), which left zero clear
  // floor tiles beside a chair ring on either a round (5-chair) or
  // square (4-chair) table — found by the student's own play-testing,
  // not by this file's existing collision/reachability checks (a
  // walkable tile right next to another walkable tile isn't a
  // collision, it's just an uncomfortably tight aisle no automated
  // check here was built to catch). Re-spaced to the same 3/4/3 gap
  // pattern the NPC row already used for the same reason, which runs
  // past the dining row's own right edge — a real, deliberate width
  // increase, not a bug, which is why the previous test no longer
  // checks the online row's right edge against dining's.
  const online = GAME_TABLES.filter((f) => f.tableMode === "online").sort((a, b) => a.x - b.x);
  for (let i = 0; i < online.length - 1; i++) {
    const a = online[i], b = online[i + 1];
    const chairsOf = (t: typeof a) => GAME_CHAIRS.filter((c) => c.tableId === t.id);
    const aMaxX = Math.max(...chairsOf(a).map((c) => c.x));
    const bMinX = Math.min(...chairsOf(b).map((c) => c.x));
    expect(bMinX - aMaxX - 1, `${a.id} and ${b.id} have no walkway between their chairs`).toBeGreaterThanOrEqual(1);
  }
});

it("has nine tables in two labelled rows — 3 Vegas + 2 Hold’em playable, 4 reserved slots, all 2x2", () => {
  expect(GAME_TABLES).toHaveLength(9);
  expect(GAME_TABLES.filter((t) => t.gameType === "vegas")).toHaveLength(3); // 2 online + 1 NPC
  expect(GAME_TABLES.filter((t) => t.available)).toHaveLength(5);
  expect(GAME_TABLES.filter((t) => !t.available)).toHaveLength(4);
  expect(GAME_TABLES.filter((t) => t.tableMode === "online")).toHaveLength(5);
  expect(GAME_TABLES.filter((t) => t.tableMode === "npc")).toHaveLength(4);
  // Vegas and Hold’em are playable; dominoes and blackjack remain reserved.
  for (const t of GAME_TABLES.filter((t) => t.available)) {
    expect(["vegas","texas"]).toContain(t.gameType);
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
