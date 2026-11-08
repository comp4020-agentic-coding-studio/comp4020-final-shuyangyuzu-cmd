// The bar's fixed floor plan — furniture is seeded once from this and
// never created or deleted at runtime (CLAUDE.md). This single module is
// the shared source of truth for server-side movement validation *and*
// what the client renders and seeds `tables`/`bar_seats` from, reached by
// the client via GET /api/bar/layout rather than duplicated in app.js.
//
// Grid-tile movement, not free-pixel (PLAN.md decision): a move is one
// step to an adjacent, walkable tile. Walkable = not covered by any
// furniture rectangle, and inside the grid.

export const GRID_COLS = 40;
// 2026-11-08 correction (user's own explicit instruction, with a real
// screenshot showing the problem): both game-table rows below moved down
// by 2 tiles to open a genuine walking corridor between the dining row's
// own south seats and the online row's own nearest chair — GRID_ROWS
// grows by 2 to make room at the map's own bottom edge rather than
// compressing the NPC row's own gap from the online row (CLAUDE.md:
// "必要时扩展地图底部" — extend the map's bottom when needed, not shrink
// an already-correct gap elsewhere). Every consumer of this constant
// (inBounds, defaultSpawn, bar.ts's own spawn-search radius) reads it
// directly rather than hardcoding 24, so this one change propagates
// correctly everywhere a map boundary matters.
export const GRID_ROWS = 26;
export const TILE_SIZE = 32;

export type FurnitureKind = "counter" | "stool" | "dining_table" | "game_table" | "restroom" | "cabinet_wall" | "plant";
export type GameType = "vegas" | "texas" | "dominoes" | "blackjack";
/** "online" — a shared table other patrons can request to join, host-
 * approved (Crit 9 phase 8). "npc" — a solo kiosk: every visitor who
 * starts one gets their own private game against 3 computer-controlled
 * opponents, never a table other patrons see as "join-able" (PLAN.md's
 * product-direction-update). */
export type TableMode = "online" | "npc";

export interface Furniture {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Only set for kind === "game_table". */
  gameType?: GameType;
  /** Only set for kind === "game_table" — false for every reserved
   * ("not yet open") slot, true for the ones actually playable this
   * round (the two online Vegas tables and the one Vegas NPC table). */
  available?: boolean;
  /** Only set for kind === "game_table" — which of the two rows this
   * slot belongs to, independent of `available` (a reserved slot still
   * has a row/mode, it's just not playable yet). */
  tableMode?: TableMode;
  /** Defaults to true (every existing kind blocks movement, unchanged)
   * — set false for a fixture that's a walkable zone marker rather than
   * an obstacle (the restroom: a sign/entrance the player can walk
   * through, not a table they walk around). Read by both isWalkable
   * below and the client's own mirror of the same rule (public/tavern.js
   * fetches this same FURNITURE list via GET /api/bar/layout), so the
   * two can't drift into "client says walkable, server says no". */
  blocksMovement?: boolean;
}

