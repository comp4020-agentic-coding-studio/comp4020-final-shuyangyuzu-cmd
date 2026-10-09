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
export const GRID_ROWS = 24;
export const TILE_SIZE = 32;

export type FurnitureKind = "counter" | "stool" | "dining_table" | "game_table" | "restroom";
export type GameType = "vegas" | "texas" | "dominoes" | "blackjack";

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
  /** Only set for kind === "game_table" — false for the reserved
   * Texas/dominoes/blackjack slots, true for the 3 Vegas tables. */
  available?: boolean;
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
  { id: "stool-1", kind: "stool", x: 3, y: 2, w: 1, h: 1, label: "Stool" },
  { id: "stool-2", kind: "stool", x: 6, y: 2, w: 1, h: 1, label: "Stool" },
  { id: "stool-3", kind: "stool", x: 9, y: 2, w: 1, h: 1, label: "Stool" },
  { id: "stool-4", kind: "stool", x: 12, y: 2, w: 1, h: 1, label: "Stool" },
  { id: "stool-5", kind: "stool", x: 15, y: 2, w: 1, h: 1, label: "Stool" },
  { id: "dining-a", kind: "dining_table", x: 1, y: 4, w: 2, h: 2, label: "Table" },
  { id: "dining-b", kind: "dining_table", x: 8, y: 4, w: 2, h: 2, label: "Table" },
  { id: "dining-c", kind: "dining_table", x: 15, y: 4, w: 2, h: 2, label: "Table" },
  {
    id: "vegas-1",
    kind: "game_table",
    x: 1,
    y: 7,
    w: 2,
    h: 2,
    label: "Vegas #1",
    gameType: "vegas",
    available: true,
  },
  {
    id: "vegas-2",
    kind: "game_table",
    x: 4,
    y: 7,
    w: 2,
    h: 2,
    label: "Vegas #2",
    gameType: "vegas",
    available: true,
  },
  {
    id: "vegas-3",
    kind: "game_table",
    x: 7,
    y: 7,
    w: 2,
    h: 2,
    label: "Vegas #3",
    gameType: "vegas",
    available: true,
  },
  {
    id: "texas-1",
    kind: "game_table",
    x: 10,
    y: 7,
    w: 2,
    h: 2,
    label: "Texas Hold'em — not yet open",
    gameType: "texas",
    available: false,
  },
  {
    id: "dominoes-1",
    kind: "game_table",
    x: 13,
    y: 7,
    w: 2,
    h: 2,
    label: "Dominoes — not yet open",
    gameType: "dominoes",
    available: false,
  },
  {
    id: "blackjack-1",
    kind: "game_table",
    x: 16,
    y: 7,
    w: 2,
    h: 2,
    label: "Blackjack — not yet open",
    gameType: "blackjack",
    available: false,
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
export const FURNITURE: readonly Furniture[] = CORE_FURNITURE.map((f) => ({
  ...f, x: f.x + 10, y: f.y + 6,
}));

export const GAME_TABLES: readonly Furniture[] = FURNITURE.filter((f) => f.kind === "game_table");

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

/** A move is valid if the destination is walkable and at most one tile
 * away in each axis (8-directional single step) — no teleporting, no
 * pathfinding needed since the client only ever asks for one step. */
export function isValidStep(fromX: number, fromY: number, toX: number, toY: number): boolean {
  if (!isWalkable(toX, toY)) return false;
  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);
  return dx <= 1 && dy <= 1 && (dx !== 0 || dy !== 0);
}

/** Which interactive furniture (if any) sits at this tile — used both to
 * decide "clicking here acts, rather than just walks" and to report a
 * table's identity to the click handler. */
export function interactiveAt(x: number, y: number): Furniture | undefined {
  const f = furnitureAt(x, y);
  return f?.kind === "game_table" || f?.kind === "counter" ? f : undefined;
}

/** An open floor tile for a newly-joined patron to spawn on — row 9 is
 * kept clear of furniture specifically so this is always available. */
export function defaultSpawn(): { x: number; y: number } {
  return { x: Math.floor(GRID_COLS / 2), y: GRID_ROWS - 6 };
}