const CORE_FURNITURE: readonly Furniture[] = [
  { id: "counter", kind: "counter", x: 3, y: 1, w: 14, h: 1, label: "Bar Counter" },
  { id: "stool-1", kind: "stool", x: 3, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-2", kind: "stool", x: 6, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-3", kind: "stool", x: 9, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-4", kind: "stool", x: 12, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-5", kind: "stool", x: 15, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  // Dining chairs are north/south of each table. Stool tiles above and
  // all game chairs below are included in the same collision test.
  //
  // Four tables, spaced as evenly as integer tiles allow across the same
  // [1,19) span the two game-table rows already align to (gaps 3,4,3 —
  // the closest a width-2x4 row can get to even spacing while starting
  // and ending exactly on that shared boundary, the same tradeoff the
  // NPC row below already made for the same reason). Stools no longer
  // constrain this (their own seat is now the stool's own walkable tile,
  // not a tile south of it), so unlike an earlier layout revision, these
  // four columns don't need to dodge a stool column.
  //
  // 2026-11-07 correction (user's own explicit instruction): y was 4,
  // which put a dining table's own north seat directly adjacent to the
  // stool row (effective y8 stool, y9 north seat — zero clear floor
  // tiles between the two) — a patron seated at a stool and another
  // seated at the nearest dining chair left no tile anyone else could
  // walk through between them, confirmed directly by coordinate
  // computation before this change (dump_layout-style check, not
  // eyeballed from a screenshot). y5 opens a genuine one-tile floor gap
  // (effective y9) between the stool row and the dining north-seat row,
  // confirmed clear of every other fixture (back-bar ends at y6, the
  // counter is y7, stools are y8) before and after this shift, and
  // confirmed not to newly collide with anything below (game-table rows
  // start at y15, still a full clear row away from the new south seat at
  // y13).
  { id: "dining-a", kind: "dining_table", x: 1, y: 5, w: 2, h: 2, label: "Table" },
  { id: "dining-b", kind: "dining_table", x: 6, y: 5, w: 2, h: 2, label: "Table" },
  { id: "dining-c", kind: "dining_table", x: 12, y: 5, w: 2, h: 2, label: "Table" },
  { id: "dining-d", kind: "dining_table", x: 17, y: 5, w: 2, h: 2, label: "Table" },
  // Nine tables, two labelled rows (Crit 9 phase 8's product-direction-
  // update): online (shared, host-approved — see src/rooms.ts's
  // pendingRequests) on top, a visitor's own private NPC game below.
  // Only the Vegas slots are actually playable this round; every other
  // game keeps its existing "not yet open" reserved treatment, now in
  // both rows.
  //
  // vegas-1/vegas-2 and texas-1/dominoes-1/blackjack-1 keep their
  // original ids on purpose — CLAUDE.md: furniture is never deleted, and
  // a fixture id a live room binding (tables.current_room_id) might
  // already reference must survive a layout revision unchanged. Only
  // their position/label/tableMode change here; the old third online
  // Vegas slot ("vegas-3") is dropped from this active layout per the
  // student's own explicit reduction to two online Vegas tables — its
  // row in the `tables` SQL table is never deleted (src/db.ts only seeds
  // ids that are still in GAME_TABLES, it doesn't remove ones that
  // aren't), so any room that was ever bound to it keeps existing,
  // reachable by its own code, exactly as a disbanded room already is.
  // The online row's columns were originally packed at gap=2 (the same
  // spacing the pre-5-chair layout used), which left zero clear floor
  // tiles between one table's own outermost chair and its neighbour's —
  // a patron walking the row would step through an occupied chair rather
  // than around it (found by the student's own play-testing, not caught
  // by spec/barLayout.test.ts's collision/reachability checks, since a
  // *walkable* tile immediately next to another *walkable* tile isn't a
  // collision — it's just an uncomfortably tight aisle). Re-spaced to the
  // same 3/4/3 gap pattern the NPC row below already uses for the same
  // reason, which leaves at least 1 clear tile beside every chair ring
  // for every table-shape pairing (round or square), verified by direct
  // coordinate computation before changing this.
  //
  // 2026-11-08 correction (user's own explicit instruction, with a real
  // screenshot): y was 9, which — after the 2026-11-07 dining-table shift
  // moved the dining row's own south seats one tile further south without
  // a matching shift here — left ZERO clear floor tiles between a dining
  // chair and the online row's own nearest chair (the GAME_CHAIRS north-
  // chair comment below used to claim this gap was "one full clear row",
  // which this same round found was no longer true and has been
  // corrected). y:11 (a +2 shift from the original 9) reopens a genuine
  // two-tile clear corridor, confirmed by direct coordinate computation
  // against the dining row's actual post-shift seat positions before
  // changing this, and reconfirmed by a real pathed walk through it with
  // both flanking seats occupied.
  {
    id: "vegas-1",
    kind: "game_table",
    x: 1,
    y: 11,
    w: 2,
    h: 2,
    label: "Vegas Online #1",
    gameType: "vegas",
    available: true,
    tableMode: "online",
  },
  {
    id: "vegas-2",
    kind: "game_table",
    x: 6,
    y: 11,
    w: 2,
    h: 2,
    label: "Vegas Online #2",
    gameType: "vegas",
    available: true,
    tableMode: "online",
  },
  {
    id: "texas-1",
    kind: "game_table",
    x: 12,
    y: 11,
    w: 2,
    h: 2,
    label: "Texas Hold'em Online",
    gameType: "texas",
    available: true,
    tableMode: "online",
  },
  {
    id: "dominoes-1",
    kind: "game_table",
    x: 17,
    y: 11,
    w: 2,
    h: 2,
    label: "All Fives Online",
    gameType: "dominoes",
    available: true,
    tableMode: "online",
  },
  {
    id: "blackjack-1",
    kind: "game_table",
    x: 22,
    y: 11,
    w: 2,
    h: 2,
    label: "Blackjack Online",
    gameType: "blackjack",
    available: true,
    tableMode: "online",
  },
  // The NPC row has three clear walkway rows below the online tables —
  // shifted by the same +2 as the online row above, preserving the exact
  // same gap between the two rows (GRID_ROWS grew to make room at the
  // map's own bottom edge, confirmed by direct coordinate computation
  // that the NPC row's own south-most chair still lands in-bounds).
  {
    id: "vegas-npc-1",
    kind: "game_table",
    x: 1,
    y: 16,
    w: 2,
    h: 2,
    label: "Vegas Offline",
    gameType: "vegas",
    available: true,
    tableMode: "npc",
  },
  {
    id: "texas-npc-1",
    kind: "game_table",
    x: 6,
    y: 16,
    w: 2,
    h: 2,
    label: "Texas Hold'em Offline",
    gameType: "texas",
    available: true,
    tableMode: "npc",
  },
  {
    id: "dominoes-npc-1",
    kind: "game_table",
    x: 12,
    y: 16,
    w: 2,
    h: 2,
    label: "All Fives Offline",
    gameType: "dominoes",
    available: true,
    tableMode: "npc",
  },
  {
    id: "blackjack-npc-1",
    kind: "game_table",
    x: 17,
    y: 16,
    w: 2,
    h: 2,
    label: "Blackjack Offline",
    gameType: "blackjack",
    available: true,
    tableMode: "npc",
  },
  // A map-edge, walkable-only fixture — clear of the furniture cluster
  // above (roughly x11-28/y7-15 after the +10/+6 offset below) and of
  // the main south walkway/rug area patrons actually use (y15-23), in
  // the empty space to the right of the room's own painted back wall.
  // No queueing, no occupancy, no server route of its own this round —
  // see CLAUDE.md: it's a walkable zone, not a game or a seat.
  // x:23,y:-4 here becomes x:33,y:2 after the +10/+6 offset below — top-
  // right corner of the 40x24 grid, a 3x3 tile zone.
  {
    id: "restroom",
    kind: "restroom",
    x: 23,
    y: -4,
    w: 3,
    h: 3,
    label: "Restroom",
    blocksMovement: false,
  },
];

// World coordinates remain independent of the viewport/camera. Leave room
// around the central tavern fixtures for future rooms and extensions.
export const FURNITURE: readonly Furniture[] = [...CORE_FURNITURE.map((f) => ({
  ...f, x: f.x + 10, y: f.y + 6,
})),
  { id: "back-wall", kind: "cabinet_wall", x: 0, y: 0, w: 40, h: 2, label: "Back wall" },
  { id: "back-bar", kind: "cabinet_wall", x: 8, y: 5, w: 24, h: 2, label: "Back-bar cabinets" },
  // Decorative plants, a real blocking fixture — not canvas-only art.
  // The previous four "row" plants (drawn purely in public/tavern.js,
  // no shared collision entry at all) sat only 1-3 tiles from a game
  // chair or dining seat; their drawn canopy (which extends well past
  // their own centre tile in pixel space) visually overlapped the
  // blackjack-1 table's green chair in a real play-test screenshot —
  // found by the student, not by any existing test, since "walkable
  // tile near another walkable tile" isn't a collision this file's own
  // checks were built to catch. Following the exact cabinet_wall
  // precedent above (a real FURNITURE entry picked up for free by the
  // existing isWalkable/isWalkingFloor/fixtures-loop machinery, rather
  // than a second, parallel "plant collision" concept), these four are
  // placed on open floor along the room's own side edges, each checked
  // by direct coordinate computation to sit at least 4 tiles (Chebyshev)
  // from every chair, dining seat, and other fixture before being added
  // — far enough that no future small layout drift could plausibly
  // reintroduce the same overlap. The two original "corner" plants
  // (drawn separately in public/tavern.js, near the map's far corners,
  // never implicated in the reported bug) are left as pure decoration.
  { id: "plant-nw", kind: "plant", x: 2, y: 8, w: 1, h: 1, label: "Potted plant" },
  { id: "plant-ne", kind: "plant", x: 38, y: 8, w: 1, h: 1, label: "Potted plant" },
  { id: "plant-sw", kind: "plant", x: 2, y: 19, w: 1, h: 1, label: "Potted plant" },
  { id: "plant-se", kind: "plant", x: 38, y: 19, w: 1, h: 1, label: "Potted plant" },
];

export const GAME_TABLES: readonly Furniture[] = FURNITURE.filter((f) => f.kind === "game_table");

// The chair's whole tile is its drawing and hit target. Fixed colours
// choose physical chairs independently of join-order/turn-order seats.
//
// A 5th chair (purple, src/types.ts's COLORS) sits on the tile directly
// north of the table's own first column — the official rulebook's own
// "GAME COMPONENTS" line ships 5 player colours' worth of dice (see
// src/rooms.ts's MAX_PLAYERS comment), so 5 seats is the real base-game
// max, not an extension past it. North was chosen because the other four
// chairs already occupy both the west and east sides of both table rows,
// and every table's own north tile is verified clear of every other
// chair/furniture rectangle. The claim this comment originally made —
// "dining tables sit a full row further north, so this is still one
// clear row below the nearest dining seat" — stopped being true the
// instant an EARLIER round moved the dining row's own south seats one
// tile further south without a matching shift here (found via this same
// 2026-11-08 round's own direct coordinate check, confirmed by a real
// pathing failure before being fixed): the two rows had drifted to zero
// clear tiles apart. The 2026-11-08 +2 shift to both GAME_TABLES rows
// (see the online row's own comment above) restores a genuine multi-tile
// gap, reconfirmed the same way — by direct coordinate computation
// against the real, current dining-row positions, not by re-asserting
// the original (and by-then-stale) claim.
export const GAME_CHAIRS = GAME_TABLES.flatMap((f) => f.gameType === "vegas"
  ? ["red", "blue", "green", "yellow", "purple"].map((color, i) => {
    const angle = (-90 + i * 72) * Math.PI / 180;
    const displayX = f.x + f.w / 2 + 1.55 * Math.cos(angle);
    const displayY = f.y + f.h / 2 + 1.55 * Math.sin(angle);
    return { tableId: f.id, color, x: Math.floor(displayX), y: Math.floor(displayY), displayX, displayY };
  })
  : f.gameType === "blackjack" ? ["red", "blue", "green", "yellow"].map((color, i) => {
    // Left to right on the lower arc, around the midpoint of the flat edge.
    const angle = (165 - 50 * i) * Math.PI / 180;
    const displayX = f.x + f.w / 2 + 1.7 * Math.cos(angle);
    const displayY = f.y + f.h / 2 + 1.7 * Math.sin(angle);
    return { tableId: f.id, color, x: Math.floor(displayX), y: Math.floor(displayY), displayX, displayY };
  })
  : f.gameType === "dominoes" ? [
    {tableId:f.id,color:'red',x:f.x-1,y:f.y},
    {tableId:f.id,color:'blue',x:f.x+f.w,y:f.y},
    {tableId:f.id,color:'green',x:f.x-1,y:f.y+1},
    {tableId:f.id,color:'yellow',x:f.x+f.w,y:f.y+1},
  ] : [
  { tableId: f.id, color: "red", x: f.x - 1, y: f.y },
  { tableId: f.id, color: "blue", x: f.x + f.w, y: f.y },
  { tableId: f.id, color: "green", x: f.x - 1, y: f.y + 1 },
  { tableId: f.id, color: "yellow", x: f.x + f.w, y: f.y + 1 },
  { tableId: f.id, color: "purple", x: f.x, y: f.y - 1 },
]);

/** A real, sittable seat belonging to a dining table or stool — NOT a
 * game table's own chairs (those are a rendering of that room's existing
 * 0-3 seat index, never a new occupancy concept here; PLAN.md's
 * product-direction-update entry). Each seat's (x, y) is an ordinary,
 * occupiable tile next to its furniture. A chair is not walking floor:
 * an explicit sit action moves the patron from adjacent floor onto it.
 * Computed from FURNITURE rather than hand-typed
 * coordinates so a layout change can't silently drift the two apart. */
export interface Seat {
  id: string;
  furnitureId: string;
  x: number;
  y: number;
}

export const BAR_SEATS: readonly Seat[] = FURNITURE.flatMap((f): Seat[] => {
  if (f.kind === "stool") {
    // The stool itself is walkable and is the seat, not a floor tile
    // beside the visible stool.
    return [{ id: `${f.id}-seat`, furnitureId: f.id, x: f.x, y: f.y }];
  }
  if (f.kind === "dining_table") {
    // Two seats north, two south: the walkable tiles flanking each of
    // the table's 2 columns, one row clear of its own footprint.
    const seats: Seat[] = [];
    for (let dx = 0; dx < f.w; dx++) {
      seats.push({ id: `${f.id}-n${dx}`, furnitureId: f.id, x: f.x + dx, y: f.y - 1 });
      seats.push({ id: `${f.id}-s${dx}`, furnitureId: f.id, x: f.x + dx, y: f.y + f.h });
    }
    return seats;
  }
  return [];
});

function furnitureAt(x: number, y: number): Furniture | undefined {
  return FURNITURE.find((f) => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h);
}

export function inBounds(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < GRID_COLS && y >= 0 && y < GRID_ROWS;
}

export function isWalkable(x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const f = furnitureAt(x, y);
  // No furniture at all, or furniture that's explicitly a walkable zone
  // marker (blocksMovement: false) rather than an obstacle — every
  // existing kind leaves this unset, so f.blocksMovement !== false stays
  // "blocks" for every fixture that already relies on that behavior.
  return f === undefined || f.blocksMovement === false;
}

/** Chairs support seated occupants, but are never ordinary walking floor. */
export function isWalkingFloor(x: number, y: number): boolean {
  return isWalkable(x, y) && ![...BAR_SEATS, ...GAME_CHAIRS].some((s) => s.x === x && s.y === y);
}

/** A move is valid if the destination is walkable and at most one tile
 * away in each axis (8-directional single step) — no teleporting, no
 * pathfinding needed since the client only ever asks for one step. */
export function isValidStep(fromX: number, fromY: number, toX: number, toY: number): boolean {
  if (!isWalkingFloor(toX, toY)) return false;
  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);
  if (dx && dy && (!isWalkingFloor(fromX, toY) || !isWalkingFloor(toX, fromY))) return false;
  return dx <= 1 && dy <= 1 && (dx !== 0 || dy !== 0);
}

/** Which interactive furniture (if any) sits at this tile — used both to
 * decide "clicking here acts, rather than just walks" and to report a
 * table's identity to the click handler. */
export function interactiveAt(x: number, y: number): Furniture | undefined {
  const f = furnitureAt(x, y);
  return f?.kind === "game_table" || f?.kind === "counter" ? f : undefined;
}

/** Spawn on the floor below the game rows, derived from their layout. */
export function defaultSpawn(): { x: number; y: number } {
  const bottom = Math.max(...GAME_TABLES.map((f) => f.y + f.h));
  return { x: Math.floor(GRID_COLS / 2), y: Math.min(GRID_ROWS - 1, bottom + 1) };
}
